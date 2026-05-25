import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { resolve } from "path";

export default defineConfig({
  base: "/chat/",
  plugins: [svelte()],
  resolve: {
    dedupe: ["svelte"],
  },
  build: {
    outDir: resolve(__dirname, "../dist/resource/light_chat"),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/chat/events": "http://localhost:0",
      "/chat/send": "http://localhost:0",
      "/chat/files": "http://localhost:0",
      "/chat/status": "http://localhost:0",
    },
  },
});
