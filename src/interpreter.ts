import { execFile, execFileSync } from "node:child_process";
import { highlightCode, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "@sinclair/typebox";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_CHARS = 200_000;

const interpreterSchema = Type.Object({
    code: Type.String({ description: "Source code to execute." }),
    args: Type.Optional(Type.Array(Type.String(), { description: "Optional command-line arguments exposed to the executed code." })),
    cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the current workspace directory." })),
    timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds. Defaults to 30000; maximum 300000." })),
});

type InterpreterParams = Static<typeof interpreterSchema>;

type InterpreterDetails = {
    language: "python" | "ruby" | "node" | "rails";
    command: string;
    args: string[];
    cwd: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    timedOut?: boolean;
    error?: string;
};

type InterpreterSpec = {
    language: InterpreterDetails["language"];
    name: string;
    label: string;
    command: string;
    codeArgs: (code: string) => string[];
    description: string;
    promptSnippet: string;
};

function clampTimeout(timeout: number | undefined): number {
    if (timeout === undefined) return DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeout) || timeout <= 0) return DEFAULT_TIMEOUT_MS;
    return Math.min(Math.floor(timeout), MAX_TIMEOUT_MS);
}

function truncate(text: string): string {
    if (text.length <= MAX_OUTPUT_CHARS) return text;
    return `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[truncated to ${MAX_OUTPUT_CHARS} characters]`;
}

function executeInterpreter(
    spec: InterpreterSpec,
    params: InterpreterParams,
    signal?: AbortSignal,
): Promise<InterpreterDetails> {
    const cwd = params.cwd || process.cwd();
    const extraArgs = params.args ?? [];
    const args = [...spec.codeArgs(params.code), ...extraArgs];
    const timeout = clampTimeout(params.timeout);

    return new Promise((resolve) => {
        const child = execFile(spec.command, args, {
            cwd,
            encoding: "utf8",
            maxBuffer: 10 * 1024 * 1024,
            timeout,
            signal,
        }, (error, stdout, stderr) => {
            const err = error as (Error & { code?: number | string; signal?: NodeJS.Signals; killed?: boolean }) | null;
            resolve({
                language: spec.language,
                command: spec.command,
                args,
                cwd,
                exitCode: typeof err?.code === "number" ? err.code : err ? 1 : 0,
                signal: err?.signal ?? null,
                stdout: truncate(stdout ?? ""),
                stderr: truncate(stderr ?? ""),
                timedOut: err?.killed === true && err?.signal === "SIGTERM",
                error: err ? truncate(err.message) : undefined,
            });
        });
        signal?.addEventListener("abort", () => child.kill(), { once: true });
    });
}

function formatDetails(details: InterpreterDetails): string {
    const parts: string[] = [];
    if (details.stdout) parts.push(details.stdout.replace(/\s+$/u, ""));
    if (details.stderr) parts.push(`stderr:\n${details.stderr.replace(/\s+$/u, "")}`);
    if (details.exitCode !== 0 || details.signal || details.error) {
        const status = details.signal ? `signal ${details.signal}` : `exit code ${details.exitCode}`;
        parts.push(`${details.language} failed with ${status}${details.timedOut ? " (timeout)" : ""}${details.error ? `: ${details.error}` : ""}`);
    }
    return parts.length ? parts.join("\n\n") : `${details.language} executed successfully with no output.`;
}

function hasCommandInPath(command: string): boolean {
    try {
        execFileSync("which", [command], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

function highlightLanguageForInterpreter(language: InterpreterDetails["language"]): string {
    switch (language) {
        case "node": return "javascript";
        case "rails": return "ruby";
        default: return language;
    }
}

function registerInterpreterTool(pi: ExtensionAPI, spec: InterpreterSpec): void {
    pi.registerTool<typeof interpreterSchema, InterpreterDetails>({
        name: spec.name,
        label: spec.label,
        description: spec.description,
        promptSnippet: spec.promptSnippet,
        promptGuidelines: [
            `Use ${spec.name} when you need to run short ${spec.language} snippets directly without wrapping them in a shell command.`,
            "Pass command-line arguments with args when the snippet needs argv values.",
            "Use cwd to run in a specific working directory; it defaults to the current workspace.",
            "Use timeout for long-running snippets; maximum is 300000 ms.",
        ],
        parameters: interpreterSchema,
        executionMode: "sequential",

        async execute(_toolCallId, params, signal) {
            const details = await executeInterpreter(spec, params, signal);
            return { content: [{ type: "text", text: formatDetails(details) }], details };
        },

        renderCall(args, theme) {
            const code = typeof args.code === "string" ? args.code : "";
            const preview = code.length > 500 ? `${code.slice(0, 500)}…` : code;
            const title = theme.fg("toolTitle", theme.bold(spec.label));
            const highlightedPreview = highlightCode(preview, highlightLanguageForInterpreter(spec.language)).join("\n");
            return new Text(`${title}\n${highlightedPreview}`, 0, 0);
        },

        renderResult(result, _options, theme) {
            const details = result.details;
            if (!details) {
                const first = result.content[0];
                return new Text(first?.type === "text" ? first.text : "", 0, 0);
            }
            const text = formatDetails(details);
            return new Text(details.exitCode === 0 && !details.signal ? theme.fg("success", text) : theme.fg("error", text), 0, 0);
        },
    });
}

export function registerInterpreterTools(pi: ExtensionAPI): void {
    const specs: InterpreterSpec[] = [
        {
            language: "python",
            name: "python",
            label: "Python",
            command: "python",
            codeArgs: (code) => ["-c", code],
            description: "Execute Python code directly with the system Python interpreter.",
            promptSnippet: "Execute Python code directly",
        },
        {
            language: "ruby",
            name: "ruby",
            label: "Ruby",
            command: "ruby",
            codeArgs: (code) => ["-e", code],
            description: "Execute Ruby code directly with the system Ruby interpreter.",
            promptSnippet: "Execute Ruby code directly",
        },
        {
            language: "node",
            name: "node",
            label: "Node",
            command: "node",
            codeArgs: (code) => ["--input-type=module", "-e", code],
            description: "Execute JavaScript code directly with Node.js as an ES module.",
            promptSnippet: "Execute Node.js code directly",
        },
        {
            language: "rails",
            name: "rails",
            label: "Rails Runner",
            command: "rails",
            codeArgs: (code) => ["runner", code, "--"],
            description: "Execute Ruby code inside a Rails application via `rails runner`. Requires `rails` to be available in PATH and cwd to point at a Rails app.",
            promptSnippet: "Execute Rails code via rails runner",
        },
    ];

    for (const spec of specs) {
        if (spec.name === "rails" && !hasCommandInPath("rails")) continue;
        registerInterpreterTool(pi, spec);
    }
}
