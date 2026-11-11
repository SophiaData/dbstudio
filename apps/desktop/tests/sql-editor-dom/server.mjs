import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { mkdir, mkdtemp, realpath, lstat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createPortReservation } from 'node:net'

const fixtureRoot = fileURLToPath(new URL('./', import.meta.url))
const project = path.resolve(fixtureRoot, '../../../..')
const args = process.argv.slice(2)
if (!(args.length === 0 || (args.length === 2 && args[0] === '--evidence-dir'))) throw new Error('Use --evidence-dir <new-owned-run-directory> or no arguments')
const evidence = args.length ? path.resolve(project, args[1]) : await mkdtemp(path.join(project, 'backups/mysql-editor-dom-'))
if (path.dirname(evidence) !== path.join(project, 'backups') || !path.basename(evidence).startsWith('mysql-editor-dom-')) throw new Error('Evidence must be a directly owned mysql-editor-dom run directory')
const info = await lstat(evidence)
if (!info.isDirectory() || info.isSymbolicLink() || await realpath(evidence) !== evidence) throw new Error('Evidence directory must be a real directory, not a link')
await mkdir(path.join(evidence, 'screenshots'), { recursive: false })
// Vite treats zero as its default port, so reserve a real OS-assigned port first.
const reservation = createPortReservation()
await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen({ host: '127.0.0.1', port: 0 }, resolve) })
const reservedAddress = reservation.address()
if (!reservedAddress || typeof reservedAddress === 'string') throw new Error('Dynamic port reservation failed')
const port = reservedAddress.port
await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()))
const server = await createServer({
  root: fixtureRoot, configFile: false, envFile: false,
  plugins: [vue()], cacheDir: path.join(evidence, 'vite-cache'),
  server: { host: '127.0.0.1', port, strictPort: true, open: false, fs: { allow: [project] } },
  clearScreen: false
})
await server.listen()
const address = server.httpServer?.address()
if (!address || typeof address === 'string' || [1420, 62032].includes(address.port)) { await server.close(); throw new Error('Expected an independent loopback dynamic port') }
const origin = `http://127.0.0.1:${address.port}`
await writeFile(path.join(evidence, 'server.json'), JSON.stringify({ scope: 'synthetic-sfc-browser-dom', origin, fixture_url: `${origin}/fixture.html`, evidence_directory: evidence, configFile: false, envFile: false, production_app: false, native_backend: false }, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ ready: true, fixture_url: `${origin}/fixture.html`, evidence_directory: evidence }))
let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await server.close()
  console.log('Synthetic SQL editor DOM server stopped; evidence retained.')
}
process.once('SIGINT', () => { void stop().then(() => process.exit(0)) })
process.once('SIGTERM', () => { void stop().then(() => process.exit(0)) })
