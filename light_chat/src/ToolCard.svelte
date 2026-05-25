<script lang="ts">
  import type { ToolExecution } from "./lib/api";
  import { isEditFamilyTool, isExecuteTool, isReadTool } from "./lib/tool-render";
  import ReadTool from "./ReadTool.svelte";
  import ExecuteTool from "./ExecuteTool.svelte";
  import EditTool from "./EditTool.svelte";

  type Props = { tool: ToolExecution };
  let { tool }: Props = $props();
</script>

{#if isReadTool(tool)}
  <ReadTool {tool} />
{:else if isEditFamilyTool(tool)}
  <EditTool {tool} />
{:else if isExecuteTool(tool)}
  <ExecuteTool {tool} />
{:else}
  <span>unknown tool</span>
{/if}
