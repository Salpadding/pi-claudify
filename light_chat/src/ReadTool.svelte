<script lang="ts">
  import type { ToolExecution } from "./lib/api";
  import HighlightedCode from "./HighlightedCode.svelte";
  import { copyToolOutput, getArgsPreview, languageFromPath, outputText, readPath, toolImages } from "./lib/tool-render";

  type Props = { tool: ToolExecution };
  let { tool }: Props = $props();
  let expanded = $state(false);

  $effect(() => {
    if (tool.status === "pending" || tool.status === "streaming") expanded = true;
    if (tool.status === "complete") expanded = false;
  });

  function readOutputLanguage(): string {
    return languageFromPath(readPath(tool));
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
      {#if toolImages(tool).length}
        <div class="tool-images">
          {#each toolImages(tool) as image}
            <img class="tool-image" src={image.src} alt={image.alt} />
          {/each}
        </div>
      {/if}

      {#if outputText(tool)}
        <HighlightedCode code={outputText(tool)} language={readOutputLanguage()} wrapperClass="tool-read-output" />
      {/if}
    </div>
  {/if}
</div>
