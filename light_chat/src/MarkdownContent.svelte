<script lang="ts">
  import { renderMarkdown } from "./lib/markdown";

  type Props = { content?: string };
  let { content = "" }: Props = $props();
</script>

<div class="content">{@html renderMarkdown(content)}</div>
