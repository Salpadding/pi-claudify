import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { attach } from "neovim";
import { highlightCode, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "@sinclair/typebox";
import {
    NEOVIM_LUA_EXEC_WRAPPER_PATH,
    NEOVIM_VIMSCRIPT_EXEC_WRAPPER_PATH,
} from "./common.js";
import type { PiClaudifyContext } from "./pi_claudify_context.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 200_000;
const LUA_EXEC_WRAPPER_PATH = NEOVIM_LUA_EXEC_WRAPPER_PATH;
const VIMSCRIPT_EXEC_WRAPPER_PATH = NEOVIM_VIMSCRIPT_EXEC_WRAPPER_PATH;

let luaExecWrapperPromise: Promise<string> | undefined;
let vimscriptExecWrapperPromise: Promise<string> | undefined;

const neovimSchema = Type.Object({
    code: Type.String({ description: "Lua chunk or Vimscript/Ex commands to execute inside Neovim." }),
    language: Type.Optional(Type.Union([
        Type.Literal("lua"),
        Type.Literal("vimscript"),
    ], { description: "Language to execute. Defaults to lua." })),
    socket: Type.Optional(Type.String({ description: "Neovim server/socket path. Defaults to the connected IDE socket, then $NVIM." })),
    timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds. Defaults to 5000; maximum 60000." })),
});

type NeovimDetails = {
    socket: string;
    language: "lua" | "vimscript";
    ok: boolean;
    result?: unknown;
    output?: string;
    error?: string;
    stderr?: string;
};

type NvimResponse = {
    ok?: boolean;
    result?: unknown;
    output?: string;
    error?: string;
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

function getExecWrapper(language: "lua" | "vimscript"): Promise<string> {
    if (language === "lua") {
        luaExecWrapperPromise ||= readFile(LUA_EXEC_WRAPPER_PATH, "utf-8");
        return luaExecWrapperPromise;
    }
    vimscriptExecWrapperPromise ||= readFile(VIMSCRIPT_EXEC_WRAPPER_PATH, "utf-8");
    return vimscriptExecWrapperPromise;
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

export async function execLuaRpc(
    socket: string, lua: string, args: unknown[],
    timeout: number, signal?: AbortSignal
): Promise<unknown> {
    if (signal?.aborted) throw new Error("Aborted");

    const defers: (() => Promise<unknown>)[] = []

    const nvim = attach({ socket });
    defers.push(() => nvim.close())

    const nvimErrorPromise = new Promise<never>((_, reject) => {
        const handle = (err: unknown) => reject(toError(err))
        nvim.once("error", handle);
        defers.push(async () => nvim.off('error', handle))
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out after ${timeout}ms`)), timeout);
        defers.push(async () => clearTimeout(timer))
    });

    const abortPromise = new Promise<never>((_, reject) => {
        const handle = () => reject(new Error("Aborted"));
        signal?.addEventListener("abort", handle, { once: true });
        defers.push(async () => signal?.removeEventListener("abort", handle))
    });

    try {
        return await Promise.race([
            nvim.request("nvim_exec_lua", [lua, args]),
            nvimErrorPromise,
            timeoutPromise,
            abortPromise,
        ]);
    } finally {
        defers.reverse()
        for (let i = 0; i < defers.length; i++) {
            try { await defers[i]() } catch { /* ignore */ }
        }
    }
}

function formatResponse(details: NeovimDetails): string {
    if (!details.ok) {
        return `Neovim ${details.language} execution ` +
            `failed on ${details.socket}:\n${details.error ?? "unknown error"}`;
    }

    if (details.language === "vimscript") {
        const output = details.output?.trim();
        return output ? `Neovim vimscript output:\n${output}` :
            "Neovim vimscript executed successfully with no output.";
    }

    if (details.result === null || details.result === undefined) {
        return "Neovim lua executed successfully with no return value.";
    }
    return `Neovim lua result:\n${JSON.stringify(details.result, null, 2)}`;
}

export function registerNeovimTool(pi: ExtensionAPI, claudifyContext: PiClaudifyContext): void {
    pi.registerTool<typeof neovimSchema, NeovimDetails>({
        name: "neovim",
        label: "Neovim",
        description: "Execute Lua code or Vimscript/Ex commands inside a running Neovim instance via its server socket.",
        promptSnippet: "Execute lua or vimscript in Neovim",
        promptGuidelines: [
            "Use neovim when you need to inspect or modify live Neovim state, buffers, windows, LSP diagnostics, options, or plugin state.",
            "Default language is lua. Lua code is loaded and executed as a chunk inside Neovim and may return JSON-serializable values.",
            "Use language: \"vimscript\" for Ex commands or Vimscript. Command output is captured when possible.",
            "Prefer read/edit tools for normal file changes; use neovim only for live editor state.",
        ],
        parameters: neovimSchema,
        executionMode: "sequential",

        async execute(_toolCallId, params, signal) {
            const language = params.language ?? "lua";
            const socket = params.socket ?? claudifyContext.ide.nvimSocket;
            if (!socket) {
                const error = "No Neovim socket is connected. Run the /ide command, set $NVIM, or pass socket explicitly.";
                return {
                    content: [{ type: "text", text: `Error: ${error}` }],
                    details: { socket: "", language, ok: false, error },
                };
            }

            const timeout = clampTimeout(params.timeout);
            let parsed: NvimResponse;
            try {
                const wrapper = await getExecWrapper(language);
                parsed = await execLuaRpc(
                    socket,
                    wrapper,
                    [params.code],
                    timeout,
                    signal,
                ) as NvimResponse;
            } catch (error) {
                const err = error as Error;
                const message = err.message || String(error);
                const details: NeovimDetails = {
                    socket,
                    language,
                    ok: false,
                    error: truncate(message),
                };
                return { content: [{ type: "text", text: formatResponse(details) }], details };
            }

            const details: NeovimDetails = {
                socket,
                language,
                ok: parsed.ok === true,
                result: parsed.result,
                output: typeof parsed.result === "object" && parsed.result !== null && "output" in parsed.result
                    ? truncate(String((parsed.result as { output?: unknown }).output ?? ""))
                    : parsed.output !== undefined ? truncate(String(parsed.output)) : undefined,
                error: parsed.error ? truncate(String(parsed.error)) : undefined,
            };

            return { content: [{ type: "text", text: formatResponse(details) }], details };
        },

        renderCall(args, theme) {
            const language = typeof args.language === "string" ? args.language : "lua";
            const title = theme.fg("toolTitle", theme.bold("Neovim"));
            const code = typeof args.code === "string" ? args.code : "";
            const preview = code.length > 500 ? `${code.slice(0, 500)}…` : code;
            const highlightLanguage = language === "vimscript" ? "vim" : "lua";
            const highlightedPreview = highlightCode(preview, highlightLanguage).join("\n");
            return new Text(`${title} ${theme.fg("muted", language)}\n${highlightedPreview}`, 0, 0);
        },

        renderResult(result, _options, theme) {
            const details = result.details;
            if (!details) {
                const first = result.content[0];
                return new Text(first?.type === "text" ? first.text : "", 0, 0);
            }
            const text = formatResponse(details);
            return new Text(details.ok ? theme.fg("success", text) : theme.fg("error", text), 0, 0);
        },
    });
}
