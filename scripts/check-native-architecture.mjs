import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--no-deps', '--format-version', '1'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
const packages = new Map(metadata.packages.map((pkg) => [pkg.name, pkg]))
for (const name of ['dbstudio-protocol', 'dbstudio-drivers', 'dbstudio-core', 'dbstudio-desktop']) assert.ok(packages.has(name), `${name} must belong to the native workspace`)
const dependencies = (name) => packages.get(name).dependencies.map((dependency) => dependency.name)
for (const name of ['dbstudio-protocol', 'dbstudio-drivers', 'dbstudio-core']) {
  assert.ok(!dependencies(name).some((dependency) => /^tauri(?:-|$)|^wry$/.test(dependency)), `${name} must not depend on the desktop shell`)
}
assert.ok(!dependencies('dbstudio-protocol').some((dependency) => /^(rusqlite|postgres|mysql|redis|kafka|tokio|reqwest|ssh2)$/.test(dependency)), 'protocol must not own runtime I/O')
assert.ok(!dependencies('dbstudio-drivers').includes('dbstudio-core'), 'drivers must not depend on the application layer')
assert.ok(dependencies('dbstudio-core').includes('dbstudio-drivers'), 'application must use the native driver layer')
assert.ok(dependencies('dbstudio-desktop').includes('dbstudio-core'), 'desktop must consume the shared application core')

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : /\.(rs|ts|vue)$/.test(entry.name) ? [path] : []
  })
}
for (const file of sourceFiles(join(root, 'apps/desktop/src'))) {
  const source = readFileSync(file, 'utf8')
  assert.ok(!/from\s*['"](?:electron|node:|child_process|fs['"]|pg['"]|mysql2|ioredis|kafkajs)/.test(source), 'Vue source must not import shell/Node/database implementations')
  assert.ok(!/window\.dbstudio|__DBSTUDIO_BACKEND_CONFIG__/.test(source), 'Vue must not fall back to the legacy Electron or HTTP runtime')
}
for (const directory of ['crates/dbstudio-core/src', 'crates/dbstudio-drivers/src']) {
  for (const file of sourceFiles(join(root, directory))) {
    const source = readFileSync(file, 'utf8')
    assert.ok(!/Command::new\s*\(\s*"(?:node|electron|pnpm|npm)"/.test(source), 'native business code must not delegate to a JavaScript runtime')
  }
}
const config = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
assert.equal(config.build.frontendDist, '../dist/desktop')
assert.equal(config.app.withGlobalTauri, false)
assert.ok(!config.app.security.csp.includes('unsafe-eval'), 'desktop CSP must not permit arbitrary evaluation')
console.log('Native architecture: workspace dependency direction, Vue boundary and production shell configuration passed')
