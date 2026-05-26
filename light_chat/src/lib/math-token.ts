import type MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import katex from "katex";

interface DollarDelimiterValidity {
  canOpen: boolean;
  canClose: boolean;
}

function renderKatex(latex: string, displayMode: boolean): string {
  return katex.renderToString(latex, { displayMode, throwOnError: false, strict: "ignore" });
}

function isValidDollarDelimiter(state: StateInline, pos: number): DollarDelimiterValidity {
  const max = state.posMax;
  const prevChar = pos > 0 ? state.src.charCodeAt(pos - 1) : -1;
  const nextChar = pos + 1 <= max ? state.src.charCodeAt(pos + 1) : -1;
  return {
    canOpen: nextChar !== 0x20 && nextChar !== 0x09,
    canClose: prevChar !== 0x20 && prevChar !== 0x09 && !(nextChar >= 0x30 && nextChar <= 0x39),
  };
}

function mathInline(state: StateInline, silent: boolean): boolean {
  if (state.src[state.pos] !== "$") return false;
  if (!isValidDollarDelimiter(state, state.pos).canOpen) {
    if (!silent) state.pending += "$";
    state.pos += 1;
    return true;
  }

  const start = state.pos + 1;
  let match = start;
  while ((match = state.src.indexOf("$", match)) !== -1) {
    let pos = match - 1;
    while (state.src[pos] === "\\") pos -= 1;
    if ((match - pos) % 2 === 1) break;
    match += 1;
  }
  if (match === -1) {
    if (!silent) state.pending += "$";
    state.pos = start;
    return true;
  }
  if (match - start === 0) {
    if (!silent) state.pending += "$$";
    state.pos = start + 1;
    return true;
  }
  if (!isValidDollarDelimiter(state, match).canClose) {
    if (!silent) state.pending += "$";
    state.pos = start;
    return true;
  }

  if (!silent) {
    const token = state.push("math_inline", "math", 0);
    token.markup = "$";
    token.content = state.src.slice(start, match);
  }
  state.pos = match + 1;
  return true;
}

function mathInlineParen(state: StateInline, silent: boolean): boolean {
  if (state.src.slice(state.pos, state.pos + 2) !== "\\(") return false;

  const start = state.pos + 2;
  const match = state.src.indexOf("\\)", start);
  if (match === -1) {
    if (!silent) state.pending += "\\(";
    state.pos = start;
    return true;
  }
  if (match - start === 0) {
    if (!silent) state.pending += "\\(\\)";
    state.pos = match + 2;
    return true;
  }

  if (!silent) {
    const token = state.push("math_inline", "math", 0);
    token.markup = "\\(\\)";
    token.content = normalizeLatexCommandEscapes(state.src.slice(start, match));
  }
  state.pos = match + 2;
  return true;
}

function mathBlockBracket(state: StateBlock, start: number, end: number, silent: boolean): boolean {
  let pos = state.bMarks[start] + state.tShift[start];
  let max = state.eMarks[start];
  if (pos + 2 > max || state.src.slice(pos, pos + 2) !== "\\[") return false;
  if (silent) return true;

  pos += 2;
  let firstLine = state.src.slice(pos, max);
  let lastLine = "";
  let next = start;
  let found = false;
  const firstLineClose = firstLine.indexOf("\\]");

  if (firstLineClose !== -1) {
    firstLine = firstLine.slice(0, firstLineClose);
    found = true;
  }

  for (; !found;) {
    next += 1;
    if (next >= end) break;
    pos = state.bMarks[next] + state.tShift[next];
    max = state.eMarks[next];
    if (pos < max && state.tShift[next] < state.blkIndent) break;
    const line = state.src.slice(pos, max);
    const close = line.indexOf("\\]");
    if (close !== -1) {
      lastLine = line.slice(0, close);
      found = true;
    }
  }

  state.line = found ? next + 1 : next;
  const token = state.push("math_block", "math", 0);
  token.block = true;
  token.content = normalizeLatexCommandEscapes((firstLine && firstLine.trim() ? `${firstLine}\n` : "")
    + state.getLines(start + 1, next, state.tShift[start], true)
    + (lastLine && lastLine.trim() ? lastLine : ""));
  token.map = [start, state.line];
  token.markup = "\\[\\]";
  return true;
}

function mathBlock(state: StateBlock, start: number, end: number, silent: boolean): boolean {
  let pos = state.bMarks[start] + state.tShift[start];
  let max = state.eMarks[start];
  if (pos + 2 > max || state.src.slice(pos, pos + 2) !== "$$") return false;
  if (silent) return true;

  pos += 2;
  let firstLine = state.src.slice(pos, max);
  let lastLine = "";
  let next = start;
  let found = false;

  if (firstLine.trim().slice(-2) === "$$") {
    firstLine = firstLine.trim().slice(0, -2);
    found = true;
  }

  for (; !found;) {
    next += 1;
    if (next >= end) break;
    pos = state.bMarks[next] + state.tShift[next];
    max = state.eMarks[next];
    if (pos < max && state.tShift[next] < state.blkIndent) break;
    if (state.src.slice(pos, max).trim().slice(-2) === "$$") {
      const lastPos = state.src.slice(0, max).lastIndexOf("$$");
      lastLine = state.src.slice(pos, lastPos);
      found = true;
    }
  }

  state.line = next + 1;
  const token = state.push("math_block", "math", 0);
  token.block = true;
  token.content = (firstLine && firstLine.trim() ? `${firstLine}\n` : "")
    + state.getLines(start + 1, next, state.tShift[start], true)
    + (lastLine && lastLine.trim() ? lastLine : "");
  token.map = [start, state.line];
  token.markup = "$$";
  return true;
}

export function normalizeLatexCommandEscapes(body: string): string {
  // KaTeX treats `\\` as a line break. If a command arrives as `\\ge`, it
  // renders as red text (`\g e`) instead of the command `\ge`. Collapse only
  // doubled slashes that introduce common command forms inside math.
  return body.replace(/\\\\(?=[A-Za-z!,;:{} ])/g, "\\");
}

export function installMathPlugin(markdown: MarkdownIt): void {
  markdown.inline.ruler.before("escape", "math_inline_paren", mathInlineParen);
  markdown.inline.ruler.after("escape", "math_inline", mathInline);
  markdown.block.ruler.after("blockquote", "math_block", mathBlock, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });
  markdown.block.ruler.after("math_block", "math_block_bracket", mathBlockBracket, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });
  markdown.renderer.rules.math_inline = (tokens: Token[], idx: number) => renderKatex(tokens[idx].content, false);
  markdown.renderer.rules.math_block = (tokens: Token[], idx: number) => `${renderKatex(tokens[idx].content, true)}\n`;
}
