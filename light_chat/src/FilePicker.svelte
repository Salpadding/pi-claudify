<script lang="ts">
  import Icon from "@iconify/svelte";
  import {
    type FileItem,
    fetchFiles,
    formatFileMention,
    formatSize,
    fileIcon,
  } from "./lib/api";

  let currentPath = $state("");
  let parentPath = $state("");
  let items: FileItem[] = $state([]);
  let loading = $state(false);
  let error = $state("");

  let { 
    open = $bindable(false), 
    input = $bindable(""), 
    inputEl = $bindable() }: { 
        open: boolean, input: string, inputEl: HTMLTextAreaElement | undefined 
    } = $props();

  $effect(() => {
    if (open) loadFiles();
  });

  function hide() {
    open = false;
  }

  async function loadFiles(dirPath?: string) {
    loading = true;
    error = "";
    try {
      const data = await fetchFiles(dirPath);
      currentPath = data.path;
      parentPath = data.parent;
      items = data.items;
    } catch (e: any) {
      error = e?.message || String(e);
    } finally {
      loading = false;
    }
  }

  function selectFile(item: FileItem) {
    const mention = formatFileMention(item.insertPath || item.path);
    const start = inputEl?.selectionStart ?? input.length;
    const end = inputEl?.selectionEnd ?? input.length;
    const before = input.slice(0, start);
    const after = input.slice(end);
    const prefix = before && !/\s$/.test(before) ? " " : "";
    const suffix = after && !/^\s/.test(after) ? " " : "";
    input = before + prefix + mention + suffix + after;
    hide();
    inputEl?.focus();
  }

  function goUp() {
    if (parentPath && parentPath !== currentPath) loadFiles(parentPath);
  }
</script>

<svelte:document onkeydown={(e) => { if (e.key === "Escape" && open) hide(); }} />

{#if open}
  <div
    class="file-picker"
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-label="选择服务端文件"
    onclick={(e) => { if (e.target === e.currentTarget) hide(); }}
    onkeydown={(e) => { if (e.key === "Escape") hide(); }}
  >
    <div class="file-picker-panel">
      <div class="file-picker-header">
        <button class="icon-btn" type="button" title="上级目录" disabled={!parentPath || parentPath === currentPath} onclick={goUp}>↑</button>
        <div class="file-picker-path" title={currentPath}>{currentPath}</div>
        <button class="icon-btn" type="button" title="关闭" onclick={hide}>×</button>
      </div>
      <div class="file-picker-list">
        {#if loading}
          <div class="file-picker-loading">Loading…</div>
        {:else if error}
          <div class="file-picker-error">{error}</div>
        {:else if items.length === 0}
          <div class="file-picker-loading">Empty directory</div>
        {:else}
          {#each items as item (item.path)}
            <div
              class="file-picker-row {item.isDirectory ? 'directory' : ''}"
              title={item.path}
              role="button"
              tabindex="0"
              onclick={() => item.isDirectory ? loadFiles(item.path) : selectFile(item)}
              onkeydown={(e) => { if (e.key === "Enter") item.isDirectory ? loadFiles(item.path) : selectFile(item); }}
            >
              <Icon class="file-picker-icon" icon={fileIcon(item)} />
              <span class="file-picker-name">{item.name}</span>
              <span class="file-picker-size">{item.isDirectory ? "" : formatSize(item.size)}</span>
            </div>
          {/each}
        {/if}
      </div>
    </div>
  </div>
{/if}
