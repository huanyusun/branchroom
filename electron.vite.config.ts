import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {},
  // sandbox=true 要求 preload 为 CommonJS 单文件；electron 与 Node 内置模块由 electron-vite 默认外部化。
  preload: {
    build: {
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    plugins: [react()]
  }
});
