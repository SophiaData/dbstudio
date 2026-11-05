/** 构建独立 Node listener 和隔离 driver host；不触发 Electron 构建。 */
import { build } from 'vite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export async function buildHttpServer(outDir = resolve(root, 'out/http-server')) {
  await build({
    configFile: false, root, logLevel: 'warn',
    ssr: { noExternal: ['jose'] },
    build: {
      outDir, emptyOutDir: false, target: 'node22', minify: false, sourcemap: true, ssr: true,
      lib: { entry: resolve(root, 'src/server/index.ts'), formats: ['es'], fileName: () => 'index.mjs' },
      rollupOptions: { external: [/^node:/], output: { entryFileNames: 'index.mjs' } }
    }
  })
  await build({
    configFile: false, root, logLevel: 'warn',
    build: {
      outDir: resolve(outDir, 'driver-host'), emptyOutDir: false,
      target: 'node22', minify: false, sourcemap: true, ssr: true,
      lib: { entry: resolve(root, 'src/driver-host/index.ts'), formats: ['cjs'], fileName: () => 'index.cjs' },
      rollupOptions: { external: [/^node:/, 'electron'], output: { entryFileNames: 'index.cjs' } }
    }
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildHttpServer()
  console.log('[build-http-server] 已构建独立 listener 与 driver host')
}
