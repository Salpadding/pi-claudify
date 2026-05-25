import { execFile } from "node:child_process";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiClaudifyContext } from "./pi_claudify_context.js";

export interface NeovimEndpoint {
    socket: string;
    cwd?: string;
    pid?: number;
    servername?: string;
    connectable: boolean;
    error?: string;
}

export interface IdeStatus {
    connected: boolean;
    socket?: string;
    cwd?: string;
    pid?: number;
    lastError?: string;
}

const DEFAULT_RUNTIME_DIR = "/run/user/1000";
const IDE_STATUS_KEY = "pi-claudify-ide";
const NEOVIM_REQUEST_TIMEOUT_MS = 1000;

function ideDebug(message: string, data?: unknown): void {
    if (process.env.PI_CLAUDIFY_IDE_DEBUG !== "1") return;
    if (data === undefined) {
        console.error(`[pi-claudify] IDE ${message}`);
    } else {
        console.error(`[pi-claudify] IDE ${message}`, data);
    }
}

async function normalizePath(path: string): Promise<string> {
    try {
        return await realpath(path);
    } catch {
        return path;
    }
}

function isNeovimSocketPath(path: string): boolean {
    return path.toLowerCase().includes("nvim");
}

async function findNeovimSockets(root = process.env.XDG_RUNTIME_DIR || DEFAULT_RUNTIME_DIR): Promise<string[]> {
    const sockets: string[] = [];

    async function walk(dir: string, depth: number): Promise<void> {
        if (depth > 4) return;

        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }

        await Promise.all(entries.map(async (entry) => {
            const path = join(dir, entry.name);
            if (!isNeovimSocketPath(path)) return;

            if (entry.isDirectory()) {
                await walk(path, depth + 1);
                return;
            }

            try {
                const s = await stat(path);
                if (s.isSocket()) sockets.push(path);
            } catch {
                // Ignore races/stale entries.
            }
        }));
    }

    await walk(root, 0);
    return sockets.sort();
}

function execFileAsync(file: string, args: string[], timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(file, args, { timeout }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr.trim() || error.message));
                return;
            }
            resolve(stdout.trim());
        });
    });
}

async function requestNeovimInfo(socket: string): Promise<NeovimEndpoint> {
    ideDebug("requestNeovimInfo start", { socket });
    try {
        // Avoid the neovim npm client's socket transport here. A stale/refused Unix
        // socket can surface as an async uncaught exception inside that library and
        // crash pi before our catch block runs. The nvim CLI reports it as a normal
        // process error that we can safely capture.
        const output = await execFileAsync("nvim", [
            "--server",
            socket,
            "--remote-expr",
            "json_encode({'cwd': getcwd(), 'pid': getpid(), 'servername': v:servername})",
        ], NEOVIM_REQUEST_TIMEOUT_MS);
        const info = JSON.parse(output) as { cwd?: string; pid?: number; servername?: string };

        ideDebug("requestNeovimInfo success", { socket, info });
        return {
            socket,
            cwd: info.cwd,
            pid: info.pid,
            servername: info.servername,
            connectable: true,
        };
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        ideDebug("requestNeovimInfo failed", { socket, error });
        return {
            socket,
            connectable: false,
            error,
        };
    }
}

export class Ide {
    private _connected?: NeovimEndpoint;
    private _lastError?: string;

    constructor(readonly pi: ExtensionAPI, readonly claudifyContext: PiClaudifyContext) {
        this.register(pi);
    }

    get status(): IdeStatus {
        return {
            connected: !!this._connected,
            socket: this._connected?.socket,
            cwd: this._connected?.cwd,
            pid: this._connected?.pid,
            lastError: this._lastError,
        };
    }

    get nvimSocket(): string | undefined {
        return this._connected?.socket ?? process.env.NVIM;
    }

    private register(pi: ExtensionAPI): void {
        pi.on("session_start", async (_event, ctx) => {
            if (process.env.PI_CLAUDIFY_IDE_AUTOCONNECT === "0") return;

            try {
                await this.autoConnect(ctx);
            } catch (error) {
                this._lastError = error instanceof Error ? error.message : String(error);
                console.error("[pi-claudify] IDE autoConnect failed", error);
            }
        });

        pi.on("session_shutdown", async () => {
            const ctx = this.claudifyContext.maybeCurrentContext;
            if (ctx) ctx.ui.setStatus(IDE_STATUS_KEY, undefined);
            this._connected = undefined;
        });

        pi.registerCommand("ide", {
            description: "Connect pi-claudify to a Neovim instance",
            handler: async (_args, ctx) => {
                await this.selectIde(ctx);
            },
        });
    }

    async discover(): Promise<NeovimEndpoint[]> {
        const sockets = await findNeovimSockets();
        ideDebug("discover sockets", sockets);

        const endpoints: NeovimEndpoint[] = [];
        for (const socket of sockets) {
            endpoints.push(await requestNeovimInfo(socket));
        }
        return endpoints;
    }

    async autoConnect(ctx: ExtensionContext): Promise<void> {
        ideDebug("autoConnect start", { cwd: ctx.cwd, nvim: process.env.NVIM });

        if (this._connected) {
            ideDebug("autoConnect checking existing connection", { socket: this._connected.socket });
            const current = await requestNeovimInfo(this._connected.socket);
            if (current.connectable) {
                this._connected = current;
                this._lastError = undefined;
                this.updateStatus(ctx);
                ideDebug("autoConnect existing connection is still valid", { socket: current.socket });
                return;
            }

            ideDebug("autoConnect existing connection unavailable", { socket: current.socket, error: current.error });
            this._connected = undefined;
            this._lastError = current.error ?? "Current Neovim connection is unavailable";
        }

        ideDebug("autoConnect discovering endpoints");
        const endpoints = await this.discover();
        ideDebug("autoConnect discovered endpoints", endpoints.map(endpoint => ({
            socket: endpoint.socket,
            cwd: endpoint.cwd,
            pid: endpoint.pid,
            connectable: endpoint.connectable,
            error: endpoint.error,
        })));

        if (process.env.NVIM) {
            endpoints.sort((a, b) => {
                if (a.socket === process.env.NVIM) return -1;
                if (b.socket === process.env.NVIM) return 1;
                return 0;
            });
        }

        const targetCwd = await normalizePath(ctx.cwd ?? process.cwd());
        ideDebug("autoConnect target cwd", { targetCwd });
        let selected: NeovimEndpoint | undefined;
        for (const endpoint of endpoints) {
            if (!endpoint.connectable || !endpoint.cwd) continue;
            const endpointCwd = await normalizePath(endpoint.cwd);
            ideDebug("autoConnect comparing cwd", { socket: endpoint.socket, endpointCwd, targetCwd });
            if (endpointCwd === targetCwd) {
                selected = endpoint;
                break;
            }
        }

        if (selected) {
            ideDebug("autoConnect selected endpoint", { socket: selected.socket, cwd: selected.cwd, pid: selected.pid });
            await this.connect(selected, ctx, false);
            ideDebug("autoConnect connected", { socket: selected.socket });
        } else {
            this._lastError = endpoints.length === 0
                ? "No Neovim sockets found"
                : `No Neovim working directory matches ${targetCwd}`;
            ideDebug("autoConnect no matching endpoint", { lastError: this._lastError });
            this.updateStatus(ctx);
        }

        ideDebug("autoConnect end", this.status);
    }

    private async selectIde(ctx: ExtensionContext): Promise<void> {
        const endpoints = await this.discover();
        if (endpoints.length === 0) {
            ctx.ui.notify("No Neovim sockets found under /run/user/1000", "warning");
            return;
        }

        const choices = [
            ...endpoints.map((endpoint, index) => this.formatEndpointChoice(endpoint, index)),
            "Disconnect",
        ];
        const selected = await ctx.ui.select("Select Neovim IDE", choices);
        if (!selected) return;

        if (selected === "Disconnect") {
            this._connected = undefined;
            this._lastError = undefined;
            this.updateStatus(ctx);
            ctx.ui.notify("Neovim IDE disconnected", "info");
            return;
        }

        const index = choices.indexOf(selected);
        const endpoint = endpoints[index];
        if (!endpoint) return;
        if (!endpoint.connectable) {
            ctx.ui.notify(`Cannot connect to ${endpoint.socket}: ${endpoint.error ?? "unknown error"}`, "error");
            return;
        }

        await this.connect(endpoint, ctx, true);
    }

    private formatEndpointChoice(endpoint: NeovimEndpoint, index: number): string {
        const marker = endpoint.socket === this._connected?.socket ? "●" : "○";
        const state = endpoint.connectable ? (endpoint.cwd ?? "unknown cwd") : `unavailable: ${endpoint.error ?? "unknown error"}`;
        return `${marker} ${index + 1}. pid=${endpoint.pid ?? "?"} ${state} — ${endpoint.socket}`;
    }

    private async connect(endpoint: NeovimEndpoint, ctx: ExtensionContext, notify: boolean): Promise<void> {
        this._connected = endpoint;
        this._lastError = undefined;
        this.updateStatus(ctx);
        if (notify) ctx.ui.notify(`Connected to Neovim: ${endpoint.socket}`, "info");
    }

    private updateStatus(ctx: ExtensionContext): void {
        if (this._connected) {
            ctx.ui.setStatus(IDE_STATUS_KEY, `IDE: nvim ${basename(this._connected.socket)}`);
        } else {
            ctx.ui.setStatus(IDE_STATUS_KEY, "IDE: disconnected");
        }
    }
}
