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
const desktopFeatures = packages.get('dbstudio-desktop').features
for (const feature of ['mysql-acceptance', 'test-hooks']) {
  assert.ok(Object.hasOwn(desktopFeatures, feature), `${feature} must be an explicit opt-in feature`)
  assert.ok(!(desktopFeatures.default ?? []).includes(feature), `${feature} must not be enabled by default`)
}

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
const productionBuild = readFileSync(join(root, 'scripts/build-native-desktop.mjs'), 'utf8')
assert.match(productionBuild, /VITE_DBSTUDIO_TEST_HOOKS:\s*'0'/, 'production wrapper must disable native test hooks')
assert.match(productionBuild, /VITE_MYSQL_PARITY:\s*'0'/, 'production wrapper must disable MySQL parity mode')
for (const marker of ["'mysqlAcceptance'", "'__DBSTUDIO_MYSQL_ACCEPTANCE_'"]) {
  assert.ok(productionBuild.includes(marker), `production wrapper must reject the ${marker} bridge marker`)
}
const rustShell = readFileSync(join(root, 'src-tauri/src/lib.rs'), 'utf8')
const run = rustShell.indexOf('pub fn run()')
const gate = rustShell.indexOf('#[cfg(not(feature = "mysql-acceptance"))]\n    if mysql_mode_environment_present()', run)
const context = rustShell.indexOf('let context = tauri::generate_context!();', run)
const application = rustShell.indexOf('Application::open_with_legacy', run)
const window = rustShell.indexOf('tauri::WebviewWindowBuilder::new', run)
assert.ok(run >= 0 && gate > run, 'production Rust must gate MySQL acceptance environment at startup')
assert.ok(context > gate && application > gate && window > gate, 'production Rust must reject MySQL environment before context, application or window creation')
assert.match(rustShell.slice(gate, context), /std::process::exit\(2\)/, 'production MySQL environment gate must fail closed')
assert.ok(rustShell.includes('std::env::var_os(name).is_some()'), 'MySQL environment guard must inspect the operating system environment')
console.log('Native architecture: workspace dependency direction, Vue boundary and production shell configuration passed')
