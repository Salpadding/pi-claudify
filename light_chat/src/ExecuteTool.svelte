<script lang="ts">
  import type { ToolExecution } from "./lib/api";
  import HighlightedCode from "./HighlightedCode.svelte";
  import { copyToolOutput, getArgsPreview, outputText } from "./lib/tool-render";

  type Props = { tool: ToolExecution };
  let { tool }: Props = $props();
  let expanded = $state(false);

  $effect(() => {
    if (tool.status === "pending" || tool.status === "streaming") expanded = true;
    if (tool.status === "complete") expanded = false;
  });

  function codeLanguage(): string {
    if (/^bash$/i.test(tool.toolName)) return "bash";
    if (/^python$/i.test(tool.toolName)) return "python";
    if (/^ruby$/i.test(tool.toolName)) return "ruby";
    return tool.toolName.toLowerCase();
  }

  function executableCode(): string {
    const args = tool.args as any;
    return String(args?.command ?? args?.code ?? "");
  }

  async function copyOutput(event: MouseEvent) {
    event.stopPropagation();
    await copyToolOutput(tool);
  }
</script>

<div class="tool-card" data-tool-call-id={tool.toolCallId}>
  <div class="tool-card-header" role="button" tabindex="0" onclick={() => expanded = !expanded} onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); expanded = !expanded; } }}>
    <span class="tool-header-left">
      <span class="tool-card-chevron" class:expanded>▶</span>
      <span class="tool-name">{tool.toolName}</span>
      {#if getArgsPreview(tool.args)}<span class="tool-args-preview">{getArgsPreview(tool.args)}</span>{/if}
    </span>
    <span class="tool-header-right">
      <button class="tool-action-btn" type="button" title="Copy output" onclick={copyOutput}>⧉</button>
      <span class="tool-status {tool.status}">{tool.status}</span>
    </span>
  </div>

  {#if expanded}
    <div class="tool-card-body">
      {#if executableCode()}
        <HighlightedCode code={executableCode()} language={codeLanguage()} wrapperClass="tool-execute-code" />
      {/if}

      {#if outputText(tool)}
        <pre class="tool-output">{outputText(tool)}</pre>
      {/if}
    </div>
  {/if}
</div>
