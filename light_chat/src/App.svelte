<script lang="ts">
  import { onMount } from "svelte";
  import { themes, getCurrentTheme, applyTheme, watchOsTheme } from "./lib/theme";
  import {
    type TimelineItem,
    connectEvents,
    formatToolOutput,
    sendMessage,
  } from "./lib/api";
  import FilePicker from "./FilePicker.svelte";
  import ThinkingBlock from "./ThinkingBlock.svelte";
  import ToolCard from "./ToolCard.svelte";
  import MarkdownContent from "./MarkdownContent.svelte";

  let items: TimelineItem[] = $state([]);
  let status = $state("connecting…");
  let theme = $state(getCurrentTheme());
  let input = $state("");
  let sending = $state(false);

  let filePickerOpen = $state(false);

  let messagesEl: HTMLElement | undefined = $state();
  let inputEl: HTMLTextAreaElement | undefined = $state();
  let streamingIndex: number | null = null;
  let renderTimer = 0;
  let es: EventSource | null = null;
  let idCounter = 0;
  let copiedMessageId: string | null = $state(null);
  let copyTimer = 0;

  function newMessageId() {
    return globalThis.crypto?.randomUUID?.() ?? `msg-${Date.now()}-${++idCounter}`;
  }

  function findTool(toolCallId: string) {
    const item = items.find((item) => item.type === "tool" && item.toolCallId === toolCallId);
    return item?.type === "tool" ? item : undefined;
  }

  function ensureTool(toolCallId: string, toolName = "tool", args: unknown = {}) {
    let tool = findTool(toolCallId);
    if (!tool) {
      tool = { id: `tool-${toolCallId}`, type: "tool", toolCallId, toolName, args, status: "pending", output: "" };
      items.push(tool);
    }
    return tool;
  }

  onMount(() => {
    applyTheme(theme);
    watchOsTheme();

    es = connectEvents(
      (s) => (status = s),
      {
        onSnapshot: (data) => {
          items = data.items ?? (data.messages || []).map((m, i) => ({
            id: `snap-${i}`,
            type: "message" as const,
            role: m.role as "user" | "assistant",
            content: m.content,
          }));
          if (data.streaming) {
            items.push({ id: "streaming", type: "message", role: "assistant", content: data.streamingContent || "", thinking: data.streamingThinking || "", streaming: true });
            streamingIndex = items.length - 1;
          } else {
            streamingIndex = null;
          }
          scheduleRender();
        },
        onMessage: (data) => {
          items.push({ id: newMessageId(), type: "message", role: data.role as "user" | "assistant", content: data.content });
          scheduleRender();
        },
        onAssistantStart: (data) => {
          items.push({ id: newMessageId(), type: "message", role: "assistant", content: data.content || "", thinking: "", streaming: true });
          streamingIndex = items.length - 1;
          scheduleRender();
        },
        onAssistantDelta: (data) => {
          const item = streamingIndex !== null ? items[streamingIndex] : undefined;
          if (item?.type === "message") {
            item.content = data.content ?? (item.content + (data.delta || ""));
          }
          scheduleRender();
        },
        onAssistantThinkingDelta: (data) => {
          const item = streamingIndex !== null ? items[streamingIndex] : undefined;
          if (item?.type === "message") item.thinking = data.thinking ?? ((item.thinking || "") + (data.delta || ""));
          scheduleRender();
        },
        onAssistantEnd: (data) => {
          const item = streamingIndex !== null ? items[streamingIndex] : undefined;
          if (item?.type === "message") {
            item.content = data.content || item.content;
            item.thinking = data.thinking ?? item.thinking;
            item.streaming = false;
            if (!item.content.trim() && !item.thinking?.trim()) items.splice(streamingIndex!, 1);
          }
          streamingIndex = null;
          scheduleRender();
        },
        onToolExecutionStart: (data) => {
          const tool = ensureTool(data.toolCallId, data.toolName, data.args);
          tool.toolName = data.toolName;
          tool.args = data.args;
          tool.status = "pending";
          tool.output = "";
          scheduleRender();
        },
        onToolExecutionUpdate: (data) => {
          const tool = ensureTool(data.toolCallId, data.toolName, data.args ?? {});
          tool.status = "streaming";
          if (data.args !== undefined) tool.args = data.args;
          tool.output = formatToolOutput(data.partialResult);
          scheduleRender();
        },
        onToolExecutionEnd: (data) => {
          const tool = ensureTool(data.toolCallId, data.toolName);
          if (data.toolName) tool.toolName = data.toolName;
          tool.status = data.isError ? "error" : "complete";
          tool.result = data.result;
          tool.output = formatToolOutput(data.result);
          tool.isError = data.isError;
          scheduleRender();
        },
      },
    );

    return () => es?.close();
  });

  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = window.setTimeout(() => {
      renderTimer = 0;
      scrollToBottom();
    }, 50);
  }

  function scrollToBottom() {
    if (messagesEl && messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120) {
      requestAnimationFrame(() => { if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight; });
    }
  }

  function handleThemeChange() {
    applyTheme(theme);
  }

  async function handleSend() {
    const message = input.trim();
    if (!message) return;
    sending = true;
    try {
      await sendMessage(message);
      input = "";
      if (inputEl) { inputEl.style.height = ""; }
    } catch (e: any) {
      alert(e?.message || String(e));
    } finally {
      sending = false;
      inputEl?.focus();
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }

  async function copyAssistantMessage(item: TimelineItem) {
    if (item.type !== "message" || item.role !== "assistant" || !item.content) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(item.content);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = item.content;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      copiedMessageId = item.id;
      window.clearTimeout(copyTimer);
      copyTimer = window.setTimeout(() => (copiedMessageId = null), 1400);
    } catch (e: any) {
      alert(e?.message || "复制失败");
    }
  }

  function handleInput() {
    if (inputEl) {
      inputEl.style.height = "auto";
      inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + "px";
    }
  }
</script>



<div class="app">
  <header>
    <div class="logo">π claudify chat</div>
    <div class="status">{status}</div>
    <select class="theme-select" aria-label="Theme" bind:value={theme} onchange={handleThemeChange}>
      {#each themes as t}
        <option value={t.id}>{t.name}</option>
      {/each}
    </select>
  </header>

  <main id="messages" bind:this={messagesEl}>
    {#if items.length === 0}
      <div class="empty">等待消息…</div>
    {/if}
    {#each items as item (item.id)}
      {#if item.type === "message"}
        <article class="message {item.role}">
          <div class="message-header">
            <div class="role">{item.role}</div>
            {#if item.role === "assistant"}
              <button
                type="button"
                class="message-copy-btn"
                class:copied={copiedMessageId === item.id}
                title="复制 ASSISTANT 消息"
                aria-label="复制 ASSISTANT 消息"
                disabled={!item.content}
                onclick={() => copyAssistantMessage(item)}
              >{copiedMessageId === item.id ? "已复制" : "复制"}</button>
            {/if}
          </div>
          <ThinkingBlock thinking={item.thinking} />
          <MarkdownContent content={item.content} />
        </article>
      {:else if item.type === "tool"}
        <ToolCard tool={item} />
      {/if}
    {/each}
  </main>

  <div class="composer">
    <form onsubmit={(e) => { e.preventDefault(); handleSend(); }}>
      <button type="button" class="secondary-btn" title="从服务端选择文件" onclick={() => filePickerOpen = true}>文件</button>
      <textarea bind:value={input} bind:this={inputEl} rows="1" placeholder="输入消息，Enter 发送，Shift+Enter 换行" onkeydown={handleKeydown} oninput={handleInput}></textarea>
      <button type="submit" disabled={sending}>发送</button>
    </form>
  </div>
</div>

<FilePicker bind:open={filePickerOpen} bind:input bind:inputEl />
