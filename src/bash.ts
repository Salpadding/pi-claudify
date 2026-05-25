import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { PiClaudifyContext } from "./pi_claudify_context.js";

const bashSchemaWithStdin = Type.Object({
    command: Type.String({ description: "Bash command to execute" }),
    timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
    stdin: Type.Optional(Type.String({ 
        description: "Data to pipe to the command's stdin. " + 
            "Prefer this when passing complex arguments to ssh or docker exec to avoid bash escaping issues" 
    })),
    env: Type.Optional(Type.Record(
        Type.String(),
        Type.String({ description: "Environment variable value" }),
        { description: "Environment variables to set for this command invocation" },
    )),
});

export function registerBashTool(pi: ExtensionAPI, claudifyContext: PiClaudifyContext): void {
    // Per-call env variable, safe because Node.js is single-threaded and
    // pi executes tool calls sequentially within an agent loop.
    let callEnv: Record<string, string> | undefined;

    const bashTool = createBashTool(process.cwd(), {
        spawnHook: ({ command, cwd, env }) => ({
            command,
            cwd,
            env: {
                ...env,
                PI_CLAUDIFY_PID: String(process.pid),
                ...claudifyContext.sudo.spawnEnv,
                ...callEnv,
            },
        }),
    });

    pi.registerTool({
        ...bashTool,
        parameters: bashSchemaWithStdin,
        execute: async (toolCallId, params, signal, onUpdate) => {
            const { stdin, env, ...bashParams } = params;
            if (stdin) {
                const encoded = Buffer.from(stdin).toString("base64");
                bashParams.command = `echo '${encoded}' | base64 -d | ${bashParams.command}`;
            }
            callEnv = env;
            try {
                return await bashTool.execute(toolCallId, bashParams, signal, onUpdate);
            } finally {
                callEnv = undefined;
            }
        },
    });
}
