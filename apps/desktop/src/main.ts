import { createApp } from 'vue'
import './style.css'

async function trace(stage: import('./mysql-parity-dom').StartupStage) {
  if (import.meta.env.VITE_MYSQL_PARITY === '1') {
    try { const { traceMysqlStartup } = await import('./mysql-parity-dom'); await traceMysqlStartup(stage) }
    catch { /* Keep diagnostics independent from the original startup error. */ }
  }
}
async function start() {
  if (import.meta.env.VITE_MYSQL_PARITY === '1') await trace('main_enter')
  if (import.meta.env.VITE_MYSQL_PARITY === '1') {
    const { preflightMysqlParity } = await import('./mysql-parity-dom')
    await preflightMysqlParity()
  }
  if (import.meta.env.VITE_MYSQL_PARITY === '1') await trace('preflight_passed')
  if (import.meta.env.VITE_MYSQL_PARITY === '1') await trace('app_import_enter')
  const { default: App } = await import('./App.vue')
  if (import.meta.env.VITE_MYSQL_PARITY === '1') await trace('app_import_passed')
  if (import.meta.env.VITE_MYSQL_PARITY === '1') await trace('app_mount_enter')
  createApp(App).mount('#app')
}
void start().catch(async (error) => {
  if (import.meta.env.VITE_MYSQL_PARITY !== '1') {
    console.error(error)
    throw error
  }
  await trace('main_failed')
  // Fail closed before mounting; never render native errors, paths, or storage contents.
  const root = document.getElementById('app')
  if (root) root.textContent = '应用启动预检失败'
})
