import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ClaudeFileChangeWatcher,
  type ClaudeFileChangeEvent,
} from './claude-file-change-watcher.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('ClaudeFileChangeWatcher', () => {
  it('reports change/add/unlink and adopts dynamic watch paths', async () => {
    vi.useFakeTimers()
    const existing = new Set(['/workspace/.env'])
    const listeners = new Map<string, (filename: string | null) => void>()
    const closed: string[] = []
    const events: { path: string; event: ClaudeFileChangeEvent }[] = []
    const watcher = new ClaudeFileChangeWatcher({
      cwd: '/workspace',
      staticPaths: ['/workspace/.env'],
      debounceMs: 1,
      pathExists: (path) => existing.has(path),
      watchDirectory: (directory, listener) => {
        listeners.set(directory, listener)
        return {
          close: () => closed.push(directory),
          on() {
            return this
          },
          unref: () => undefined,
        }
      },
      onFileChanged: async (path, event) => {
        events.push({ path, event })
        return path === '/workspace/.env' ? ['/workspace/generated'] : undefined
      },
      warn: vi.fn(),
    })

    listeners.get('/workspace')?.('.env')
    await vi.advanceTimersByTimeAsync(1)
    expect(events).toEqual([{ path: '/workspace/.env', event: 'change' }])

    existing.add('/workspace/generated')
    listeners.get('/workspace')?.('generated')
    await vi.advanceTimersByTimeAsync(1)
    existing.delete('/workspace/generated')
    listeners.get('/workspace')?.('generated')
    await vi.advanceTimersByTimeAsync(1)

    expect(events).toEqual([
      { path: '/workspace/.env', event: 'change' },
      { path: '/workspace/generated', event: 'add' },
      { path: '/workspace/generated', event: 'unlink' },
    ])
    await watcher.close()
    expect(closed.length).toBeGreaterThan(0)
  })

  it('rejects relative dynamic paths and surfaces watcher failures', async () => {
    const warnings: string[] = []
    let errorListener: ((error: Error) => void) | undefined
    const watcher = new ClaudeFileChangeWatcher({
      cwd: '/workspace',
      staticPaths: ['/workspace/.env'],
      pathExists: () => true,
      watchDirectory: () => ({
        close: () => undefined,
        on(_event, listener) {
          errorListener = listener
          return this
        },
      }),
      onFileChanged: async () => undefined,
      warn: (message) => warnings.push(message),
    })

    watcher.updateDynamicPaths(['relative.env'])
    errorListener?.(new Error('watch failed'))
    expect(warnings).toEqual([
      'FileChanged hook ignored non-absolute watch path: relative.env',
      'FileChanged watcher failed for /workspace: watch failed',
    ])
    await watcher.close()
  })

  it('aborts and abandons a non-cooperative in-flight hook at close deadline', async () => {
    vi.useFakeTimers()
    let listener: ((filename: string | null) => void) | undefined
    let hookSignal: AbortSignal | undefined
    const watcher = new ClaudeFileChangeWatcher({
      cwd: '/workspace',
      staticPaths: ['/workspace/.env'],
      debounceMs: 1,
      pathExists: () => true,
      watchDirectory: (_directory, nextListener) => {
        listener = nextListener
        return {
          close: () => undefined,
          on() {
            return this
          },
        }
      },
      onFileChanged: async (_path, _event, signal) => {
        hookSignal = signal
        await new Promise(() => undefined)
        return undefined
      },
      warn: vi.fn(),
    })

    listener?.('.env')
    await vi.advanceTimersByTimeAsync(1)
    const closing = watcher.close(10)
    await vi.advanceTimersByTimeAsync(10)
    await closing
    expect(hookSignal?.aborted).toBe(true)
  })
})
