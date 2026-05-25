import { readFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
    AutocompleteItem,
    AutocompleteProvider,
    AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import { NVIM_CURRENT_TAB_FILE_BUFFERS_LUA_PATH } from "./common.js";
import { execLuaRpc } from "./neovim.js";
import type { PiClaudifyContext } from "./pi_claudify_context.js";

const REQUEST_TIMEOUT_MS = 800;
const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);
const CURRENT_TAB_FILE_BUFFERS_LUA = NVIM_CURRENT_TAB_FILE_BUFFERS_LUA_PATH;

let currentTabFileBuffersLuaPromise: Promise<string> | undefined;

type NvimActiveBuffers = {
    paths?: string[];
};

async function getCurrentTabFileBuffersLua(): Promise<string> {
    currentTabFileBuffersLuaPromise ||= readFile(CURRENT_TAB_FILE_BUFFERS_LUA, "utf-8");
    return currentTabFileBuffersLuaPromise;
}

async function getCurrentTabWindowBufferPaths(socket: string, signal: AbortSignal): Promise<string[]> {
    const lua = await getCurrentTabFileBuffersLua();
    const parsed = await execLuaRpc(socket, lua, [], REQUEST_TIMEOUT_MS, signal) as NvimActiveBuffers;
    return Array.isArray(parsed.paths) ? parsed.paths.filter((path): path is string => typeof path === "string" && path.length > 0) : [];
}

function toDisplayPath(value: string): string {
    return value.replace(/\\/g, "/");
}

function pathForCompletion(absolutePath: string, cwd: string): string {
    const relativePath = toDisplayPath(relative(cwd, absolutePath));
    if (!relativePath.startsWith("../") && relativePath !== ".." && relativePath !== "") {
        return relativePath;
    }
    return toDisplayPath(absolutePath);
}

function buildAtCompletionValue(path: string, prefix: string): string {
    const isQuotedPrefix = prefix.startsWith('@"');
    const needsQuotes = isQuotedPrefix || /\s|"/.test(path);
    if (!needsQuotes) return `@${path}`;
    return `@"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function stripAtCompletionValue(value: string): string {
    if (value.startsWith('@"') && value.endsWith('"')) {
        return value.slice(2, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    return value.startsWith("@") ? value.slice(1) : value;
}

function findLastDelimiter(text: string): number {
    for (let i = text.length - 1; i >= 0; i -= 1) {
        if (PATH_DELIMITERS.has(text[i] ?? "")) return i;
    }
    return -1;
}

function findUnclosedQuoteStart(text: string): number | undefined {
    let inQuotes = false;
    let quoteStart = -1;
    for (let i = 0; i < text.length; i += 1) {
        if (text[i] === '"') {
            inQuotes = !inQuotes;
            if (inQuotes) quoteStart = i;
        }
    }
    return inQuotes ? quoteStart : undefined;
}

function isTokenStart(text: string, index: number): boolean {
    return index === 0 || PATH_DELIMITERS.has(text[index - 1] ?? "");
}

function extractAtPrefix(textBeforeCursor: string): string | undefined {
    const quoteStart = findUnclosedQuoteStart(textBeforeCursor);
    if (quoteStart !== undefined && quoteStart > 0 && textBeforeCursor[quoteStart - 1] === "@" && isTokenStart(textBeforeCursor, quoteStart - 1)) {
        return textBeforeCursor.slice(quoteStart - 1);
    }

    const lastDelimiterIndex = findLastDelimiter(textBeforeCursor);
    const tokenStart = lastDelimiterIndex === -1 ? 0 : lastDelimiterIndex + 1;
    if (textBeforeCursor[tokenStart] === "@") return textBeforeCursor.slice(tokenStart);
    return undefined;
}

function isAtFileCompletion(suggestions: AutocompleteSuggestions | null): suggestions is AutocompleteSuggestions {
    return !!suggestions && suggestions.prefix.startsWith("@");
}

function prependActiveBuffers(
    suggestions: AutocompleteSuggestions,
    absolutePaths: string[],
    cwd: string,
): AutocompleteSuggestions {
    const activeItems: AutocompleteItem[] = [];
    const activeValues = new Set<string>();

    for (const absolutePath of absolutePaths) {
        const displayPath = pathForCompletion(absolutePath, cwd);
        const value = buildAtCompletionValue(displayPath, suggestions.prefix);
        const normalizedValue = stripAtCompletionValue(value);
        if (activeValues.has(normalizedValue)) continue;
        activeValues.add(normalizedValue);
        activeItems.push({
            value,
            label: basename(displayPath),
            description: `Neovim current tab window buffer — ${displayPath}`,
        });
    }

    if (activeItems.length === 0) return suggestions;

    const filteredItems = suggestions.items.filter((item) => !activeValues.has(stripAtCompletionValue(item.value)));
    return {
        ...suggestions,
        items: [...activeItems, ...filteredItems],
    };
}

function createNvimActiveBufferProvider(
    current: AutocompleteProvider,
    claudifyContext: PiClaudifyContext,
    cwd: string,
): AutocompleteProvider {
    return {
        async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
            const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
            const currentLine = lines[cursorLine] ?? "";
            const atPrefix = isAtFileCompletion(suggestions)
                ? suggestions.prefix
                : extractAtPrefix(currentLine.slice(0, cursorCol));
            if (!atPrefix || options.signal.aborted) {
                return suggestions;
            }

            const socket = claudifyContext.ide.nvimSocket;
            if (!socket) return suggestions;

            try {
                const activeBufferPaths = await getCurrentTabWindowBufferPaths(socket, options.signal);
                if (activeBufferPaths.length === 0 || options.signal.aborted) return suggestions;
                return prependActiveBuffers(suggestions ?? { items: [], prefix: atPrefix }, activeBufferPaths, cwd);
            } catch {
                return suggestions;
            }
        },

        applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
            return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
        },

        shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
            return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
        },
    };
}

export function registerNvimActiveBufferAutocomplete(pi: ExtensionAPI, claudifyContext: PiClaudifyContext): void {
    pi.on("session_start", async (_event, ctx) => {
        if (!ctx.hasUI) return;
        ctx.ui.addAutocompleteProvider((current) => createNvimActiveBufferProvider(current, claudifyContext, ctx.cwd));
    });
}
