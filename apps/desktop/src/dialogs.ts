import { shallowRef } from 'vue'

export interface DecisionOption { value: string; label: string; danger?: boolean }
export interface DecisionDialog { title: string; message: string; options: DecisionOption[]; settle(value: string): void }
export const decision = shallowRef<DecisionDialog | null>(null)

export function askDecision(title: string, message: string, options: DecisionOption[]): Promise<string> {
  if (decision.value) return Promise.resolve('cancel')
  return new Promise((resolve) => {
    decision.value = {
      title, message, options,
      settle(value) { decision.value = null; resolve(value) }
    }
  })
}

export async function confirmAction(title: string, message: string): Promise<boolean> {
  return await askDecision(title, message, [
    { value: 'confirm', label: '确认', danger: true },
    { value: 'cancel', label: '取消' }
  ]) === 'confirm'
}
