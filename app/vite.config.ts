import { defineConfig } from "vite";

// Tauri 前端：固定端口，避免 devUrl 漂移；build 产物给 src-tauri 打包
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "es2022",
  },
});
