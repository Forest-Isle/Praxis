import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ClaudeSessionEnvironment } from './claude-session-environment.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('ClaudeSessionEnvironment', () => {
  it('provides deterministic hook files and reloads exported shell state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-hook-env-'))
    roots.push(root)
    const environment = new ClaudeSessionEnvironment({ stateRoot: root })
    const sessionId = 'session-1'
    const setup = await environment.hookFile(sessionId, 'Setup', 2)
    const cwd = await environment.hookFile(sessionId, 'CwdChanged', 0)
    const file = await environment.hookFile(sessionId, 'FileChanged', 1)
    if (!setup || !cwd || !file) throw new Error('Hook env unsupported')
    await writeFile(setup, 'export ORDER=setup\n')
    await writeFile(cwd, 'export ORDER=cwd\n')
    await writeFile(file, 'export FILE_TOKEN=ready\n')
    environment.invalidate(sessionId)

    await expect(environment.environment(sessionId)).resolves.toEqual({
      ORDER: 'cwd',
      FILE_TOKEN: 'ready',
    })
    await environment.clearCwdFiles(sessionId)
    await expect(environment.environment(sessionId)).resolves.toEqual({
      ORDER: 'setup',
    })
    await expect(readFile(cwd, 'utf8')).resolves.toBe('')
    await expect(readFile(file, 'utf8')).resolves.toBe('')
  })

  it('ignores executable shell content and isolates sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-hook-env-'))
    roots.push(root)
    const warnings: string[] = []
    const environment = new ClaudeSessionEnvironment({
      stateRoot: root,
      warn: (message) => warnings.push(message),
    })
    const first = await environment.hookFile('session-a', 'SessionStart', 0)
    const second = await environment.hookFile('session-b', 'SessionStart', 0)
    if (!first || !second) throw new Error('Hook env unsupported')
    await writeFile(
      first,
      [
        'export SAFE_TOKEN=ready',
        'touch /tmp/should-not-run',
        'export SUBSTITUTION="$(touch /tmp/should-not-run)"',
      ].join('\n'),
    )
    await writeFile(second, 'export OTHER_TOKEN=isolated\n')
    environment.invalidate('session-a')
    environment.invalidate('session-b')

    await expect(environment.environment('session-a')).resolves.toEqual({
      SAFE_TOKEN: 'ready',
    })
    await expect(environment.environment('session-b')).resolves.toEqual({
      OTHER_TOKEN: 'isolated',
    })
    expect(warnings).toHaveLength(2)
  })
})
