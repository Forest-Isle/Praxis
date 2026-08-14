import type { ModelToolCall } from '../../core/runtime.js'

export interface RecentlyDeniedAction {
  id: string
  call: ModelToolCall
  display: string
  reason: string
  sessionId: string
}

export interface RecentlyDeniedStore {
  load(): Promise<readonly RecentlyDeniedAction[]>
  record(action: RecentlyDeniedAction): Promise<readonly RecentlyDeniedAction[]>
  remove(id: string): Promise<readonly RecentlyDeniedAction[]>
}

export function createRecentlyDeniedStore(): RecentlyDeniedStore {
  let entries: RecentlyDeniedAction[] = []
  return {
    async load() {
      return entries
    },
    async record(action) {
      entries = [action, ...entries]
      return entries
    },
    async remove(id) {
      const index = entries.findIndex((entry) => entry.id === id)
      if (index >= 0) entries = entries.toSpliced(index, 1)
      return entries
    },
  }
}
