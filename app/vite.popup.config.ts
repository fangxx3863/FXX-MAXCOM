import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

// 置顶弹出接收窗口独立入口：popup.html → popup-*.js（单文件，无跨 chunk import）。
// emptyOutDir:false —— 追加到已 build 好的 dist，不清空主产物（index.html/index-*.js）。
// 主入口由 vite.config.ts 构建，此文件仅在 build 脚本第二步调用。
export default defineConfig({
  clearScreen: false,
  build: {
    target: "es2022",
    emptyOutDir: false,
    rollupOptions: {
      input: {
        popup: fileURLToPath(new URL("./popup.html", import.meta.url)),
      },
    },
  },
});
