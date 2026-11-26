import type { EditorState } from '@codemirror/state'
import type { Workbench } from './workbench'

export interface EditorSnapshot {
  state: EditorState
  scrollTop: number
  scrollLeft: number
  lineWrapping: boolean
}

// Editor history is local to an open tab; SQL persistence remains owned by the workbench.
const sessions = new WeakMap<Workbench, Map<string, EditorSnapshot>>()

export function editorSnapshots(workbench: Workbench) {
  let snapshots = sessions.get(workbench)
  if (!snapshots) { snapshots = new Map(); sessions.set(workbench, snapshots) }
  const openTabs = new Set(workbench.editorTabs.value.map((tab) => tab.id))
  for (const id of snapshots.keys()) if (!openTabs.has(id)) snapshots.delete(id)
  return snapshots
}
