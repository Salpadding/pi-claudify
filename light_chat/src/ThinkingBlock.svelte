<script lang="ts">
  import MarkdownContent from "./MarkdownContent.svelte";

  type Props = { thinking?: string };
  let { thinking = "" }: Props = $props();
  let expanded = $state(false);
</script>

{#if thinking.trim()}
  <div class="thinking-block">
    <button class="thinking-toggle" type="button" class:expanded onclick={() => expanded = !expanded}>
      <span class="thinking-chevron">▶</span>
      <span>Thinking</span>
    </button>
    {#if expanded}
      <div class="thinking-content"><MarkdownContent content={thinking} /></div>
    {/if}
  </div>
{/if}
