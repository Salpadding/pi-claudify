import { formatToolOutput, type ToolExecution } from "./api";

export function formatJson(obj: unknown): string {
  try {
    if (!obj || (typeof obj === "object" && Object.keys(obj as Record<string, unknown>).length === 0)) return "";
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

export function getArgsPreview(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  for (const key of ["path", "command", "query", "url"]) {
    const val = record[key];
    if (typeof val === "string" && val) return val.slice(0, key === "command" ? 80 : 60);
  }
  for (const val of Object.values(record)) {
    if (typeof val === "string" && val) return val.slice(0, 60);
  }
  return "";
}

export function outputText(tool: ToolExecution): string {
  if (tool.output) return tool.output;
  return formatToolOutput(tool.result);
}

export function toolImages(tool: ToolExecution): { src: string; alt: string }[] {
  const content = (tool.result as any)?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((block: any) => block?.type === "image" && (block.data || block.url))
    .map((block: any, i: number) => ({
      src: block.url || (String(block.data).startsWith("data:") ? block.data : `data:${block.mimeType || "image/png"};base64,${block.data}`),
      alt: block.alt || `Tool image ${i + 1}`,
    }));
}

export function isReadTool(tool: ToolExecution): boolean {
  return /^read$/i.test(tool.toolName);
}

export function isExecuteTool(tool: ToolExecution): boolean {
  return /^(bash|python|ruby|node|neovim|rails)$/i.test(tool.toolName);
}

export function isEditFamilyTool(tool: ToolExecution): boolean {
  return /^(edit|write)$/i.test(tool.toolName);
}

export function readPath(tool: ToolExecution): string {
  const args = tool.args as any;
  return String(args?.path ?? args?.file_path ?? "");
}

export function languageFromPath(path: string): string {
  const fileName = path.split(/[\\/]/).pop()?.toLowerCase() || "";
  const ext = fileName.includes(".") ? fileName.split(".").pop() || "" : "";
  const byName: Record<string, string> = {
    dockerfile: "dockerfile",
    makefile: "makefile",
    "package.json": "json",
    "tsconfig.json": "json",
  };
  const byExt: Record<string, string> = {
    bash: "bash", sh: "bash", zsh: "bash",
    css: "css", scss: "css", sass: "css", less: "css",
    diff: "diff", patch: "diff",
    htm: "html", html: "html", svg: "html", xml: "xml",
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    json: "json", jsonc: "json",
    md: "markdown", markdown: "markdown",
    py: "python",
    ts: "typescript", tsx: "typescript",
    svelte: "html",
    vue: "html",
    yaml: "yaml", yml: "yaml",
  };
  return byName[fileName] || byExt[ext] || ext || "text";
}

export function resultDiff(tool: ToolExecution): string {
  const diff = (tool.result as any)?.details?.diff;
  return typeof diff === "string" ? diff : "";
}

export function hasResultDiff(tool: ToolExecution): boolean {
  return !!resultDiff(tool).trim();
}

export function hasEditDiff(tool: ToolExecution): boolean {
  const args = tool.args as any;
  return /^edit$/i.test(tool.toolName) && args && (args.oldText || args.old_text) && (args.newText || args.new_text);
}

export function editOldText(tool: ToolExecution): string {
  const args = tool.args as any;
  return String(args?.oldText ?? args?.old_text ?? "");
}

export function editNewText(tool: ToolExecution): string {
  const args = tool.args as any;
  return String(args?.newText ?? args?.new_text ?? "");
}

export function diffLines(oldText: string, newText: string): { kind: "same" | "removed" | "added"; text: string }[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd >= start && newEnd >= start && oldLines[oldEnd] === newLines[newEnd]) { oldEnd--; newEnd--; }
  return [
    ...oldLines.slice(0, start).map((text) => ({ kind: "same" as const, text })),
    ...oldLines.slice(start, oldEnd + 1).map((text) => ({ kind: "removed" as const, text })),
    ...newLines.slice(start, newEnd + 1).map((text) => ({ kind: "added" as const, text })),
    ...oldLines.slice(oldEnd + 1).map((text) => ({ kind: "same" as const, text })),
  ];
}

export async function copyToolOutput(tool: ToolExecution): Promise<void> {
  const text = outputText(tool);
  if (!text.trim()) return;
  await navigator.clipboard?.writeText(text);
}
