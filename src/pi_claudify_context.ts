import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SystemPromptPatcher } from "./claude.md.js";
import { HttpServerOverUnix, sendJson } from "./common.js";
import { EditApproval, type EditMode } from "./edit_approval.js";
import { Ide } from "./ide.js";
import { Sudo } from "./sudo.js";
import { LightChat } from "./light_chat.js";

export class PiClaudifyContext {
    private _systemPromptPatcher?: SystemPromptPatcher
    private _httpServer?: HttpServerOverUnix
    private _currentContext?: ExtensionContext
    private _editApproval?: EditApproval
    private _ide?: Ide
    private _sudo?: Sudo
    private _lightChat?: LightChat
    private serverStarted = false
    private _pi: ExtensionAPI

    get systemPromptPatcher(): SystemPromptPatcher {
        return this._systemPromptPatcher!
    }

    get currentContext(): ExtensionContext {
        return this._currentContext!
    }

    get maybeCurrentContext(): ExtensionContext | undefined {
        return this._currentContext
    }

    get httpServer(): HttpServerOverUnix {
        return this._httpServer!
    }

    get pi(): ExtensionAPI {
        return this._pi!
    }

    get ide(): Ide {
        return this._ide!
    }

    get sudo(): Sudo {
        return this._sudo!
    }

    get lightChat(): LightChat {
        return this._lightChat!
    }

    get editApproval(): EditApproval {
        return this._editApproval!
    }

    constructor(pi: ExtensionAPI) {
        this._pi = pi
        this._httpServer = new HttpServerOverUnix();
        this._editApproval = new EditApproval(pi, this);
        this._lightChat = new LightChat(pi, this);
        this._systemPromptPatcher = new SystemPromptPatcher(pi, this)
        this._sudo = new Sudo(this)
        this.register(pi)
        this._ide = new Ide(pi, this)
    }

    register(pi: ExtensionAPI) {
        // GET /status — query agent state
        this.httpServer.register("GET", "/status", (_req, res) => {
            if (!this._currentContext) {
                sendJson(res, 503, { error: "No active session" });
                return;
            }
            const header = this.currentContext.sessionManager.getHeader();
            const model = this.currentContext.model;
            sendJson(res, 200, {
                pid: process.pid,
                sessionId: header?.id,
                sessionFile: this.currentContext.sessionManager.getSessionFile(),
                cwd: header?.cwd,
                isIdle: this.currentContext.isIdle(),
                model: model ? { provider: model.provider, modelId: model.id } : null,
                contextUsage: this.currentContext.getContextUsage(),
                socketPath: this.httpServer.socketPath,
                systemPromptPatcher: this.systemPromptPatcher.status,
                ide: this.ide.status,
                lightChat: this.lightChat.status,
                editMode: this.editApproval.editMode
            });
        });

        pi.registerCommand("edit-mode", {
            description: "Choose edit/write approval mode: ask or allow",
            handler: async (args, ctx) => {
                const requested = args.trim().toLowerCase();
                let mode: EditMode | undefined;

                if (requested === "ask" || requested === "allow") {
                    mode = requested;
                } else if (requested.length > 0) {
                    ctx.ui.notify("Usage: /edit-mode [ask|allow]", "warning");
                    return;
                } else if (ctx.hasUI) {
                    const selected = await ctx.ui.select("Edit mode", ["ask", "allow"]);
                    if (selected === "ask" || selected === "allow") {
                        mode = selected;
                    }
                } else {
                    ctx.ui.notify(`Current edit mode: ${this.editApproval.editMode}`);
                    return;
                }

                if (!mode) return;
                this.editApproval.setEditMode(mode);
                ctx.ui.notify(`Edit mode set to ${mode}`);
            },
        });

        // Lifecycle: start on first session, update context on subsequent ones
        pi.on("session_start", async (_event, ctx) => {
            this._currentContext = ctx
            if (!this.serverStarted) {
                await this.httpServer.start();
                this.serverStarted = true;
            }
            ctx.ui.notify(`pi-claudify unix socket path: ${this.httpServer.socketPath}`)
        });

        pi.on("session_shutdown", async () => {
            await this.httpServer.stop();
            this.serverStarted = false;
            delete this._currentContext;
        });
    }
}
