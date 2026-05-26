import MarkdownIt from "markdown-it";
import { installMathPlugin } from "./math-token";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import latex from "highlight.js/lib/languages/latex";
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
hljs.registerLanguage("latex", latex);
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
hljs.registerAliases(["tex", "ltx"], { languageName: "latex" });
hljs.configure({ ignoreUnescapedHTML: true });

const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });
installMathPlugin(md);

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

function normalizeLanguage(lang: string): string {
  const value = String(lang || "").toLowerCase();
  if (!value || value === "code" || value === "text" || value === "plain") return "";
  return ({
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "typescript", sh: "bash", zsh: "bash",
    html: "xml", svg: "xml", md: "markdown", tex: "latex", ltx: "latex",
  })[value] || value;
}

function escapeHtml(text: string): string {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderMarkdown(text: string): string {
  if (!text) return "";
  const normalized = String(text).replace(/\r\n/g, "\n");
  return md.render(normalized);
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
