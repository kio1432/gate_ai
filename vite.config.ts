import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    outDir: 'extension',
    emptyOutDir: false,
    modulePreload: false,
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/extension/background.ts'),
        content: resolve(__dirname, 'src/extension/content.ts'),
        blocked: resolve(__dirname, 'src/extension/blocked.ts'),
        popup: resolve(__dirname, 'src/extension/popup.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
    target: 'esnext',
    minify: true,
  },
});
