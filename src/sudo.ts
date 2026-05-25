import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { readJsonBody, sendJson, SUDO_ASKPASS_SCRIPT_PATH } from "./common.js";
import type { PiClaudifyContext } from "./pi_claudify_context.js";

type AskpassRequest = {
    prompt?: string;
};

/**
 * Makes sudo askpass available inside bash tool calls.
 *
 * sudo only calls SUDO_ASKPASS when invoked with -A/--askpass, so callers should
 * run `sudo -A ...` when they need pi UI password input.
 */
export class Sudo {
    private readonly dir = `/tmp/pi-claudify-sudo-${process.pid}`;
    private readonly askpassPath = join(this.dir, "pi-sudo-askpass.mjs");

    constructor(private readonly claudifyContext: PiClaudifyContext) {
        this.writeHelper();
        this.registerRoutes();
    }

    get spawnEnv(): Record<string, string> {
        return {
            PI_CLAUDIFY_SOCKET: this.claudifyContext.httpServer.socketPath,
            SUDO_ASKPASS: this.askpassPath,
        };
    }

    cleanup(): void {
        rmSync(this.dir, { recursive: true, force: true });
    }

    private registerRoutes(): void {
        this.claudifyContext.httpServer.register("POST", "/sudo/askpass", async (req, res) => {
            if (!this.claudifyContext.maybeCurrentContext) {
                sendJson(res, 503, { error: "No active session" });
                return;
            }

            const body = await readJsonBody<AskpassRequest>(req);
            const prompt = body.prompt?.trim() || "sudo password:";
            const password = await this.claudifyContext.currentContext.ui.input(
                "sudo password required",
                prompt,
                { timeout: 60_000 },
            );

            if (password === undefined || password === "") {
                sendJson(res, 400, { error: "cancelled" });
                return;
            }

            sendJson(res, 200, { password });
        });
    }

    private writeHelper(): void {
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        writeFileSync(this.askpassPath, this.readResource(SUDO_ASKPASS_SCRIPT_PATH), { mode: 0o700 });
        chmodSync(this.askpassPath, 0o700);
    }

    private readResource(path: string): string {
        return readFileSync(resolve(process.env.HOME ?? "", path), "utf-8");
    }
}
