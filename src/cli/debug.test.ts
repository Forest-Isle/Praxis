import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createCliDebugSink } from './debug.js'

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

describe('CLI debug sink', () => {
  it('writes filtered runtime events and waits for nested parent creation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-debug-'))
    roots.push(root)
    const lines: string[] = []
    const debug = createCliDebugSink(() => undefined, {
      cwd: root,
      file: 'nested/debug.jsonl',
      filter: 'tool-result',
      stderr: (line) => lines.push(line),
    })
    debug.eventSink({
      type: 'state',
      state: 'awaiting-model',
    })
    debug.eventSink({
      type: 'tool-result',
      callId: 'call-1',
      content: 'done',
      isError: false,
    })
    await debug.close()
    const content = await readFile(join(root, 'nested/debug.jsonl'), 'utf8')
    expect(content).toContain('"type":"tool-result"')
    expect(content).not.toContain('awaiting-model')
    expect(lines).toHaveLength(1)
  })

  it('redacts sensitive values before writing diagnostic output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-debug-secret-'))
    roots.push(root)
    const secret = 'debug-secret-canary'
    vi.stubEnv('PRAXIS_TEST_API_KEY', secret)
    const events: unknown[] = []
    const lines: string[] = []
    const debug = createCliDebugSink((event) => events.push(event), {
      cwd: root,
      file: 'debug.jsonl',
      stderr: (line) => lines.push(line),
    })

    debug.eventSink({ type: 'warning', message: `provider echoed ${secret}` })
    await debug.close()

    const content = await readFile(join(root, 'debug.jsonl'), 'utf8')
    expect(events).toEqual([
      { type: 'warning', message: `provider echoed ${secret}` },
    ])
    expect(content).toContain('[REDACTED]')
    expect(content).not.toContain(secret)
    expect(lines.join('')).toContain('[REDACTED]')
    expect(lines.join('')).not.toContain(secret)
  })
})
