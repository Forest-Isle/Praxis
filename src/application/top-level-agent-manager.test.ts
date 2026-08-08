import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ClaudeJobStore,
  type ClaudeJobState,
} from '../persistence/claude-job-store.js'
import {
  runTopLevelAgentWorker,
  TopLevelAgentManager,
  type TopLevelAgentRuntime,
} from './top-level-agent-manager.js'
import type { SessionRunResult } from './session-service.js'

const roots: string[] = []

async function fixture() {
  const configRoot = await mkdtemp(join(tmpdir(), 'praxis-top-agent-'))
  roots.push(configRoot)
  const cwd = join(configRoot, 'work')
  const id = 'abcd1234'
  const sessionId = `${id}-1111-4111-8111-111111111111`
  const now = new Date().toISOString()
  const state: ClaudeJobState = {
    state: 'working',
    detail: 'starting',
    tempo: 'active',
    inFlight: { tasks: 1, queued: 0, kinds: ['prompt'] },
    tokens: 0,
    output: null,
    children: null,
    template: 'bg',
    respawnFlags: ['initial prompt'],
    intent: 'initial prompt',
    sessionId,
    resumeSessionId: sessionId,
    daemonShort: id,
    cliVersion: '0.1.0',
    cwd,
    backend: 'daemon',
    praxisOwner: 1,
    createdAt: now,
    updatedAt: now,
    firstTerminalAt: null,
    socketPath: join(configRoot, 'control.sock'),
    controlToken: 'fixture-control-token',
  }
  const store = new ClaudeJobStore(configRoot)
  await store.create(state, {
    version: 1,
    argv: ['initial prompt'],
    resume: false,
  })
  const manager = new TopLevelAgentManager({
    configRoot,
    cwd,
    cliPath: '/unused',
    version: '0.1.0',
  })
  return { configRoot, cwd, id, sessionId, store, manager }
}

async function waitFor(
  condition: () => Promise<boolean>,
  timeout = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeout
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true })),
  )
})

describe('TopLevelAgentManager', () => {
  it('keeps a completed turn idle, accepts attached continuation, logs, and stops', async () => {
    const fixtureState = await fixture()
    const calls: string[] = []
    const runtime: TopLevelAgentRuntime = {
      async run(prompt, _signal, sessionId) {
        calls.push(`run:${sessionId}:${prompt}`)
        return {
          sessionId,
          text: 'INITIAL_RESULT',
          usage: { inputTokens: 1, outputTokens: 2 },
        }
      },
      async resume(sessionId, prompt) {
        calls.push(`resume:${sessionId}:${prompt}`)
        return {
          sessionId,
          text: 'CONTINUED_RESULT',
          usage: { inputTokens: 2, outputTokens: 2 },
        }
      },
    }
    const worker = runTopLevelAgentWorker({
      configRoot: fixtureState.configRoot,
      id: fixtureState.id,
      async createRuntime() {
        return runtime
      },
    })
    await waitFor(
      async () =>
        (await fixtureState.store.read(fixtureState.id)).tempo === 'idle',
    )
    await waitFor(async () => {
      const processState = JSON.parse(
        await readFile(
          join(fixtureState.configRoot, 'sessions', `${process.pid}.json`),
          'utf8',
        ),
      )
      return processState.status === 'idle'
    })

    await expect(
      fixtureState.manager.list({ cwd: fixtureState.cwd, all: false }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: fixtureState.id,
        sessionId: fixtureState.sessionId,
        status: 'idle',
        state: 'working',
      }),
    ])
    const attached: string[] = []
    await fixtureState.manager.attach(
      fixtureState.id,
      (async function* () {
        yield 'continue work\n'
      })(),
      (text) => attached.push(text),
    )
    expect(attached.join('')).toContain('INITIAL_RESULT')
    expect(calls).toEqual([
      `run:${fixtureState.sessionId}:initial prompt`,
      `resume:${fixtureState.sessionId}:continue work`,
    ])
    await expect(fixtureState.manager.logs(fixtureState.id)).resolves.toContain(
      'CONTINUED_RESULT',
    )

    await fixtureState.manager.stop(fixtureState.id)
    await worker
    await expect(
      readFile(
        join(fixtureState.configRoot, 'sessions', `${process.pid}.json`),
        'utf8',
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      fixtureState.manager.list({ cwd: fixtureState.cwd, all: true }),
    ).resolves.toEqual([
      expect.objectContaining({ id: fixtureState.id, state: 'stopped' }),
    ])
  })

  it('exposes partial output through logs while a turn is still active', async () => {
    const fixtureState = await fixture()
    let finish: ((result: SessionRunResult) => void) | undefined
    const worker = runTopLevelAgentWorker({
      configRoot: fixtureState.configRoot,
      id: fixtureState.id,
      async createRuntime(eventSink) {
        return {
          run: async () => {
            eventSink({ type: 'text-delta', delta: 'PARTIAL' })
            return new Promise((resolveRun) => {
              finish = resolveRun
            })
          },
          async resume() {
            throw new Error('unused')
          },
        }
      },
    })
    await waitFor(
      async () =>
        (await fixtureState.manager.logs(fixtureState.id)) === 'PARTIAL',
    )
    expect((await fixtureState.store.read(fixtureState.id)).tempo).toBe(
      'active',
    )
    finish?.({
      sessionId: fixtureState.sessionId,
      text: 'PARTIAL',
      usage: { inputTokens: 1, outputTokens: 1 },
    })
    await waitFor(
      async () =>
        (await fixtureState.store.read(fixtureState.id)).tempo === 'idle',
    )
    await expect(fixtureState.manager.logs(fixtureState.id)).resolves.toBe(
      'PARTIAL\n',
    )

    await fixtureState.manager.stop(fixtureState.id)
    await worker
  })

  it('repairs stale working state and filters by cwd and --all semantics', async () => {
    const fixtureState = await fixture()
    await fixtureState.store.update(fixtureState.id, (state) => ({
      ...state,
      pid: 2_147_483_647,
    }))

    await expect(
      fixtureState.manager.list({
        cwd: join(fixtureState.cwd, 'other'),
        all: true,
      }),
    ).resolves.toEqual([])
    await expect(
      fixtureState.manager.list({ cwd: fixtureState.cwd, all: false }),
    ).resolves.toEqual([])
    await expect(
      fixtureState.manager.list({ cwd: fixtureState.cwd, all: true }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: fixtureState.id,
        state: 'failed',
      }),
    ])
  })

  it('lists Praxis history and native Claude sessions across CWDs unless filtered', async () => {
    const fixtureState = await fixture()
    const otherCwd = join(fixtureState.configRoot, 'other')
    await mkdir(otherCwd)
    await mkdir(join(fixtureState.configRoot, 'sessions'))
    await writeFile(
      join(fixtureState.configRoot, 'sessions', '12345.json'),
      JSON.stringify({
        pid: 12345,
        sessionId: 'native-session',
        cwd: otherCwd,
        startedAt: 1,
        kind: 'interactive',
        name: 'native Claude session',
        status: 'idle',
      }),
    )
    await fixtureState.store.update(fixtureState.id, (state) => ({
      ...state,
      state: 'stopped',
      tempo: 'idle',
      firstTerminalAt: new Date().toISOString(),
    }))

    await expect(fixtureState.manager.list({ all: false })).resolves.toEqual([
      expect.objectContaining({
        cwd: otherCwd,
        kind: 'interactive',
        sessionId: 'native-session',
        status: 'idle',
      }),
    ])
    await expect(fixtureState.manager.list({ all: true })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: fixtureState.id, state: 'stopped' }),
        expect.objectContaining({ sessionId: 'native-session' }),
      ]),
    )
    await expect(
      fixtureState.manager.list({ cwd: fixtureState.cwd, all: true }),
    ).resolves.toEqual([
      expect.objectContaining({ id: fixtureState.id, cwd: fixtureState.cwd }),
    ])
  })

  it('does not resurrect a job stopped while its runtime is initializing', async () => {
    const fixtureState = await fixture()
    let releaseRuntime: ((runtime: TopLevelAgentRuntime) => void) | undefined
    const worker = runTopLevelAgentWorker({
      configRoot: fixtureState.configRoot,
      id: fixtureState.id,
      createRuntime: () =>
        new Promise((resolveRuntime) => {
          releaseRuntime = resolveRuntime
        }),
    })
    await waitFor(async () => releaseRuntime !== undefined)
    await fixtureState.manager.stop(fixtureState.id)
    releaseRuntime?.({
      async run() {
        throw new Error('must not run')
      },
      async resume() {
        throw new Error('must not resume')
      },
    })

    await worker
    const stopped = await fixtureState.store.read(fixtureState.id)
    expect(stopped.state).toBe('stopped')
    expect(stopped).not.toHaveProperty('pid')
    expect(stopped).not.toHaveProperty('socketPath')
  })

  it('records asynchronous spawn failures without leaving control credentials', async () => {
    const configRoot = await mkdtemp(join(tmpdir(), 'praxis-top-agent-spawn-'))
    roots.push(configRoot)
    const cwd = join(configRoot, 'missing-cwd')
    const manager = new TopLevelAgentManager({
      configRoot,
      cwd,
      cliPath: '/missing-cli',
      executablePath: '/missing-executable',
      version: '0.1.0',
    })

    await expect(
      manager.launch({ prompt: 'must fail', argv: ['must fail'] }),
    ).rejects.toThrow('Could not start background agent')
    const [failed] = await new ClaudeJobStore(configRoot).list()
    expect(failed?.state).toBe('failed')
    expect(failed).not.toHaveProperty('pid')
    expect(failed).not.toHaveProperty('socketPath')
    expect(failed).not.toHaveProperty('controlToken')
  })

  it('passes only the worker runtime environment contract to detached workers', async () => {
    const configRoot = await mkdtemp(join(tmpdir(), 'praxis-top-agent-env-'))
    roots.push(configRoot)
    const cwd = join(configRoot, 'work')
    await mkdir(cwd)
    const outputPath = join(configRoot, 'environment.json')
    const scriptPath = join(configRoot, 'worker.mjs')
    await writeFile(
      scriptPath,
      `import { writeFile } from 'node:fs/promises'
await writeFile(${JSON.stringify(outputPath)}, JSON.stringify(process.env))
`,
    )
    const manager = new TopLevelAgentManager({
      configRoot,
      cwd,
      cliPath: scriptPath,
      executablePath: process.execPath,
      environment: {
        PATH: process.env.PATH ?? '',
        PRAXIS_API_KEY: 'worker-provider-secret',
        PRAXIS_MODEL: 'worker-model',
        AWS_SECRET_ACCESS_KEY: 'ambient-secret',
        BASH_ENV: '/tmp/untrusted-startup',
        PRAXIS_TEST_SECRET: 'unrelated-secret',
      },
      version: '0.1.0',
    })

    await manager.launch({ prompt: 'capture environment', argv: [] })
    let capturedEnvironment: Record<string, string | undefined> | undefined
    await waitFor(async () => {
      try {
        capturedEnvironment = JSON.parse(
          await readFile(outputPath, 'utf8'),
        ) as Record<string, string | undefined>
        return true
      } catch {
        return false
      }
    })
    const environment = capturedEnvironment as Record<
      string,
      string | undefined
    >
    expect(environment.PRAXIS_API_KEY).toBe('worker-provider-secret')
    expect(environment.PRAXIS_MODEL).toBe('worker-model')
    expect(environment.PATH).toBe(process.env.PATH ?? '')
    expect(environment.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(environment.BASH_ENV).toBeUndefined()
    expect(environment.PRAXIS_TEST_SECRET).toBeUndefined()
    expect(environment.CLAUDE_CONFIG_DIR).toBe(configRoot)
  })

  it('records runtime initialization failures immediately', async () => {
    const fixtureState = await fixture()

    await runTopLevelAgentWorker({
      configRoot: fixtureState.configRoot,
      id: fixtureState.id,
      async createRuntime() {
        throw new Error('provider setup failed')
      },
    })

    const failed = await fixtureState.store.read(fixtureState.id)
    expect(failed).toMatchObject({
      state: 'failed',
      detail: 'provider setup failed',
    })
    expect(failed).not.toHaveProperty('pid')
    await expect(fixtureState.manager.logs(fixtureState.id)).resolves.toBe(
      'provider setup failed\n',
    )
  })

  it('redacts provider secrets from background output and failure state', async () => {
    const fixtureState = await fixture()
    const secret = 'background-provider-secret-canary'
    vi.stubEnv('PRAXIS_TEST_API_KEY', secret)
    const worker = runTopLevelAgentWorker({
      configRoot: fixtureState.configRoot,
      id: fixtureState.id,
      async createRuntime(eventSink) {
        return {
          async run(_sessionPrompt, _signal, sessionId) {
            eventSink({ type: 'text-delta', delta: `delta ${secret}` })
            return {
              sessionId,
              text: `result ${secret}`,
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume() {
            throw new Error('unused')
          },
        }
      },
    })
    await waitFor(
      async () =>
        (await fixtureState.store.read(fixtureState.id)).tempo === 'idle',
    )
    const logs = await fixtureState.manager.logs(fixtureState.id)
    expect(logs).toContain('[REDACTED]')
    expect(logs).not.toContain(secret)
    expect(
      (await fixtureState.store.read(fixtureState.id)).detail,
    ).not.toContain(secret)
    await fixtureState.manager.stop(fixtureState.id)
    await worker
  })
})
