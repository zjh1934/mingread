const { defineConfig } = require('vite');
const react = require('@vitejs/plugin-react');

// 渲染进程构建：输出到 dist/renderer，主进程由 Electron 直接运行 src/main（CJS）。
// 本地离线 TTS 桥接仅在主进程（Node）生效，不进入渲染包，避免在线回退。
module.exports = defineConfig({
  root: '.',
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    rollupOptions: {
      input: 'index.html',
    },
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  optimizeDeps: {
    // 主进程 CJS 依赖不进渲染包；node-edge-tts 为运行时在线兜底（仅主进程）
    exclude: ['@echogarden/windows-media-tts', 'node-edge-tts'],
  },
});
