<script setup lang="ts">
import { ref } from 'vue'
import SqlEditor from '../../src/components/SqlEditor.vue'
import type { Workbench } from '../../src/workbench'
import { SQLITE_SCRIPT_RULES } from '../../../../src/core/sql-script'

const initial = 'SELECT 41 AS from_keyboard;\nSELECT 42 AS from_script;'
const sql = ref(initial)
const disabled = ref(false)
const executions = ref<string[]>([])
// Only refs consumed by the real SqlEditor are supplied; no backend/store is created.
const workbench = {
  sql,
  currentConnection: ref({ id: 'synthetic-dom', name: 'Synthetic DOM', dialectId: 'synthetic' }),
  dialects: ref([{ id: 'synthetic', scriptRules: SQLITE_SCRIPT_RULES }]),
  roots: ref([]), tabs: ref([])
} as unknown as Workbench
function reset() { sql.value = initial; disabled.value = false; executions.value = [] }
</script>

<template>
  <main>
    <h1>SQL 编辑器 DOM 验收夹具</h1>
    <p>仅合成 refs 和 execute 事件；没有 MySQL、Tauri、真实配置或存储。</p>
    <div class="controls"><button data-testid="fixture-reset" @click="reset">重置合成夹具</button><label><input data-testid="fixture-disabled" v-model="disabled" type="checkbox">禁用 SQL 编辑器</label></div>
    <SqlEditor :workbench="workbench" :disabled="disabled" @execute="executions.push($event)" />
    <section aria-label="合成执行事件"><h2>合成执行事件</h2><output data-testid="execute-count">{{ executions.length }}</output><ol><li v-for="(text, index) in executions" :key="index"><pre data-testid="execute-sql">{{ text }}</pre></li></ol></section>
  </main>
</template>

<style>
:root { color-scheme:dark; --bg:#1b1d21; --bg-alt:#23262b; --border:#3a414d; --fg:#e6e8eb; --fg-dim:#9aa3ad; --accent:#4f8cff; --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
* { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 system-ui,sans-serif; } main { max-width:1100px; margin:24px auto; padding:20px; } h1 { font-size:22px; } h2 { font-size:17px; } button { padding:5px 9px; color:var(--fg); background:#2c3139; border:1px solid #48515d; border-radius:4px; cursor:pointer; } button:disabled { opacity:.45; cursor:default; } .controls { display:flex; gap:18px; align-items:center; margin-bottom:18px; }.spacer { flex:1; }.vue-sql-editor { height:270px; flex-basis:auto; }.sql-code textarea:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; } .sql-completions button { color:var(--fg); } [data-testid=execute-count] { display:inline-block; min-width:36px; padding:4px 9px; border:1px solid var(--border); } pre { white-space:pre-wrap; } section[aria-label="合成执行事件"] { margin-top:18px; padding:14px; border:1px solid var(--border); } .is-error { color:#f4a0a0; }
</style>
