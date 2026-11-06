import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const appRoot = fileURLToPath(new URL('.', import.meta.url))
export default defineConfig({
  root: appRoot,
  plugins: [vue()],
  clearScreen: false,
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
  build: {
    outDir: resolve(appRoot, '../../dist/desktop'),
    emptyOutDir: false,
    target: 'es2022'
  }
})
