import { resolve, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export { HttpServerOverUnix, type RouteHandler } from "./http_server_over_unix.js";

export const EXTENSION_NAME = "pi-claudify"

const RESOURCE_DIR = join(getAgentDir(), "extensions", EXTENSION_NAME, "resource")

export const NEOVIM_DIFF_LUA_PATH = resolve(RESOURCE_DIR, "neovim_diff.lua")
export const NEOVIM_LUA_EXEC_WRAPPER_PATH = resolve(RESOURCE_DIR, "neovim_lua_exec_wrapper.lua")
export const NEOVIM_VIMSCRIPT_EXEC_WRAPPER_PATH = resolve(RESOURCE_DIR, "neovim_vimscript_exec_wrapper.lua")
export const NVIM_CURRENT_TAB_FILE_BUFFERS_LUA_PATH = resolve(RESOURCE_DIR, "nvim_current_tab_file_buffers.lua")
export const NVIM_REFRESH_FILE_BUFFERS_LUA_PATH = resolve(RESOURCE_DIR, "nvim_refresh_file_buffers.lua")
export const SUDO_ASKPASS_SCRIPT_PATH = resolve(RESOURCE_DIR, "pi-sudo-askpass.mjs")
export const LIGHT_CHAT_BUILD_DIR = resolve(RESOURCE_DIR, "light_chat")


export function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const data = JSON.stringify(body);
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
    });
    res.end(data);
}

export function readJsonBody<T>(req: IncomingMessage): Promise<T> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf-8");
            if (!raw) {
                reject(new Error("Empty request body"));
                return;
            }
            try {
                resolve(JSON.parse(raw) as T);
            } catch {
                reject(new Error("Malformed JSON"));
            }
        });
        req.on("error", reject);
    });
}


