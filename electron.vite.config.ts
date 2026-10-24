import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// electron-vite's isolated entries draw a progress line with these, which a
// piped stdout does not have.
const stdout = process.stdout as unknown as Record<string, unknown>;
stdout.clearLine ??= () => true;
stdout.cursorTo ??= () => true;
stdout.moveCursor ??= () => true;
stdout.columns ??= 80;

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve("electron/main.ts"),
          "pdf-worker": resolve("electron/agent/pdf/worker.ts"),
        },
        output: { entryFileNames: "[name].js" },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // A sandboxed preload cannot require a shared chunk, so each entry is
      // bundled on its own.
      isolatedEntries: true,
      rollupOptions: {
        input: {
          index: resolve("electron/preload.ts"),
          forms: resolve("electron/passwords/form-preload.ts"),
          "extension-page": resolve("electron/extensions/preload-page.ts"),
          "extension-worker": resolve("electron/extensions/preload-worker.ts"),
        },
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: ".",
    plugins: [react()],
    build: { rollupOptions: { input: resolve("index.html") } },
  },
});
