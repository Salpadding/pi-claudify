import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { EXTENSION_NAME, sendJson } from "./common.js";

export type RouteHandler = (
    req: IncomingMessage,
    res: ServerResponse,
) => void | Promise<void>;

/** HTTP server over unix socket at /run/user/{uid}/pi-claudify.{pid} */
export class HttpServerOverUnix {
    private server: Server | null = null;
    private routes = new Map<string, RouteHandler>();
    private _socketPath: string;
    private boundSignalHandler: (() => Promise<void>) | null = null;

    constructor(socketPath?: string) {
        this._socketPath =
            socketPath ?? `/run/user/${process.getuid!()}/${EXTENSION_NAME}.${process.pid}`;
    }

    get socketPath(): string {
        return this._socketPath;
    }

    register(method: string, path: string, handler: RouteHandler): void {
        const key = `${method.toUpperCase()} ${path}`;
        if (this.routes.has(key)) {
            throw new Error(`Route already registered: ${key}`);
        }
        this.routes.set(key, handler);
    }

    async start(): Promise<void> {
        if (this.server) throw new Error("Server already started");

        const dir = dirname(this._socketPath);
        mkdirSync(dir, { recursive: true });

        // Clean stale socket
        try {
            unlinkSync(this._socketPath);
        } catch {
            // not present, fine
        }

        this.server = createServer((req, res) => this.handleRequest(req, res));

        await new Promise<void>((resolve, reject) => {
            this.server!.on("error", reject);
            this.server!.listen(this._socketPath, () => {
                this.server!.removeListener("error", reject);
                resolve();
            });
        });

        this.installSignalHandlers();
    }

    async stop(): Promise<void> {
        if (!this.server) return;

        await new Promise<void>((resolve) => {
            this.server!.close(() => resolve());
        });

        try {
            unlinkSync(this._socketPath);
        } catch {
            // ignore
        }
        this.removeSignalHandlers();
        this.server = null;
    }

    private handleRequest(req: IncomingMessage, res: ServerResponse): void {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        const key = `${req.method ?? "GET"} ${pathname}`;
        const handler = this.routes.get(key);

        if (!handler) {
            sendJson(res, 404, { error: "Not Found", path: pathname });
            return;
        }

        (async () => {
            try {
                await handler(req, res);
            } catch (err) {
                console.error("[pi-claudify] handler error:", err);
                if (!res.headersSent) {
                    sendJson(res, 500, { error: "Internal Server Error" });
                }
            }
        })();
    }

    private installSignalHandlers(): void {
        this.boundSignalHandler = this.stop.bind(this)
        process.on("SIGINT", this.boundSignalHandler);
        process.on("SIGTERM", this.boundSignalHandler);
    }

    private removeSignalHandlers(): void {
        if (!this.boundSignalHandler) return;
        process.removeListener("SIGINT", this.boundSignalHandler);
        process.removeListener("SIGTERM", this.boundSignalHandler);
        this.boundSignalHandler = null;
    }
}
