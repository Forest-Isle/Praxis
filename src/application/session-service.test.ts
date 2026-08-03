import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ModelProvider } from '../core/runtime.js'
import { ModelProviderError } from '../core/runtime.js'
import { ClaudeSessionService } from './session-service.js'

const roots: string[] = []

function queuedProvider(responses: string[]): ModelProvider {
  return {
    capabilities: { streaming: true, usage: true },
    async *complete() {
      const response = responses.shift()
      if (!response) throw new Error('Provider response fixture exhausted')
      yield { type: 'text-delta', delta: response }
      yield {
        type: 'usage',
        usage: { inputTokens: 3, outputTokens: 2 },
      }
    },
  }
}

async function createService() {
  const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-test-'))
  roots.push(root)
  const cwd = join(root, 'project')
  const configRoot = join(root, 'config')
  const provider = queuedProvider(['first answer', 'second answer'])
  return {
    configRoot,
    cwd,
    service: new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
    }),
  }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

describe('ClaudeSessionService', () => {
  it('runs, persists, resumes, lists, and forks a text session', async () => {
    const { configRoot, cwd, service } = await createService()

    const first = await service.run('first prompt')
    expect(first.text).toBe('first answer')

    const resumed = await service.resume(first.sessionId, 'second prompt')
    expect(resumed.text).toBe('second answer')
    expect(resumed.sessionId).toBe(first.sessionId)

    const sessions = await service.sessions()
    expect(sessions).toEqual([
      expect.objectContaining({
        sessionId: first.sessionId,
        lastPrompt: 'second prompt',
      }),
    ])

    const forked = await service.fork(first.sessionId)
    expect(forked.sessionId).not.toBe(first.sessionId)
    expect(forked.parentSessionId).toBe(first.sessionId)

    const projectDirectories = await import('../compatibility/claude/paths.js')
    const forkPaths = projectDirectories.resolveClaudePaths({
      configDir: configRoot,
      cwd,
      sessionId: forked.sessionId,
    })
    const source = await readFile(forkPaths.sessionFile, 'utf8')
    expect(source).toContain(`"sessionId":"${forked.sessionId}"`)
    expect(source).not.toContain(`"sessionId":"${first.sessionId}"`)
  })

  it('fails closed for unsupported Claude write versions', async () => {
    const { configRoot, cwd } = await createService()
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '9.0.0',
      provider: queuedProvider(['unused']),
    })

    await expect(service.run('hello')).rejects.toThrow('read-only')
  })

  it('keeps a completed user entry when the provider fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-runtime-test-'))
    roots.push(root)
    const service = new ClaudeSessionService({
      configRoot: join(root, 'config'),
      cwd: join(root, 'project'),
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true },
        async *complete() {
          yield* []
          throw new ModelProviderError('temporary failure', {
            retryable: true,
          })
        },
      },
    })

    await expect(service.run('durable prompt')).rejects.toThrow(
      'temporary failure',
    )
    await expect(service.sessions()).resolves.toEqual([
      expect.objectContaining({ lastPrompt: null }),
    ])
  })

  it('holds one session lease for the complete model turn', async () => {
    const { configRoot, cwd, service } = await createService()
    const origin = await service.run('origin')
    let announceStarted: (() => void) | undefined
    let releaseProvider: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve
    })
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve
    })
    const firstWriter = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: {
        capabilities: { streaming: true, usage: true },
        async *complete() {
          announceStarted?.()
          await providerGate
          yield { type: 'text-delta', delta: 'finished' }
        },
      },
    })
    const competingWriter = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider: queuedProvider(['must not run']),
    })

    const activeTurn = firstWriter.resume(origin.sessionId, 'first writer')
    await started
    await expect(
      competingWriter.resume(origin.sessionId, 'second writer'),
    ).rejects.toThrow('conflict: locked')
    releaseProvider?.()
    await expect(activeTurn).resolves.toMatchObject({ text: 'finished' })
  })
})
