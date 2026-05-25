import MarkdownIt from "markdown-it";
import markdownItKatex from "markdown-it-katex";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import shell from "highlight.js/lib/languages/shell";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("python", python);
hljs.registerLanguage("shell", shell);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerAliases(["sh", "zsh"], { languageName: "bash" });
hljs.registerAliases(["js", "jsx", "mjs", "cjs"], { languageName: "javascript" });
hljs.registerAliases(["ts", "tsx"], { languageName: "typescript" });
hljs.registerAliases(["html", "svg"], { languageName: "xml" });
hljs.registerAliases(["md"], { languageName: "markdown" });
hljs.configure({ ignoreUnescapedHTML: true });

const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });
md.use(markdownItKatex, { throwOnError: false, strict: "ignore" });

const defaultLinkOpen = md.renderer.rules.link_open || ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet("target", "_blank");
  tokens[idx].attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen(tokens, idx, options, env, self);
};

md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  const info = token.info ? token.info.trim() : "";
  const lang = info ? info.split(/\s+/)[0] : "code";
  const highlighted = highlightCode(token.content.replace(/\n$/, ""), lang);
  const langClass = /^[A-Za-z0-9_-]+$/.test(lang) ? ` language-${escapeHtml(lang)}` : "";
  return '<div class="code-block-wrapper">'
    + '<div class="code-block-header"><span>' + escapeHtml(lang) + '</span><button class="copy-btn" onclick="copyCode(this)">Copy</button></div>'
    + '<pre><code class="hljs' + langClass + '">' + highlighted + '</code></pre>'
    + '</div>\n';
};

export function highlightCode(code: string, lang: string): string {
  const normalized = normalizeLanguage(lang);
  try {
    if (normalized && hljs.getLanguage(normalized)) {
      return hljs.highlight(code, { language: normalized, ignoreIllegals: true }).value;
    }
    return hljs.highlightAuto(code).value;
  } catch {
    return escapeHtml(code);
  }
}

export function normalizeLanguage(lang: string): string {
  const value = String(lang || "").toLowerCase();
  if (!value || value === "code" || value === "text" || value === "plain") return "";
  return ({
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "typescript", sh: "bash", zsh: "bash",
    html: "xml", svg: "xml", md: "markdown",
  })[value] || value;
}

function escapeHtml(text: string): string {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function protectSegments(text: string, regexp: RegExp, prefix: string) {
  const segments: string[] = [];
  const output = text.replace(regexp, (match) => {
    const token = `@@${prefix}_PROTECTED_${segments.length}@@`;
    segments.push(match);
    return token;
  });
  return { output, segments, prefix };
}

function restoreSegments(text: string, segments: string[], prefix: string): string {
  const regexp = new RegExp(`@@${prefix}_PROTECTED_(\\d+)@@`, "g");
  return text.replace(regexp, (_, idx) => segments[Number(idx)] ?? "");
}

export function renderMarkdown(text: string): string {
  if (!text) return "";
  let normalized = String(text).replace(/\r\n/g, "\n");
  const fenced = protectSegments(normalized, /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g, "FENCED");
  const inline = protectSegments(fenced.output, /(`+)([\s\S]*?)\1/g, "INLINE");
  let output = inline.output
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, body) => `\n$$\n${body.trim()}\n$$\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, body) => `$${body}$`);
  output = restoreSegments(output, inline.segments, inline.prefix);
  output = restoreSegments(output, fenced.segments, fenced.prefix);
  return md.render(output);
}

declare global {
  interface Window {
    copyCode: (btn: HTMLButtonElement) => void;
  }
}

window.copyCode = (btn: HTMLButtonElement) => {
  const codeBlock = btn.closest(".code-block-wrapper")?.querySelector("code");
  const text = codeBlock?.textContent ?? "";
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = "Copied!";
    btn.classList.add("copied");
    setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 1500);
  }).catch(() => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;left:-9999px";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  });
};
