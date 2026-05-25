import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import picomatch from "picomatch";
import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PiClaudifyContext } from "./pi_claudify_context.js";

interface ClaudeSettings {
    claudeMdExcludes?: string[];
}

interface ClaudeFile {
    path: string;
    content: string;
    type: "user" | "project" | "local";
}

function readFileSafe(filePath: string): string | null {
    try {
        if (existsSync(filePath)) {
            return readFileSync(filePath, "utf-8");
        }
    } catch {
        // ignore
    }
    return null;
}

export class SystemPromptPatcher {
    settings?: ClaudeSettings;
    cwd: string;
    claudeMdFiles: ClaudeFile[] = [];
    seen: Set<string> = new Set();
    systemPromptBackup = "";
    projectContextBackup = "";
    claudeProjectContext = "";

    constructor(readonly pi: ExtensionAPI, readonly claudifyContext: PiClaudifyContext) {
        pi.on("session_start", async (event, ctx) => {
            this.cwd = ctx.cwd
        })
        this.cwd ||= process.cwd()
        this.patch()
    }

    resetState() {
        this.claudeMdFiles = [];
        this.seen = new Set();
        this.projectContextBackup = "";
    }

    loadClaudeSettings() {
        // Claude Code reads claudeMdExcludes from global settings (settings.json),
        // but for pi-claudify we also support .claude/settings.local.json for convenience.
        const localPath = join(this.cwd, ".claude", "settings.local.json");
        this.settings = undefined;
        try {
            if (existsSync(localPath)) {
                this.settings = JSON.parse(readFileSync(localPath, "utf-8")) as ClaudeSettings;
            }
        } catch {
            // ignore
        }
        return null;
    }

    isExcluded(filePath: string): boolean {
        if (!this.settings?.claudeMdExcludes) return false;

        const normalizedPath = filePath.replaceAll("\\", "/");
        return picomatch.isMatch(normalizedPath, this.settings.claudeMdExcludes, { dot: true });
    }

    addFile(filePath: string, type: ClaudeFile["type"]) {
        const resolvedPath = resolve(filePath);
        if (this.seen.has(resolvedPath) || this.isExcluded(resolvedPath)) {
            return;
        }
        const content = readFileSafe(resolvedPath);
        if (!content || !content.trim()) {
            return;
        }
        this.seen.add(resolvedPath);
        this.claudeMdFiles.push({ path: resolvedPath, content, type });
    }

    collectClaudeMdFiles() {
        // 1. User memory: ~/.claude/CLAUDE.md
        this.addFile(join(homedir(), ".claude", "CLAUDE.md"), "user");

        const dirs: string[] = [];
        let currentDir = resolve(this.cwd);
        const root = resolve("/");

        while (true) {
            dirs.unshift(currentDir);
            if (currentDir === root) break;
            const parentDir = resolve(currentDir, "..");
            if (parentDir === currentDir) break;
            currentDir = parentDir;
        }

        // dirs [/, ..., parent, cwd]

        for (const dir of dirs) {
            // Claude Code loads BOTH CLAUDE.md and .claude/CLAUDE.md independently
            // (they have different paths so no dedup collision)
            this.addFile(join(dir, "CLAUDE.md"), "project");
            this.addFile(join(dir, ".claude", "CLAUDE.md"), "project");

            // CLAUDE.local.md (local, not checked in)
            this.addFile(join(dir, "CLAUDE.local.md"), "local");
        }
    }

    patch() {
        this.pi.on("before_agent_start", this.beforeAgentStart.bind(this));
    }

    escapeAttribute(value: string): string {
        return value
            .replaceAll("&", "&amp;")
            .replaceAll("\"", "&quot;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;");
    }

    renderProjectContext(files: Array<{ path: string; content: string }>): string {
        if (files.length === 0) {
            return "";
        }

        let context = "\n\n<project_context>\n\n";
        context += "Project-specific instructions and guidelines:\n\n";
        for (const file of files) {
            context += `<project_instructions path="${this.escapeAttribute(file.path)}">\n${file.content}\n</project_instructions>\n\n`;
        }
        context += "</project_context>\n";
        return context;
    }

    replaceProjectContext(systemPrompt: string, originalProjectContext: string, claudeProjectContext: string): string {
        if (originalProjectContext && systemPrompt.includes(originalProjectContext)) {
            return this.replaceOnce(systemPrompt, originalProjectContext, claudeProjectContext);
        }

        const projectContextPattern = /\n\n<project_context>\n\n[\s\S]*?<\/project_context>\n/;
        if (projectContextPattern.test(systemPrompt)) {
            return systemPrompt.replace(projectContextPattern, claudeProjectContext);
        }

        if (!claudeProjectContext) {
            return systemPrompt;
        }

        const dateMarker = "\nCurrent date:";
        const dateIndex = systemPrompt.lastIndexOf(dateMarker);
        if (dateIndex >= 0) {
            return systemPrompt.slice(0, dateIndex) + claudeProjectContext + systemPrompt.slice(dateIndex);
        }

        return systemPrompt + claudeProjectContext;
    }

    buildClaudeProjectContext() {
        this.claudeProjectContext = this.renderProjectContext(
            this.claudeMdFiles.map(({ path, content }) => ({ path, content })),
        );
        return this.claudeProjectContext
    }

    replaceOnce(text: string, search: string, replacement: string): string {
        if (!search) {
            return text;
        }

        const index = text.indexOf(search);
        if (index === -1) {
            return text;
        }

        return text.slice(0, index) + replacement + text.slice(index + search.length);
    }

    get status() {
        return {
            settings: this.settings,
            claudeMdFiles: this.claudeMdFiles.map(x => ({ path: x.path, type: x.type })),
            seen: this.seen,
            systemPromptBackup: this.systemPromptBackup,
            projectContextBackup: this.projectContextBackup,
            claudeProjectContext: this.claudeProjectContext,
            systemPrompt: this.claudifyContext.currentContext.getSystemPrompt()
        }
    }

    async beforeAgentStart(event: BeforeAgentStartEvent, ctx: ExtensionContext) {
        this.resetState();
        this.loadClaudeSettings();
        this.collectClaudeMdFiles();
        if (this.claudeMdFiles.length === 0 && !this.settings?.claudeMdExcludes?.length) {
            return;
        }

        // backup original system prompt
        this.systemPromptBackup = event.systemPrompt;
        this.projectContextBackup = this.renderProjectContext(event.systemPromptOptions.contextFiles ?? []);
        const systemPrompt = this.replaceProjectContext(
            event.systemPrompt,
            this.projectContextBackup,
            this.buildClaudeProjectContext(),
        );

        if (systemPrompt === event.systemPrompt && this.projectContextBackup !== this.claudeProjectContext) {
            ctx.ui.notify("update system prompt failed, pi api may updated")
        }

        return { systemPrompt };
    }
}

