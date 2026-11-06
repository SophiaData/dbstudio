<script setup lang="ts">
import type { Workbench, TreeNode } from '../workbench'
const props = withDefaults(defineProps<{ workbench: Workbench; nodes: TreeNode[]; depth?: number; search?: string }>(), { depth: 0, search: '' })
function visible(node: TreeNode): boolean {
  return !props.search || node.ref.name.toLowerCase().includes(props.search.toLowerCase()) || node.children.some(visible)
}
function activate(node: TreeNode) {
  props.workbench.selectNode(node.ref)
  if (node.ref.kind === 'table' || node.ref.kind === 'view') void props.workbench.attempt(() => props.workbench.openTable(node.ref))
  else void props.workbench.attempt(() => props.workbench.toggleNode(node))
}
</script>

<template>
  <template v-for="node in nodes" :key="node.ref.id">
    <div v-if="visible(node)" role="treeitem" :aria-expanded="node.ref.hasChildren ? node.expanded : undefined" :aria-selected="workbench.selected.value?.id === node.ref.id" :aria-level="depth + 1">
      <div class="tree-row" :class="{ 'is-selected': workbench.selected.value?.id === node.ref.id }" :style="{ paddingLeft: `${8 + depth * 16}px` }" :data-node-id="node.ref.id" tabindex="0" @click="workbench.selectNode(node.ref)" @dblclick="activate(node)" @keydown.enter="activate(node)" @keydown.right.prevent="!node.expanded && workbench.attempt(() => workbench.toggleNode(node))" @keydown.left.prevent="node.expanded && workbench.attempt(() => workbench.toggleNode(node))">
        <button v-if="node.ref.hasChildren" class="twisty" :aria-label="node.expanded ? '折叠' : '展开'" :disabled="node.loading" @click.stop="workbench.attempt(() => workbench.toggleNode(node))">{{ node.loading ? '…' : node.expanded ? '▾' : '▸' }}</button><span v-else class="twisty-space" />
        <span class="node-icon" aria-hidden="true">{{ node.ref.kind === 'connection' ? node.ref.meta?.connected ? '●' : '○' : node.ref.kind === 'table' ? '▦' : node.ref.kind === 'view' ? '▤' : '▱' }}</span>
        <span class="row-label" :title="node.ref.name">{{ node.ref.name }}</span>
      </div>
      <p v-if="node.error" class="tree-error is-error">{{ node.error }}</p>
      <div v-if="node.expanded" role="group"><TreeBranch :workbench="workbench" :nodes="node.children" :depth="depth + 1" :search="search" /><p v-if="node.loaded && !node.children.length" class="muted" :style="{ paddingLeft: `${30 + depth * 16}px` }">无子对象</p></div>
    </div>
  </template>
</template>
