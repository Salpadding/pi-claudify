<script lang="ts">
  import { highlightCode } from "./lib/markdown";

  type Props = {
    code?: string;
    language?: string;
    wrapperClass?: string;
  };

  let { code = "", language = "text", wrapperClass = "" }: Props = $props();

  function highlighted(): string {
    return highlightCode(code, language);
  }
</script>

<div class={`code-block-wrapper ${wrapperClass}`.trim()}>
  <div class="code-block-header">
    <span>{language}</span>
    <button class="copy-btn" type="button" onclick={(e) => window.copyCode(e.currentTarget as HTMLButtonElement)}>Copy</button>
  </div>
  <pre><code class="hljs language-{language}">{@html highlighted()}</code></pre>
</div>
