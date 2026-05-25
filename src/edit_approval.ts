import { writeFile, mkdir, readFile, rm } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { createTwoFilesPatch } from "diff";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { attach } from "neovim";
import {
    createEditToolDefinition,
    createWriteToolDefinition,
    type ExtensionAPI
} from "@earendil-works/pi-coding-agent";

export type EditToolExecuteResult = Awaited<
    ReturnType<ReturnType<typeof createEditToolDefinition>["execute"]>
>;

export type WriteToolExecuteResult = Awaited<
    ReturnType<ReturnType<typeof createWriteToolDefinition>["execute"]>
>;

import { sendJson, readJsonBody, EXTENSION_NAME, NEOVIM_DIFF_LUA_PATH, NVIM_REFRESH_FILE_BUFFERS_LUA_PATH } from "./common.js";
import type { PiClaudifyContext } from "./pi_claudify_context.js";

export type EditApprovalResult =
    | { decision: "allow" }
    | { decision: "deny"; reason: string };

type NativeDiffApprovalResult = {
    approved: boolean;
    reason?: string;
    finalContent?: string;
};

function firstChangedLineFromDiff(diff: string): number | undefined {
    const match = diff.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/m);
    return match ? Number(match[1]) : undefined;
}

function buildUnifiedDiff(path: string, oldContent: string, newContent: string): string {
    return createTwoFilesPatch(path, path, oldContent, newContent, "", "");
}

export type EditMode = "ask" | "allow";

export class EditApproval {
    private sessionAllowed = new Set<string>();
    private mode: EditMode = "ask";
    private _pendingNativeDiff = new Map<string, (result: { decision: "accept" | "reject"; reason?: string }) => void>();

    private _editApprovalQueue = Promise.resolve();

    private async withEditApprovalQueue<T>(fn: () => Promise<T>): Promise<T> {
        const prev = this._editApprovalQueue;
        let releaseNext!: () => void;
        const gate = new Promise<void>((r) => { releaseNext = r; });
        this._editApprovalQueue = prev.then(() => gate);

        await prev;
        try {
            return await fn();
        } finally {
            releaseNext();
        }
    }

    register(pi: ExtensionAPI) {
        pi.on("session_start", async (_event, _ctx) => {
            this.clear()
        })

        this.claudifyContext.httpServer.register("POST", "/edit-approval/neovim-diff/result", async (req, resp) => {
            const body = await readJsonBody<{ nonce: string, decision: "accept" | "reject"; reason?: string }>(req)
            const resolve = this._pendingNativeDiff.get(body.nonce)
            if (resolve) {
                this._pendingNativeDiff.delete(body.nonce)
                resolve({ decision: body.decision, reason: body.reason })
            }
            sendJson(resp, 200, { ok: true })
        })

        this.registerEditWriteToolsForNeovim(pi)
    }

    constructor(readonly pi: ExtensionAPI, readonly claudifyContext: PiClaudifyContext) {
        this.register(this.pi)
    }

    get editMode(): EditMode {
        return this.mode;
    }

    setEditMode(mode: EditMode): void {
        this.mode = mode;
    }

    isAllowed(key: string): boolean {
        return this.sessionAllowed.has(key);
    }

    clear(): void {
        this.sessionAllowed.clear();
        this.mode = "ask";
    }


    private async requestNeovimDiffEditApproval(
        absolutePath: string, newContent: string, timeoutMs?: number, useApprovalQueue = true):
        Promise<NativeDiffApprovalResult | undefined> {
        const nvimSocket = this.claudifyContext.ide.nvimSocket;
        if (!nvimSocket) return undefined;

        const run = async () => {
            const nonce = randomBytes(8).toString("hex");
            const tempDir = resolve(tmpdir(), `${EXTENSION_NAME}-neovim-diff-${nonce}`);
            const rightPath = resolve(tempDir, `preview-${basename(absolutePath) || "file"}`);
            const luaPath = NEOVIM_DIFF_LUA_PATH;
            const httpSocket = this.claudifyContext.httpServer.socketPath;

            let nvim;
            try {
                await mkdir(tempDir, { recursive: true });
                await writeFile(rightPath, newContent, "utf-8");

                const lua = await readFile(luaPath, "utf-8");
                nvim = attach({ socket: nvimSocket });
                const httpUrl = "http://localhost/edit-approval/neovim-diff/result";

                const decisionPromise = new Promise<{ decision: "accept" | "reject"; reason?: string }>((res) => {
                    this._pendingNativeDiff.set(nonce, res);
                });
                await mkdir(dirname(absolutePath), { recursive: true });                                                  
                await nvim.request("nvim_exec_lua", [
                    lua, [absolutePath, rightPath, httpSocket, nonce, httpUrl]
                ]);
                await nvim.close();

                const timeoutPromise = timeoutMs ? new Promise<never>((_, rej) =>
                    setTimeout(() => rej(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs)) : new Promise<never>((r) => { })

                const decision = await Promise.race([decisionPromise, timeoutPromise]);

                if (decision.decision === "accept") {
                    return { approved: true, finalContent: await readFile(rightPath, "utf-8") };
                }
                return { approved: false, reason: decision.reason?.trim() || "Denied by user" };
            } catch (err) {
                this._pendingNativeDiff.delete(nonce);
                try { await nvim?.close(); } catch { /* ignore */ }
                this.claudifyContext.currentContext.ui.notify("[pi-claudify] requestNeovimDiffEditApproval failed: " + err);
                return undefined;
            } finally {
                await rm(tempDir, { recursive: true, force: true });
            }
        };

        return useApprovalQueue ? this.withEditApprovalQueue(run) : run();
    }

    private async refreshNeovimFileBuffers(absolutePath: string): Promise<void> {
        const nvimSocket = this.claudifyContext.ide.nvimSocket;
        if (!nvimSocket) return;

        let nvim;
        try {
            const luaPath = NVIM_REFRESH_FILE_BUFFERS_LUA_PATH;
            const lua = await readFile(luaPath, "utf-8");
            nvim = attach({ socket: nvimSocket });
            await nvim.request("nvim_exec_lua", [lua, [absolutePath]]);
        } catch (err) {
            this.claudifyContext.currentContext.ui.notify("[pi-claudify] refreshNeovimFileBuffers failed: " + err);
        } finally {
            try { await nvim?.close(); } catch { /* ignore */ }
        }
    }

    /**
     * Run pi's native edit/write implementation against a temporary file first,
     * then show the resulting content in Neovim for approval before touching the
     * real target file.
     *
     * Native write tool execute() behavior in pi-mono:
     * - Resolves input.path against ctx.cwd.
     * - Creates the parent directory recursively.
     * - Writes input.content to that resolved path immediately with utf-8 encoding.
     * - On success resolves exactly:
     *     {
     *       content: [{
     *         type: "text",
     *         text: `Successfully wrote ${content.length} bytes to ${path}`,
     *       }],
     *       details: undefined,
     *     }
     *   where content.length is the JS string length of input.content, and path is
     *   the original tool argument path, not the absolute path.
     * - write has no success metadata to return: details is always exactly
     *   undefined in the native implementation. There is no diff, changed-line
     *   number, byte count field, or resolved path field in details; the only
     *   success information returned to the LLM is the single text item above.
     * - On abort or filesystem failure it rejects/throws; it does not return a
     *   structured error result from execute().
     *
     * Native edit tool execute() behavior in pi-mono:
     * - Normalizes legacy { oldText, newText } arguments into edits[].
     * - Validates edits is a non-empty array.
     * - Resolves input.path against ctx.cwd.
     * - Checks the resolved file is readable and writable; failures reject with
     *   `Could not edit file: ${path}. ...`.
     * - Reads the file as Buffer, converts to utf-8, strips a leading BOM for
     *   matching, detects the original line-ending style, and normalizes matching
     *   content to LF.
     * - Applies every edits[].oldText against the original normalized content, not
     *   incrementally. Each oldText must match exactly once and replacements must
     *   not overlap; applyEditsToNormalizedContent throws on violations.
     * - Restores the original BOM and line endings, then writes the final content
     *   to the resolved path immediately.
     * - On success resolves exactly:
     *     {
     *       content: [{
     *         type: "text",
     *         text: `Successfully replaced ${edits.length} block(s) in ${path}.`,
     *       }],
     *       details: {
     *         diff: diffResult.diff,
     *         firstChangedLine: diffResult.firstChangedLine,
     *       },
     *     }
     *   where diffResult is generated by generateDiffString(baseContent, newContent)
     *   after applying edits to LF-normalized content. details.diff is the unified
     *   diff shown by the UI, and details.firstChangedLine is the first changed line
     *   in the new file for editor navigation. On validation/access/matching/write
     *   failures it rejects/throws instead of returning a structured error result.
     *
     * Because both native tools mutate the path passed to execute(), this wrapper
     * passes them tempPath to preserve all native validation, mutation, result text,
     * and edit diff generation while keeping absolutePath unchanged before approval.
     * After approval we replace tempPath with the user's original path in returned
     * content/details so the result displayed to the model/user refers to the real
     * requested file.
     *
     * If the user edits the right-hand Neovim preview before accepting, we read that
     * final preview content and write it to absolutePath. In that case the native
     * edit diff no longer describes what was actually applied, so we replace
     * result.details.diff and result.details.firstChangedLine with a fresh diff from
     * the original real-file content to the final accepted content, and append a
     * text note containing that final diff.
     */
    private async executeWithNeovimDiff<R extends EditToolExecuteResult | WriteToolExecuteResult>(
        originalInput: any,
        absolutePath: string,
        applyToTemp: (tempPath: string) => Promise<R>
    ): Promise<R> {
        const nonce = randomBytes(8).toString("hex");
        const tempDir = resolve(tmpdir(), `pi-claudify-tool-${nonce}`);
        const tempPath = resolve(tempDir, basename(absolutePath) || "file");

        try {
            await mkdir(tempDir, { recursive: true });
            const result = await applyToTemp(tempPath);

            const newContent = await readFile(tempPath, "utf-8");
            const originalContentForDiff = await readFile(absolutePath, "utf-8").catch(() => "");

            const approval = await this.requestNeovimDiffEditApproval(absolutePath, newContent, undefined, false);
            let text = "Denied by user"
            if (approval?.reason) {
                text = `${text}: ${approval.reason}`
            }
            if (!approval?.approved) {
                return {
                    content: [{ type: "text" as const, text: text }],
                    details: undefined,
                } as R;
            }

            const originalPath: string = originalInput?.path ?? "";
            const finalContent = approval.finalContent;
            if (finalContent !== undefined) {
                await writeFile(absolutePath, finalContent, "utf-8");
                await this.refreshNeovimFileBuffers(absolutePath);

                const displayPath = originalPath || absolutePath;
                const finalDiff = buildUnifiedDiff(displayPath, originalContentForDiff, finalContent);
                const finalFirstChangedLine = firstChangedLineFromDiff(finalDiff);
                const resultWithDetails = result as R & { details?: { diff?: string; firstChangedLine?: number } };

                // Native write returns details: undefined, but light_chat consumes
                // result.details.diff to render file changes. Fill it here for write
                // results, while preserving native edit details unless the user made
                // extra changes in the Neovim preview.
                if (!resultWithDetails.details || typeof resultWithDetails.details !== "object") {
                    resultWithDetails.details = { diff: finalDiff, firstChangedLine: finalFirstChangedLine };
                } else if (finalContent !== newContent || typeof resultWithDetails.details.diff !== "string") {
                    resultWithDetails.details.diff = finalDiff;
                    resultWithDetails.details.firstChangedLine = finalFirstChangedLine;
                }

                if (finalContent !== newContent) {
                    result.content.push({
                        type: "text",
                        text: `User modified the accepted content in Neovim. Final diff:\n${finalDiff}`,
                    });
                }
            }

            if (originalPath && result) {
                for (const item of result.content ?? []) {
                    if (item.type === "text" && typeof item.text === "string") {
                        item.text = item.text.replaceAll(tempPath, originalPath);
                    }
                }
                if (result.details && typeof result.details === "object" && "diff" in result.details) {
                    const d = result.details as { diff?: string };
                    if (typeof d.diff === "string") {
                        d.diff = d.diff.replaceAll(tempPath, originalPath);
                    }
                }
            }

            return result;
        } finally {
            await rm(tempDir, { recursive: true, force: true });
        }
    }

    private registerEditWriteToolsForNeovim(pi: ExtensionAPI) {
        // Override pi's built-in edit tool with an approval wrapper. The native
        // edit tool mutates the path it receives, so for non-/tmp files with a
        // connected Neovim we copy the original file to tempPath, execute the
        // native edit against that temp copy, preview/approve the produced content,
        // and only then write the approved content back to the original path.
        const _editTool = createEditToolDefinition(process.cwd());
        pi.registerTool({
            ..._editTool,
            execute: async (toolCallId, input, signal, onUpdate, ctx): Promise<EditToolExecuteResult> => {
                const editTool = createEditToolDefinition(ctx.cwd);
                const absolutePath = resolve(ctx.cwd, input.path);
                if (this.mode === "allow" || absolutePath.startsWith("/tmp") || !this.claudifyContext.ide.nvimSocket) {
                    return await editTool.execute(toolCallId, input, signal, onUpdate, ctx)
                }
                return this.executeWithNeovimDiff(
                    input,
                    absolutePath,
                    async (tempPath) => {
                        const originalContent = await readFile(absolutePath);
                        await writeFile(tempPath, originalContent);
                        const tempInput = { ...input, path: tempPath };
                        try {
                            return await editTool.execute(toolCallId, tempInput, signal, onUpdate, ctx);
                        } catch (error) {
                            if (error instanceof Error) {
                                throw new Error(error.message.replaceAll(tempPath, input.path));
                            }
                            throw error;
                        }
                    }
                );
            },
        });

        // Override pi's built-in write tool similarly. The native write tool creates
        // parent directories and overwrites immediately, so it is executed against a
        // temp path first; after Neovim approval we explicitly write the accepted
        // preview content to the real destination.
        const _writeTool = createWriteToolDefinition(process.cwd());
        pi.registerTool({
            ..._writeTool,
            execute: async (toolCallId, input, signal, onUpdate, ctx): Promise<WriteToolExecuteResult> => {
                const writeTool = createWriteToolDefinition(ctx.cwd);
                const absolutePath = resolve(ctx.cwd, input.path);
                if (this.mode === "allow" || absolutePath.startsWith("/tmp") || !this.claudifyContext.ide.nvimSocket) {
                    return await writeTool.execute(toolCallId, input, signal, onUpdate, ctx)
                }
                return this.executeWithNeovimDiff(
                    input,
                    absolutePath,
                    async (tempPath) => {
                        try {
                            return await writeTool.execute(toolCallId, { ...input, path: tempPath }, signal, onUpdate, ctx)
                        } catch (error) {
                            if (error instanceof Error) {
                                throw new Error(error.message.replaceAll(tempPath, input.path));
                            }
                            throw error;
                        }
                    }
                );
            },
        });
    }

}
