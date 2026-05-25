/**
 * Claudify Extension
 *
 * Aggregates all claudify modules.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { PiClaudifyContext } from "./pi_claudify_context.js";
import { registerBashTool } from "./bash.js";
import { registerPdfReadTool } from "./pdf_reader.js";
import { registerAskUserQuestionTool } from "./ask_user_question.js";
import { registerNeovimTool } from "./neovim.js";
import { registerInterpreterTools } from "./interpreter.js";
import { registerNvimActiveBufferAutocomplete } from "./nvim_active_buffer_autocomplete.js";

// ─── Extension entry point ────────────────────────────────────────────────

export default function claudifyExtension(pi: ExtensionAPI) {
    const ctx = new PiClaudifyContext(pi);

    // Enforce minimum bash timeout (120s)
    pi.on("tool_call", async (event, _ctx) => {
        if (isToolCallEventType("bash", event)) {
            const timeout = event.input.timeout;
            if (timeout === undefined || timeout < 120) {
                event.input.timeout = 120;
            }
        }
    });

    registerBashTool(pi, ctx);
    registerPdfReadTool(pi);
    registerAskUserQuestionTool(pi);
    registerNeovimTool(pi, ctx);
    registerInterpreterTools(pi);
    registerNvimActiveBufferAutocomplete(pi, ctx);

    return ctx;
}
