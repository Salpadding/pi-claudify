import type { ExtensionAPI, ReadToolDetails } from "@earendil-works/pi-coding-agent";
import {
    createReadTool,
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { Type, type Static } from "@sinclair/typebox";

type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image"; data: string; mimeType: string };

const PDF_MAX_PAGES_PER_READ = 20;
const PDF_INLINE_PAGE_THRESHOLD = 20;

const readSchema = Type.Object({
    path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
    offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed). Ignored for PDF files; use pages instead." })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read. Ignored for PDF files; use pages instead." })),
    pages: Type.Optional(Type.String({ description: 'Page range for PDF files, e.g. "1-5", "3", or "10-20". Maximum 20 pages per request.' })),
});

type ReadParams = Static<typeof readSchema>;
type ExecResult = { stdout: string; stderr: string };

function execFileText(command: string, args: string[], signal?: AbortSignal, timeout = 120_000): Promise<ExecResult> {
    return new Promise((resolvePromise, reject) => {
        const child = execFile(command, args, {
            encoding: "utf8",
            maxBuffer: 10 * 1024 * 1024,
            timeout,
            signal,
        }, (error, stdout, stderr) => {
            if (error) {
                const message = stderr?.trim() || (error instanceof Error ? error.message : String(error));
                reject(new Error(message));
                return;
            }
            resolvePromise({ stdout: stdout ?? "", stderr: stderr ?? "" });
        });
        signal?.addEventListener("abort", () => child.kill(), { once: true });
    });
}

function parsePdfPageRange(pages: string | undefined): { firstPage?: number; lastPage?: number; count?: number } {
    if (!pages) return {};
    const trimmed = pages.trim();
    if (!trimmed) throw new Error("Invalid pages parameter: empty page range.");

    const single = /^(\d+)$/.exec(trimmed);
    if (single) {
        const page = Number(single[1]);
        if (page < 1) throw new Error(`Invalid pages parameter: ${pages}`);
        return { firstPage: page, lastPage: page, count: 1 };
    }

    const range = /^(\d+)-(\d+)$/.exec(trimmed);
    if (range) {
        const firstPage = Number(range[1]);
        const lastPage = Number(range[2]);
        if (firstPage < 1 || lastPage < firstPage) throw new Error(`Invalid pages parameter: ${pages}`);
        const count = lastPage - firstPage + 1;
        if (count > PDF_MAX_PAGES_PER_READ) {
            throw new Error(`Page range "${pages}" exceeds maximum of ${PDF_MAX_PAGES_PER_READ} pages per request.`);
        }
        return { firstPage, lastPage, count };
    }

    throw new Error(`Invalid pages parameter: "${pages}". Use formats like "1-5", "3", or "10-20".`);
}

async function getPdfPageCount(filePath: string, signal?: AbortSignal): Promise<number | undefined> {
    try {
        const { stdout } = await execFileText("pdfinfo", [filePath], signal, 10_000);
        const match = /^Pages:\s+(\d+)/m.exec(stdout);
        return match ? Number(match[1]) : undefined;
    } catch {
        return undefined;
    }
}

async function renderPdfPagesAsImages(
    toolCallId: string,
    filePath: string,
    range: { firstPage?: number; lastPage?: number },
    signal: AbortSignal | undefined,
    onUpdate: Parameters<ReturnType<typeof createReadTool>["execute"]>[3],
    cwd: string,
): Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails }> {
    const outputDir = await mkdtemp(join(tmpdir(), "pi-claudify-pdf-"));
    try {
        const prefix = join(outputDir, "page");
        const args = ["-jpeg", "-r", "100"];
        if (range.firstPage !== undefined) args.push("-f", String(range.firstPage));
        if (range.lastPage !== undefined) args.push("-l", String(range.lastPage));
        args.push(filePath, prefix);
        await execFileText("pdftoppm", args, signal);

        const files = (await readdir(outputDir)).filter((f) => f.endsWith(".jpg")).sort();
        if (files.length === 0) throw new Error("pdftoppm produced no page images. The PDF may be invalid or password protected.");

        const builtinRead = createReadTool(cwd);
        const content: (TextContent | ImageContent)[] = [{
            type: "text",
            text: `Read PDF file [application/pdf] as page images: ${filePath}\nPages rendered: ${files.length}`,
        }];
        for (const file of files) {
            const imagePath = join(outputDir, file);
            const imageResult = await builtinRead.execute(toolCallId, { path: imagePath }, signal, onUpdate);
            content.push({ type: "text", text: `PDF page image: ${basename(file)}` });
            content.push(...imageResult.content);
        }
        return { content, details: {} };
    } finally {
        await rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
    }
}

async function readPdf(
    toolCallId: string,
    params: ReadParams,
    absolutePath: string,
    signal: AbortSignal | undefined,
    onUpdate: Parameters<ReturnType<typeof createReadTool>["execute"]>[3],
    cwd: string,
): Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails }> {
    const range = parsePdfPageRange(params.pages);
    const totalPages = await getPdfPageCount(absolutePath, signal);
    const requestedCount = range.count ?? totalPages;
    if (!params.pages && totalPages !== undefined && totalPages > PDF_INLINE_PAGE_THRESHOLD) {
        throw new Error(`This PDF has ${totalPages} pages, which is too many to read at once. Use the pages parameter to read a specific range, e.g. pages: "1-5". Maximum ${PDF_MAX_PAGES_PER_READ} pages per request.`);
    }
    if (params.pages && requestedCount !== undefined && requestedCount > PDF_MAX_PAGES_PER_READ) {
        throw new Error(`Page range exceeds maximum of ${PDF_MAX_PAGES_PER_READ} pages per request.`);
    }

    if (!params.pages && totalPages === undefined) {
        throw new Error(`Could not determine PDF page count. Use the pages parameter to read a specific range, e.g. pages: "1-5". Maximum ${PDF_MAX_PAGES_PER_READ} pages per request.`);
    }

    return renderPdfPagesAsImages(toolCallId, absolutePath, range, signal, onUpdate, cwd);
}

export function registerPdfReadTool(pi: ExtensionAPI): void {
    pi.registerTool<typeof readSchema, ReadToolDetails>({
        name: "read",
        label: "read",
        description: `Read the contents of a file. Supports text files, PDF files, and images (jpg, png, gif, webp). PDF files are rendered and returned as page images so mixed text/image layouts are preserved. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large text files. Use pages for PDF files, e.g. "1-5"; maximum ${PDF_MAX_PAGES_PER_READ} pages per request.`,
        promptSnippet: "Read file contents, including PDF files",
        promptGuidelines: [
            "Use read to examine files instead of cat or sed.",
            `PDF files are returned as page images. Use pages for targeted page ranges (for example pages: "1-5"); maximum ${PDF_MAX_PAGES_PER_READ} pages per request.`,
        ],
        parameters: readSchema,
        async execute(toolCallId, params, signal, onUpdate, toolCtx) {
            const absolutePath = resolve(toolCtx.cwd, params.path);
            if (extname(absolutePath).toLowerCase() === ".pdf") {
                return readPdf(toolCallId, params, absolutePath, signal, onUpdate, toolCtx.cwd);
            }

            const builtinRead = createReadTool(toolCtx.cwd);
            return builtinRead.execute(toolCallId, params, signal, onUpdate);
        },
    });
}
