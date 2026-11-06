import type { TreeNode } from './workbench'

export const TREE_ROW_HEIGHT = 32
export const TREE_OVERSCAN = 8
export const CONNECTION_COLORS = ['default', 'blue', 'green', 'amber', 'purple', 'red'] as const
export type ConnectionColor = typeof CONNECTION_COLORS[number]
export interface ConnectionPreference { color: ConnectionColor; group: string; identity: string }
export type ConnectionPreferences = Record<string, ConnectionPreference>
export const TREE_PREFERENCES_KEY = 'dbstudio.connection-display.v1'
export interface PreferenceStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export type TreeRow =
  | { kind: 'node'; key: string; depth: number; node: TreeNode; parent: TreeNode | null }
  | { kind: 'group'; key: string; depth: number; name: string; expanded: boolean }
  | { kind: 'message'; key: string; depth: number; text: string; error: boolean }

export function rootConnectionId(node: TreeNode): string | null {
  return node.ref.kind === 'connection' && node.ref.id.startsWith('connection:') && !node.ref.id.includes('|')
    ? node.ref.id.slice('connection:'.length) : null
}

// Bind preferences to an exact ID and display identity, never names, array indexes or another owner.
export function connectionIdentity(node: TreeNode): string {
  return JSON.stringify([node.ref.name, node.ref.meta?.dialect ?? ''])
}

export function loadConnectionPreferences(storage: PreferenceStorage | null): ConnectionPreferences {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(TREE_PREFERENCES_KEY) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const output: ConnectionPreferences = Object.create(null)
    for (const [id, raw] of Object.entries(parsed)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !id) continue
      const value = raw as Partial<ConnectionPreference>
      if (!CONNECTION_COLORS.includes(value.color as ConnectionColor) || typeof value.group !== 'string' || typeof value.identity !== 'string') continue
      output[id] = { color: value.color as ConnectionColor, group: value.group.slice(0, 80), identity: value.identity }
    }
    return output
  } catch { return {} }
}

export function preferenceFor(node: TreeNode, preferences: ConnectionPreferences): ConnectionPreference {
  const id = rootConnectionId(node)
  const saved = id === null ? undefined : preferences[id]
  return saved?.identity === connectionIdentity(node)
    ? saved : { color: 'default', group: '', identity: connectionIdentity(node) }
}

export function pruneConnectionPreferences(roots: readonly TreeNode[], preferences: ConnectionPreferences): ConnectionPreferences {
  const output: ConnectionPreferences = Object.create(null)
  for (const node of roots) {
    const id = rootConnectionId(node)
    if (id !== null && Object.prototype.hasOwnProperty.call(preferences, id) && preferences[id]?.identity === connectionIdentity(node)) {
      output[id] = { ...preferences[id]! }
    }
  }
  return output
}

export function canPruneConnectionPreferences(metadataReady: boolean, booting: boolean): boolean {
  return metadataReady && !booting
}

/** Search loaded metadata only. It never calls backend or implicitly expands a database. */
export function flattenTree(
  roots: readonly TreeNode[],
  search = '',
  preferences: ConnectionPreferences = {},
  collapsedGroups: ReadonlySet<string> = new Set()
): TreeRow[] {
  const needle = search.trim().toLocaleLowerCase()
  const matches = new Set<TreeNode>()
  if (needle) {
    const visit = (nodes: readonly TreeNode[]): boolean => {
      let anyMatch = false
      for (const node of nodes) {
        const childMatch = node.loaded ? visit(node.children) : false
        if (node.ref.name.toLocaleLowerCase().includes(needle) || childMatch) {
          matches.add(node)
          anyMatch = true
        }
      }
      return anyMatch
    }
    visit(roots)
  }
  const rows: TreeRow[] = []
  const append = (nodes: readonly TreeNode[], depth: number, parent: TreeNode | null) => {
    for (const node of nodes) {
      if (needle && !matches.has(node)) continue
      rows.push({ kind: 'node', key: node.ref.id, node, depth, parent })
      if (node.error) rows.push({ kind: 'message', key: `${node.ref.id}:error`, depth: depth + 1, text: node.error, error: true })
      if (needle) {
        if (node.loaded) append(node.children, depth + 1, node)
        continue
      }
      if (!node.expanded) continue
      append(node.children, depth + 1, node)
      if (node.loaded && !node.loading && !node.children.length) {
        rows.push({ kind: 'message', key: `${node.ref.id}:empty`, depth: depth + 1, text: '无子对象', error: false })
      }
    }
  }
  const groups = new Map<string, TreeNode[]>()
  for (const node of roots) {
    if (needle && !matches.has(node)) continue
    const name = preferenceFor(node, preferences).group
    const group = groups.get(name) ?? []
    group.push(node)
    groups.set(name, group)
  }
  if (groups.has('')) append(groups.get('')!, 0, null)
  for (const [name, nodes] of groups) {
    if (!name) continue
    const expanded = Boolean(needle) || !collapsedGroups.has(name)
    rows.push({ kind: 'group', key: `display-group:${name}`, depth: 0, name, expanded })
    if (expanded) append(nodes, 1, null)
  }
  return rows
}

export function treeWindow(rowCount: number, scrollTop: number, height: number) {
  const start = Math.max(0, Math.min(rowCount, Math.floor(Math.max(0, scrollTop) / TREE_ROW_HEIGHT) - TREE_OVERSCAN))
  const end = Math.min(rowCount, start + Math.ceil(Math.max(TREE_ROW_HEIGHT, height) / TREE_ROW_HEIGHT) + TREE_OVERSCAN * 2)
  return { start, end, offset: start * TREE_ROW_HEIGHT, total: rowCount * TREE_ROW_HEIGHT }
}
