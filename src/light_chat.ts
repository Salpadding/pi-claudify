import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { dirname, join, relative, resolve, extname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import express, { type NextFunction, type Request, type Response } from "express";
import { LIGHT_CHAT_BUILD_DIR, sendJson } from "./common.js";
import type { PiClaudifyContext } from "./pi_claudify_context.js";

type ChatRole = "user" | "assistant";

type ChatMessage = {
    id: string;
    type: "message";
    role: ChatRole;
    content: string;
    thinking?: string;
};

type ToolExecutionItem = {
    id: string;
    type: "tool";
    toolCallId: string;
    toolName: string;
    args: unknown;
    status: "pending" | "streaming" | "complete" | "error";
    output?: string;
    result?: unknown;
    isError?: boolean;
};

type TimelineItem = ChatMessage | ToolExecutionItem;

type SendPayload = {
    message?: unknown;
};

type FileListItem = {
    name: string;
    path: string;
    insertPath: string;
    isDirectory: boolean;
    size: number | null;
    mtime: number;
};

/**
 * Tiny Tau-like browser chat mirror.
 *
 * Scope is intentionally small: user/assistant text messages plus basic tool
 * execution cards. Thinking blocks are ignored. Browser rendering handles
 * markdown and KaTeX math delimiters ($...$, \(...\), \[...\], $$...$$).
 */
export class LightChat {
    private server: Server | null = null;
    private readonly clients = new Set<ServerResponse>();
    private heartbeat?: NodeJS.Timeout;
    private latestContext?: ExtensionContext;
    private currentAssistantText = "";
    private currentAssistantThinking = "";
    private assistantStreaming = false;
    private url = "";
    private readonly MIME_TYPES: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".ico": "image/x-icon",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
    };

    private readonly ignoredFileNames = new Set([
        "node_modules", ".git", "__pycache__", ".DS_Store", ".Trash",
        ".next", ".nuxt", "dist", "build", ".cache", ".turbo",
        "venv", ".venv", "env", "coverage", ".nyc_output", ".parcel-cache",
    ]);

    constructor(
        private readonly pi: ExtensionAPI,
        private readonly claudifyContext: PiClaudifyContext,
    ) {
        this.registerCommands();
        this.registerEvents();
    }

    get status(): { running: boolean; url: string | null; clients: number } {
        return {
            running: !!this.server,
            url: this.url || null,
            clients: this.clients.size,
        };
    }

    private registerCommands(): void {
        this.pi.registerCommand("mirror", {
            description: "Open the lightweight chat mirror in your browser via misc server",
            handler: async (_args, ctx) => {
                await this.ensureStarted(ctx);
                await this.openViaMiscServer(ctx);
            },
        });
    }

    private registerEvents(): void {
        this.pi.on("session_start", async (_event, ctx) => {
            this.latestContext = ctx;
            if (this.isDisabled()) return;
            try {
                await this.ensureStarted(ctx);
                this.broadcast("snapshot", this.buildSnapshot(ctx));
            } catch (err) {
                console.error("[pi-claudify] failed to start light chat:", err);
                ctx.ui.notify(`pi-claudify chat failed to start: ${err instanceof Error ? err.message : String(err)}`, "warning");
            }
        });

        this.pi.on("session_shutdown", async () => {
            await this.stop();
            this.latestContext = undefined;
        });

        this.pi.on("message_start", async (event, ctx) => {
            this.latestContext = ctx;
            const message = event.message as any;
            if (!message) return;

            if (message.role === "user") {
                const content = this.messageText(message.content);
                if (content.trim()) this.broadcast("message", { role: "user", content });
                return;
            }

            if (message.role === "assistant") {
                const extracted = this.extractAssistantContent(message.content);
                this.currentAssistantText = extracted.text;
                this.currentAssistantThinking = extracted.thinking;
                this.assistantStreaming = true;
                this.broadcast("assistant_start", { content: this.currentAssistantText, thinking: this.currentAssistantThinking });
            }
        });

        this.pi.on("message_update", async (event, ctx) => {
            this.latestContext = ctx;
            const assistantEvent = (event as any).assistantMessageEvent;
            if (assistantEvent?.type === "text_delta") {
                this.currentAssistantText += assistantEvent.delta ?? "";
                this.broadcast("assistant_delta", { delta: assistantEvent.delta ?? "", content: this.currentAssistantText });
            } else if (assistantEvent?.type === "thinking_delta") {
                this.currentAssistantThinking += assistantEvent.delta ?? "";
                this.broadcast("assistant_thinking_delta", { delta: assistantEvent.delta ?? "", thinking: this.currentAssistantThinking });
            }
        });

        this.pi.on("message_end", async (event, ctx) => {
            this.latestContext = ctx;
            const message = event.message as any;
            if (message?.role !== "assistant") return;
            const extracted = this.extractAssistantContent(message.content);
            const finalContent = extracted.text || this.currentAssistantText;
            const finalThinking = extracted.thinking || this.currentAssistantThinking;
            this.assistantStreaming = false;
            this.currentAssistantText = "";
            this.currentAssistantThinking = "";
            this.broadcast("assistant_end", { content: finalContent, thinking: finalThinking });
        });

        this.pi.on("tool_execution_start", async (event, ctx) => {
            this.latestContext = ctx;
            this.broadcast("tool_execution_start", {
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                args: event.args,
            });
        });

        this.pi.on("tool_execution_update", async (event, ctx) => {
            this.latestContext = ctx;
            this.broadcast("tool_execution_update", {
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                args: event.args,
                partialResult: event.partialResult,
            });
        });

        this.pi.on("tool_execution_end", async (event, ctx) => {
            this.latestContext = ctx;
            this.broadcast("tool_execution_end", {
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                result: event.result,
                isError: event.isError,
            });
        });
    }

    private async ensureStarted(ctx: ExtensionContext): Promise<void> {
        this.latestContext = ctx;
        if (this.server) return;

        const host = process.env.PI_CLAUDIFY_CHAT_HOST || "0.0.0.0";
        // Default to port 0 so the OS randomly assigns an available ephemeral port.
        // PI_CLAUDIFY_CHAT_PORT can still pin a port for debugging if needed.
        // If no port is pinned, remember the last ephemeral port in process.env so
        // session replacement flows like /new can close and rebind the same URL.
        const startPort = this.getStartPort();
        const server = createServer(this.createApp());
        this.server = server;

        let port: number;
        try {
            port = await this.listenWithFallback(server, host, Number.isFinite(startPort) ? startPort : 0, 20);
        } catch (err) {
            this.server = null;
            try { server.close(); } catch { /* ignore */ }
            throw err;
        }
        process.env.PI_CLAUDIFY_CHAT_LAST_PORT = String(port);
        const displayHost = this.getDisplayHost(host);
        this.url = `http://${displayHost}:${port}/chat`;

        this.heartbeat = setInterval(() => this.broadcast("ping", { t: Date.now() }), 20_000);
        ctx.ui.setStatus("claudify-chat", `Chat: ${displayHost}:${port}`);
        ctx.ui.notify(`pi-claudify chat: ${this.url}`, "info");
    }

    private async openViaMiscServer(ctx: ExtensionContext): Promise<void> {
        const baseUrl = process.env.NVIM_MISC_CTL_BASE_URL?.replace(/\/+$/, "");
        const listenOn = process.env.KITTY_LISTEN_ON;
        if (!baseUrl || !listenOn) {
            ctx.ui.notify("Missing NVIM_MISC_CTL_BASE_URL or KITTY_LISTEN_ON; cannot open browser via misc server", "warning");
            return;
        }

        const endpoint = `${baseUrl}/api/kitty/exec`;
        const payload = [
            "kitty", "@", "--to", listenOn,
            "launch", "--type=background", "open", this.url,
        ];

        try {
            const response = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            if (!response.ok) {
                const text = await response.text().catch(() => "");
                throw new Error(`${response.status} ${response.statusText}${text ? `: ${text}` : ""}`);
            }
            ctx.ui.notify(`Opened mirror in browser: ${this.url}`, "info");
        } catch (err) {
            ctx.ui.notify(`Failed to open browser via misc server: ${err instanceof Error ? err.message : String(err)}`, "warning");
        }
    }

    private createApp(): express.Express {
        const app = express();

        app.use(express.json({ limit: "1mb" }));

        app.get(["/", "/chat"], (_req: Request, res: Response) => {
            this.sendBuiltFile(res, "index.html", "text/html; charset=utf-8");
        });

        app.get("/chat/events", (req: Request, res: Response) => {
            this.handleEvents(req, res);
        });


        // Vite build assets. Keep /assets for compatibility with previously
        // built index.html files that used Vite's default absolute base.
        app.get(["/chat/assets/*path", "/assets/*path"], (req: Request, res: Response) => {
            const pathParam = req.params["path"];
            const subPath = Array.isArray(pathParam) ? pathParam.join("/") : pathParam;
            if (typeof subPath !== "string" || subPath.includes("..")) {
                sendJson(res, 400, { error: "Invalid path" });
                return;
            }
            const ct = this.MIME_TYPES[extname(subPath)] || "application/octet-stream";
            this.sendBuiltFile(res, join("assets", subPath), ct);
        });

        app.get("/favicon.ico", (_req: Request, res: Response) => {
            res.writeHead(204);
            res.end();
        });

        app.post("/chat/send", (req: Request, res: Response) => {
            void this.handleSend(req.body as SendPayload | undefined, res);
        });

        app.get("/chat/status", (_req: Request, res: Response) => {
            sendJson(res, 200, { ...this.status, idle: this.latestContext?.isIdle() ?? null });
        });

        app.get("/chat/files", (req: Request, res: Response) => {
            this.handleFiles(req, res);
        });

        app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
            const message = err instanceof Error ? err.message : String(err);
            sendJson(res, 400, { ok: false, error: message || "Bad request" });
        });

        app.use((_req: Request, res: Response) => {
            sendJson(res, 404, { error: "Not Found" });
        });

        return app;
    }

    private listenWithFallback(server: Server, host: string, startPort: number, attempts: number): Promise<number> {
        return new Promise((resolve, reject) => {
            const tryPort = (port: number, remaining: number) => {
                const onError = (err: NodeJS.ErrnoException) => {
                    server.off("listening", onListening);
                    if (port !== 0 && err.code === "EADDRINUSE" && remaining > 0) {
                        tryPort(port + 1, remaining - 1);
                    } else {
                        reject(err);
                    }
                };
                const onListening = () => {
                    server.off("error", onError);
                    const address = server.address();
                    resolve(typeof address === "object" && address ? address.port : port);
                };
                server.once("error", onError);
                server.once("listening", onListening);
                server.listen(port, host);
            };
            tryPort(startPort, attempts);
        });
    }

    private async stop(): Promise<void> {
        if (this.heartbeat) {
            clearInterval(this.heartbeat);
            this.heartbeat = undefined;
        }

        for (const client of this.clients) {
            try { client.end(); } catch { /* ignore */ }
        }
        this.clients.clear();

        const server = this.server;
        this.server = null;
        this.url = "";
        this.assistantStreaming = false;
        this.currentAssistantText = "";
        this.currentAssistantThinking = "";

        const ctx = this.claudifyContext.maybeCurrentContext;
        ctx?.ui.setStatus("claudify-chat", undefined);

        if (!server) return;
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    private handleEvents(req: Request, res: ServerResponse): void {
        res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        });
        res.write(": connected\n\n");
        this.clients.add(res);

        if (this.latestContext) {
            this.sendEvent(res, "snapshot", this.buildSnapshot(this.latestContext));
        }

        req.on("close", () => {
            this.clients.delete(res);
        });
    }

    private async handleSend(body: SendPayload | undefined, res: ServerResponse): Promise<void> {
        const ctx = this.latestContext;
        if (!ctx) {
            sendJson(res, 503, { ok: false, error: "No active session" });
            return;
        }

        const message = typeof body?.message === "string" ? body.message : "";
        if (!message.trim()) {
            sendJson(res, 400, { ok: false, error: "message is required" });
            return;
        }

        if (!ctx.isIdle()) {
            this.pi.sendUserMessage(message, { deliverAs: "followUp" });
            sendJson(res, 202, { ok: true, queued: true });
            return;
        }

        this.pi.sendUserMessage(message);
        sendJson(res, 200, { ok: true });
    }

    private handleFiles(req: Request, res: ServerResponse): void {
        const explicitPath = typeof req.query.path === "string" ? req.query.path : undefined;
        const dirPath = explicitPath || this.getSessionCwd();

        try {
            if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
                sendJson(res, 400, { error: "Not a directory" });
                return;
            }

            const cwd = this.getSessionCwd();
            const items: FileListItem[] = [];
            for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
                if (entry.name.startsWith(".") && entry.name !== ".env") continue;
                if (this.ignoredFileNames.has(entry.name)) continue;

                try {
                    const fullPath = join(dirPath, entry.name);
                    const stat = statSync(fullPath);
                    const isDirectory = entry.isDirectory();
                    items.push({
                        name: entry.name,
                        path: fullPath,
                        insertPath: isDirectory ? fullPath : this.getInsertPath(fullPath, cwd),
                        isDirectory,
                        size: isDirectory ? null : stat.size,
                        mtime: stat.mtimeMs,
                    });
                } catch { /* skip inaccessible entries */ }
            }

            items.sort((a, b) => {
                if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
                return a.name.localeCompare(b.name);
            });

            sendJson(res, 200, {
                path: dirPath,
                parent: dirname(dirPath),
                cwd,
                items,
            });
        } catch (err) {
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    }

    private getSessionCwd(): string {
        const header = this.latestContext?.sessionManager.getHeader() as any;
        return typeof header?.cwd === "string" && header.cwd ? header.cwd : process.cwd();
    }

    private getInsertPath(filePath: string, cwd: string): string {
        const rel = relative(cwd, filePath);
        return rel && !rel.startsWith("..") && !rel.startsWith("/") ? rel : filePath;
    }

    private buildSnapshot(ctx: ExtensionContext): { items: TimelineItem[]; streaming: boolean; streamingContent: string; streamingThinking: string } {
        const entries = ctx.sessionManager.getBranch();
        const items: TimelineItem[] = [];
        const tools = new Map<string, ToolExecutionItem>();
        let counter = 0;

        const pushMessage = (role: ChatRole, content: string, thinking = "") => {
            if (!content.trim() && !thinking.trim()) return;
            items.push({ id: `snap-${++counter}`, type: "message", role, content, thinking: thinking || undefined });
        };

        for (const entry of entries as any[]) {
            if (entry?.type !== "message") continue;
            const message = entry.message;
            if (!message) continue;

            if (message.role === "user") {
                pushMessage("user", this.messageText(message.content));
                continue;
            }

            if (message.role === "assistant") {
                if (!Array.isArray(message.content)) {
                    const extracted = this.extractAssistantContent(message.content);
                    pushMessage("assistant", extracted.text, extracted.thinking);
                    continue;
                }

                let textBuffer = "";
                let thinkingBuffer = "";
                const flushText = () => {
                    if (!textBuffer.trim() && !thinkingBuffer.trim()) return;
                    pushMessage("assistant", textBuffer, thinkingBuffer);
                    textBuffer = "";
                    thinkingBuffer = "";
                };

                for (const block of message.content as any[]) {
                    if (block?.type === "text") {
                        textBuffer += `${block.text ?? ""}\n`;
                    } else if (block?.type === "thinking") {
                        thinkingBuffer += `${block.thinking ?? block.text ?? ""}\n`;
                    } else if (block?.type === "toolCall") {
                        flushText();
                        const toolCallId = String(block.id || block.toolCallId || `tool-${++counter}`);
                        const tool: ToolExecutionItem = {
                            id: `tool-${toolCallId}`,
                            type: "tool",
                            toolCallId,
                            toolName: String(block.name || block.toolName || "tool"),
                            args: block.arguments ?? block.args ?? {},
                            status: message.stopReason === "aborted" || message.stopReason === "error" ? "error" : "pending",
                            output: message.stopReason === "aborted" ? "Operation aborted" : message.errorMessage,
                            isError: message.stopReason === "aborted" || message.stopReason === "error",
                        };
                        items.push(tool);
                        tools.set(toolCallId, tool);
                    }
                }
                flushText();
                continue;
            }

            if (message.role === "toolResult") {
                const toolCallId = String(message.toolCallId || "");
                if (!toolCallId) continue;
                let tool = tools.get(toolCallId);
                if (!tool) {
                    tool = {
                        id: `tool-${toolCallId}`,
                        type: "tool",
                        toolCallId,
                        toolName: String(message.toolName || "tool"),
                        args: message.input ?? {},
                        status: "complete",
                    };
                    items.push(tool);
                    tools.set(toolCallId, tool);
                }
                tool.status = message.isError ? "error" : "complete";
                tool.result = message;
                tool.output = this.formatToolOutput(message);
                tool.isError = !!message.isError;
            }
        }

        return {
            items,
            streaming: this.assistantStreaming,
            streamingContent: this.currentAssistantText,
            streamingThinking: this.currentAssistantThinking,
        };
    }

    private formatToolOutput(result: any): string {
        if (!result) return "";
        if (Array.isArray(result.content)) {
            return result.content
                .map((block: any) => block?.type === "text" ? block.text ?? "" : JSON.stringify(block))
                .join("\n");
        }
        try {
            return JSON.stringify(result, null, 2);
        } catch {
            return String(result);
        }
    }

    private extractAssistantContent(content: unknown): { text: string; thinking: string } {
        if (!Array.isArray(content)) return { text: this.messageText(content), thinking: "" };
        let text = "";
        let thinking = "";
        for (const block of content as any[]) {
            if (block?.type === "text") text += `${block.text ?? ""}\n`;
            if (block?.type === "thinking") thinking += `${block.thinking ?? block.text ?? ""}\n`;
        }
        return { text, thinking };
    }

    private messageText(content: unknown): string {
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
            return content
                .filter((block: any) => block?.type === "text")
                .map((block: any) => block.text ?? "")
                .join("\n");
        }
        return "";
    }

    private broadcast(event: string, data: unknown): void {
        for (const client of this.clients) this.sendEvent(client, event, data);
    }

    private sendEvent(res: ServerResponse, event: string, data: unknown): void {
        try {
            res.write(`event: ${event}\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch {
            this.clients.delete(res);
        }
    }


    private sendBuiltFile(res: ServerResponse, subPath: string, contentType: string): void {
        const fullPath = resolve(LIGHT_CHAT_BUILD_DIR, subPath);
        try {
            const content = readFileSync(fullPath, "utf-8");
            res.writeHead(200, { "Content-Type": contentType, "Content-Length": Buffer.byteLength(content) });
            res.end(content);
        } catch {
            sendJson(res as Response, 404, { error: "Not Found" });
        }
    }

    private isDisabled(): boolean {
        const value = process.env.PI_CLAUDIFY_CHAT_DISABLED;
        return value === "1" || value === "true";
    }

    private getStartPort(): number {
        const configured = process.env.PI_CLAUDIFY_CHAT_PORT;
        const remembered = process.env.PI_CLAUDIFY_CHAT_LAST_PORT;
        const value = Number.parseInt(configured || remembered || "0", 10);
        return Number.isFinite(value) && value >= 0 ? value : 0;
    }

    private getDisplayHost(bindHost: string): string {
        if (bindHost === "0.0.0.0" || bindHost === "::") {
            return this.getSshServerIp() ?? this.getLanIp();
        }
        if (bindHost === "127.0.0.1" || bindHost === "::1") return "localhost";
        return bindHost;
    }

    private getSshServerIp(): string | undefined {
        const parts = process.env.SSH_CONNECTION?.trim().split(/\s+/);
        // SSH_CONNECTION format: <client-ip> <client-port> <server-ip> <server-port>
        return parts && parts.length >= 3 ? parts[2] : undefined;
    }

    private getLanIp(): string {
        const nets = networkInterfaces();
        for (const items of Object.values(nets)) {
            for (const net of items ?? []) {
                if (net.family === "IPv4" && !net.internal) return net.address;
            }
        }
        return "localhost";
    }

}
