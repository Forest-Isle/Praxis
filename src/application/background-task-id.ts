import { randomBytes } from 'node:crypto'

const BACKGROUND_BASH_TASK_ID_PATTERN = /^b[a-z0-9]{8}$/u

export function isBackgroundBashTaskId(taskId: string): boolean {
  return BACKGROUND_BASH_TASK_ID_PATTERN.test(taskId)
}

export function assertBackgroundBashTaskId(taskId: string): void {
  if (!isBackgroundBashTaskId(taskId)) {
    throw new Error(`Invalid background Bash task ID: ${taskId}`)
  }
}

export function createBackgroundBashTaskId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = randomBytes(8)
  let value = 'b'
  for (const byte of bytes) value += alphabet[byte % alphabet.length]
  return value
}

export function backgroundBashTaskIdFromStateFile(name: string): string | null {
  if (!name.endsWith('.json')) return null
  const taskId = name.slice(0, -'.json'.length)
  return isBackgroundBashTaskId(taskId) ? taskId : null
}
