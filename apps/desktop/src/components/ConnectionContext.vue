<script setup lang="ts">
import { computed } from 'vue'
import { contextQuery, type ConnectionTarget } from '../connection-context'
const props = defineProps<{ target: ConnectionTarget; label: string; snapshot?: boolean; object?: string; invalidated?: boolean }>()
const supported = computed(() => Boolean(contextQuery(props.target.dialectId)))
</script>

<template>
  <div class="connection-context" :aria-label="label">
    <strong>{{ label }} · {{ target.connectionName }}</strong>
    <span v-if="!snapshot">{{ target.connected ? '已连接' : '未连接' }}</span>
    <span v-if="target.configuredDatabase">配置默认库 · {{ target.configuredDatabase }}</span>
    <span v-else-if="supported">配置默认库 · 未设置</span>
    <span v-if="object">对象 · {{ object }}</span>
    <template v-if="supported">
      <span v-if="target.session.status === 'ready'">{{ snapshot ? '执行时会话库' : '最近核实会话库' }} · {{ target.session.database ?? '未选择数据库' }}<template v-if="target.dialectId === 'postgresql'"> · 当前 schema {{ target.session.schema ?? '未选择' }}</template></span>
      <span v-else-if="target.session.status === 'loading'">正在核实会话库…</span>
      <span v-else class="context-warning">{{ snapshot ? '执行时会话库' : '会话库' }} · 未确认{{ target.session.status === 'error' ? '（读取失败，可重试）' : '' }}</span>
    </template>
    <span v-if="invalidated" class="context-warning">结果已失效，请重新打开</span>
    <span v-if="!snapshot && target.dialectId === 'mysql'" class="context-note">USE 影响同连接全部 SQL 标签；配置默认库不会随之修改。</span>
  </div>
</template>

<style scoped>
.connection-context { display:flex; flex-wrap:wrap; align-items:center; gap:6px 16px; padding:8px 12px; border-bottom:1px solid var(--border); font-size:12px; overflow-wrap:anywhere; }
.context-note { flex-basis:100%; color:var(--text-muted); }
.context-warning { color:var(--warning, #b7791f); }
</style>
