import { defineConfig } from "vite";

// Tauri 前端：固定端口，避免 devUrl 漂移；build 产物给 src-tauri 打包。
// 主入口单文件（index.html → index-*.js，无跨 chunk import，jsdom 测试可 eval 单文件）。
// popup.html（置顶弹出接收窗口）由 vite.popup.config.ts 单独 build（emptyOutDir:false）追加产物。
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // 忽略 src-tauri（Rust 编译产物 target 下的 .exe/.pdb 处于锁定态，Vite watcher 监听会 EBUSY）
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "es2022",
  },
});
