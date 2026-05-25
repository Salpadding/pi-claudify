export interface ChatMessage {
  id: string;
  type: "message";
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  streaming?: boolean;
}

export interface ToolExecution {
  id: string;
  type: "tool";
  toolCallId: string;
  toolName: string;
  args: unknown;
  status: "pending" | "streaming" | "complete" | "error";
  output?: string;
  result?: unknown;
  isError?: boolean;
}

export type TimelineItem = ChatMessage | ToolExecution;

export interface FileItem {
  name: string;
  path: string;
  insertPath: string;
  isDirectory: boolean;
  size: number | null;
}

export type SseEventMap = {
  snapshot: { items: TimelineItem[]; messages?: { role: string; content: string }[]; streaming: boolean; streamingContent: string; streamingThinking?: string };
  message: { role: string; content: string };
  assistant_start: { content: string };
  assistant_delta: { delta: string; content: string };
  assistant_thinking_delta: { delta: string; thinking: string };
  assistant_end: { content: string; thinking?: string };
  tool_execution_start: { toolCallId: string; toolName: string; args: unknown };
  tool_execution_update: { toolCallId: string; toolName?: string; args?: unknown; partialResult: unknown };
  tool_execution_end: { toolCallId: string; toolName?: string; result: unknown; isError: boolean };
};

export function formatToolOutput(result: unknown): string {
  if (!result) return "";
  const maybe = result as { content?: unknown };
  if (Array.isArray(maybe.content)) {
    return maybe.content.map((block: any) => block?.type === "text" ? block.text ?? "" : JSON.stringify(block)).join("\n");
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

export function connectEvents(
  onStatus: (s: string) => void,
  handlers: {
    onSnapshot: (data: SseEventMap["snapshot"]) => void;
    onMessage: (data: SseEventMap["message"]) => void;
    onAssistantStart: (data: SseEventMap["assistant_start"]) => void;
    onAssistantDelta: (data: SseEventMap["assistant_delta"]) => void;
    onAssistantThinkingDelta: (data: SseEventMap["assistant_thinking_delta"]) => void;
    onAssistantEnd: (data: SseEventMap["assistant_end"]) => void;
    onToolExecutionStart: (data: SseEventMap["tool_execution_start"]) => void;
    onToolExecutionUpdate: (data: SseEventMap["tool_execution_update"]) => void;
    onToolExecutionEnd: (data: SseEventMap["tool_execution_end"]) => void;
  },
): EventSource {
  const es = new EventSource("/chat/events");
  es.onopen = () => onStatus("connected");
  es.onerror = () => onStatus("disconnected, retrying…");
  es.addEventListener("snapshot", (ev) => handlers.onSnapshot(JSON.parse(ev.data)));
  es.addEventListener("message", (ev) => handlers.onMessage(JSON.parse(ev.data)));
  es.addEventListener("assistant_start", (ev) => handlers.onAssistantStart(JSON.parse(ev.data)));
  es.addEventListener("assistant_delta", (ev) => handlers.onAssistantDelta(JSON.parse(ev.data)));
  es.addEventListener("assistant_thinking_delta", (ev) => handlers.onAssistantThinkingDelta(JSON.parse(ev.data)));
  es.addEventListener("assistant_end", (ev) => handlers.onAssistantEnd(JSON.parse(ev.data)));
  es.addEventListener("tool_execution_start", (ev) => handlers.onToolExecutionStart(JSON.parse(ev.data)));
  es.addEventListener("tool_execution_update", (ev) => handlers.onToolExecutionUpdate(JSON.parse(ev.data)));
  es.addEventListener("tool_execution_end", (ev) => handlers.onToolExecutionEnd(JSON.parse(ev.data)));
  return es;
}

export async function sendMessage(message: string): Promise<void> {
  const res = await fetch("/chat/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
}

export async function fetchFiles(dirPath?: string): Promise<{
  path: string;
  parent: string;
  items: FileItem[];
}> {
  const url = dirPath ? `/chat/files?path=${encodeURIComponent(dirPath)}` : "/chat/files";
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

export function formatFileMention(path: string): string {
  if (/\s|"/.test(path)) return '@"' + path.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  return "@" + path;
}

export function formatSize(bytes: number | null): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

const ICON_PREFIX = "vscode-icons:";

const DIRECTORY_ICONS: Record<string, string> = {
  ".git": "folder-type-git",
  ".github": "folder-type-github",
  ".vscode": "folder-type-vscode",
  node_modules: "folder-type-node",
  src: "folder-type-src",
  test: "folder-type-test",
  tests: "folder-type-test",
  dist: "folder-type-dist",
  build: "folder-type-dist",
  docs: "folder-type-docs",
  images: "folder-type-images",
  assets: "folder-type-asset",
};

const FILE_NAME_ICONS: Record<string, string> = {
  "package.json": "file-type-npm",
  "package-lock.json": "file-type-npm",
  "pnpm-lock.yaml": "file-type-pnpm",
  "yarn.lock": "file-type-yarn",
  "bun.lockb": "file-type-bun",
  "tsconfig.json": "file-type-tsconfig",
  "jsconfig.json": "file-type-jsconfig",
  "vite.config.ts": "file-type-vite",
  "vite.config.js": "file-type-vite",
  "svelte.config.js": "file-type-svelteconfig",
  dockerfile: "file-type-docker",
  "docker-compose.yml": "file-type-docker",
  "docker-compose.yaml": "file-type-docker",
  readme: "file-type-markdown",
  "readme.md": "file-type-markdown",
  license: "file-type-license",
  ".gitignore": "file-type-git",
  ".env": "file-type-dotenv",
  ".env.local": "file-type-dotenv",
};

const FILE_EXTENSION_ICONS: Record<string, string> = {
  js: "file-type-js",
  jsx: "file-type-reactjs",
  ts: "file-type-typescript",
  tsx: "file-type-reactts",
  svelte: "file-type-svelte",
  vue: "file-type-vue",
  html: "file-type-html",
  css: "file-type-css",
  scss: "file-type-scss",
  sass: "file-type-sass",
  less: "file-type-less",
  json: "file-type-json",
  jsonc: "file-type-json",
  yaml: "file-type-yaml",
  yml: "file-type-yaml",
  toml: "file-type-toml",
  xml: "file-type-xml",
  py: "file-type-python",
  rb: "file-type-ruby",
  rs: "file-type-rust",
  go: "file-type-go",
  java: "file-type-java",
  kt: "file-type-kotlin",
  php: "file-type-php",
  lua: "file-type-lua",
  sh: "file-type-shell",
  bash: "file-type-shell",
  zsh: "file-type-shell",
  fish: "file-type-shell",
  sql: "file-type-sql",
  wasm: "file-type-wasm",
  md: "file-type-markdown",
  markdown: "file-type-markdown",
  txt: "file-type-text",
  pdf: "file-type-pdf2",
  csv: "file-type-excel",
  xls: "file-type-excel",
  xlsx: "file-type-excel",
  doc: "file-type-word",
  docx: "file-type-word",
  ppt: "file-type-powerpoint",
  pptx: "file-type-powerpoint",
  png: "file-type-image",
  jpg: "file-type-image",
  jpeg: "file-type-image",
  gif: "file-type-image",
  webp: "file-type-image",
  svg: "file-type-svg",
  ico: "file-type-image",
  mp3: "file-type-audio",
  wav: "file-type-audio",
  flac: "file-type-audio",
  mp4: "file-type-video",
  mov: "file-type-video",
  webm: "file-type-video",
  zip: "file-type-zip",
  gz: "file-type-zip",
  tar: "file-type-zip",
  rar: "file-type-zip",
  "7z": "file-type-zip",
  exe: "file-type-binary",
  bin: "file-type-binary",
};

export function fileIcon(item: FileItem): string {
  const name = String(item.name || "");
  const lowerName = name.toLowerCase();
  const icon = item.isDirectory
    ? DIRECTORY_ICONS[lowerName] || "default-folder"
    : FILE_NAME_ICONS[lowerName] || FILE_EXTENSION_ICONS[lowerName.includes(".") ? lowerName.split(".").pop() || "" : ""] || "default-file";

  return ICON_PREFIX + icon;
}
