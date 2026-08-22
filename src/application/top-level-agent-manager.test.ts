import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveClaudePaths } from '../compatibility/claude/paths.js'
import {
  ClaudeJobStore,
  type ClaudeJobState,
} from '../persistence/claude-job-store.js'
import { resolveDataPlanePaths } from '../persistence/data-plane.js'
import {
  runTopLevelAgentWorker,
  topLevelAgentProcessRegistryRoot,
  TopLevelAgentManager,
  type TopLevelAgentRuntime,
} from './top-level-agent-manager.js'
import type { SessionRunResult } from './session-service.js'

const roots: string[] = []

async function fixture(
  options: {
    deferInitialTurn?: boolean
    dataPlane?: 'native' | 'claude'
    sourceSessionId?: string
    sourceCheckpoint?: { resumeSessionAt: string; entryCount: number }
  } = {},
) {
  const configRoot = await mkdtemp(join(tmpdir(), 'praxis-top-agent-'))
  roots.push(configRoot)
  const cwd = join(configRoot, 'work')
  const id = 'abcd1234'
  const sessionId = `${id}-1111-4111-8111-111111111111`
  const now = new Date().toISOString()
  const state: ClaudeJobState = {
    state: 'working',
    detail: options.deferInitialTurn ? 'initial answer' : 'starting',
    tempo: options.deferInitialTurn ? 'blocked' : 'active',
    ...(options.deferInitialTurn
      ? { needs: 'send a prompt to start' }
      : { inFlight: { tasks: 1, queued: 0, kinds: ['prompt'] } }),
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
  const store = new ClaudeJobStore(
    configRoot,
    join(configRoot, options.dataPlane === 'native' ? 'state' : 'praxis'),
  )
  await store.create(state, {
    version: 1,
    argv: ['initial prompt'],
    resume: false,
    ...(options.deferInitialTurn ? { deferInitialTurn: true } : {}),
    ...(options.sourceSessionId === undefined
      ? {}
      : { sourceSessionId: options.sourceSessionId }),
    ...(options.sourceCheckpoint === undefined
      ? {}
      : { sourceCheckpoint: options.sourceCheckpoint }),
  })
  const manager = new TopLevelAgentManager({
    configRoot,
    ...(options.dataPlane ? { dataPlane: options.dataPlane } : {}),
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
  it('registers and cleans up native workers under state/sessions', async () => {
    const fixtureState = await fixture({
      dataPlane: 'native',
      deferInitialTurn: true,
    })
    const registryRoot = topLevelAgentProcessRegistryRoot(
      fixtureState.configRoot,
      'native',
    )
    const processFile = join(registryRoot, `${process.pid}.json`)
    const worker = runTopLevelAgentWorker({
      configRoot: fixtureState.configRoot,
      dataPlane: 'native',
      id: fixtureState.id,
      async createRuntime() {
        return {
          async run() {
            throw new Error('idle worker must not run')
          },
          async resume() {
            throw new Error('idle worker must not resume')
          },
        }
      },
    })
    await waitFor(async () => {
      try {
        return (
          (
            JSON.parse(await readFile(processFile, 'utf8')) as {
              status?: string
            }
          ).status === 'idle'
        )
      } catch {
        return false
      }
    })

    await expect(
      access(join(fixtureState.configRoot, 'sessions', `${process.pid}.json`)),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      fixtureState.manager.list({ cwd: fixtureState.cwd, all: false }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: fixtureState.id,
        state: 'working',
        status: 'idle',
      }),
    ])

    await fixtureState.manager.stop(fixtureState.id)
    await worker
    await expect(access(processFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('lazily forks a foreground session when an idle handoff first attaches', async () => {
    const sourceSessionId = '99999999-9999-4999-8999-999999999999'
    const sourceCheckpoint = {
      resumeSessionAt: '88888888-8888-4888-8888-888888888888',
      entryCount: 4,
    }
    const fixtureState = await fixture({
      deferInitialTurn: true,
      sourceSessionId,
      sourceCheckpoint,
    })
    const calls: string[] = []
    const worker = runTopLevelAgentWorker({
      configRoot: fixtureState.configRoot,
      id: fixtureState.id,
      async createRuntime() {
        return {
          async run() {
            throw new Error('must not start an initial provider turn')
          },
          async resume(sessionId, prompt) {
            calls.push(`resume:${sessionId}:${prompt}`)
            return {
              sessionId,
              text: 'CONTINUED',
              usage: { inputTokens: 2, outputTokens: 1 },
            }
          },
          async ensureFork(parentSessionId, targetSessionId, checkpoint) {
            calls.push(
              `ensureFork:${parentSessionId}:${targetSessionId}:${JSON.stringify(checkpoint)}`,
            )
            return {
              parentSessionId,
              sessionId: targetSessionId,
            }
          },
        }
      },
    })
    await waitFor(async () => {
      try {
        const processState = JSON.parse(
          await readFile(
            join(fixtureState.configRoot, 'sessions', `${process.pid}.json`),
            'utf8',
          ),
        )
        return processState.status === 'idle'
      } catch {
        return false
      }
    })
    expect(calls).toEqual([])
    await expect(
      fixtureState.manager.list({ cwd: fixtureState.cwd, all: false }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: fixtureState.id,
        status: 'idle',
        state: 'working',
        tempo: 'blocked',
        needs: 'send a prompt to start',
      }),
    ])

    const output: string[] = []
    await fixtureState.manager.attach(
      fixtureState.id,
      (async function* () {
        yield 'continue after handoff\n'
      })(),
      (text) => output.push(text),
    )

    expect(calls).toEqual([
      `ensureFork:${sourceSessionId}:${fixtureState.sessionId}:${JSON.stringify(sourceCheckpoint)}`,
      `resume:${fixtureState.sessionId}:continue after handoff`,
    ])
    expect(output.join('')).toContain('CONTINUED')
    await expect
      .poll(() => fixtureState.store.read(fixtureState.id))
      .toMatchObject({ tempo: 'idle', inFlight: { tasks: 0 } })
    expect(
      (await fixtureState.store.read(fixtureState.id)).needs,
    ).toBeUndefined()
    await expect(
      fixtureState.store.readDispatch(fixtureState.id),
    ).resolves.toEqual({
      version: 1,
      argv: ['initial prompt'],
      resume: true,
      deferInitialTurn: true,
      handoffComplete: true,
    })
    await fixtureState.manager.stop(fixtureState.id)
    await worker

    await fixtureState.store.update(fixtureState.id, (state) => ({
      ...state,
      state: 'working',
      detail: 'CONTINUED',
      tempo: 'idle',
      socketPath: join(fixtureState.configRoot, 'control.sock'),
      controlToken: 'fixture-control-token',
      updatedAt: new Date().toISOString(),
    }))
    const restartedCalls: string[] = []
    const restartedWorker = runTopLevelAgentWorker({
      configRoot: fixtureState.configRoot,
      id: fixtureState.id,
      async createRuntime() {
        return {
          async run() {
            throw new Error('must not restart an initial provider turn')
          },
          async resume(sessionId, prompt) {
            restartedCalls.push(`resume:${sessionId}:${prompt}`)
            return {
              sessionId,
              text: 'RESTARTED_CONTINUATION',
              usage: { inputTokens: 2, outputTokens: 1 },
            }
          },
          async ensureFork() {
            throw new Error('must not repeat a completed handoff fork')
          },
        }
      },
    })
    await waitFor(async () => {
      try {
        const processState = JSON.parse(
          await readFile(
            join(fixtureState.configRoot, 'sessions', `${process.pid}.json`),
            'utf8',
          ),
        )
        return processState.status === 'idle'
      } catch {
        return false
      }
    })
    expect(restartedCalls).toEqual([])
    const restartedOutput: string[] = []
    await fixtureState.manager.attach(
      fixtureState.id,
      (async function* () {
        yield 'continue after restart\n'
      })(),
      (text) => restartedOutput.push(text),
    )
    expect(restartedCalls).toEqual([
      `resume:${fixtureState.sessionId}:continue after restart`,
    ])
    expect(restartedOutput.join('')).toContain('RESTARTED_CONTINUATION')
    await fixtureState.manager.stop(fixtureState.id)
    await restartedWorker
  })

  it('waits for a newly launched worker socket before attaching', async () => {
    const fixtureState = await fixture()
    let ran = false
    const attaching = fixtureState.manager.attach(
      fixtureState.id,
      (async function* () {})(),
      () => undefined,
    )
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
    const worker = runTopLevelAgentWorker({
      configRoot: fixtureState.configRoot,
      id: fixtureState.id,
      async createRuntime() {
        return {
          async run(_prompt, _signal, sessionId) {
            ran = true
            return {
              sessionId,
              text: 'STARTED_AFTER_ATTACH',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume() {
            throw new Error('unused')
          },
        }
      },
    })
    await attaching
    await waitFor(
      async () =>
        (await fixtureState.store.read(fixtureState.id)).tempo === 'idle',
    )
    expect(ran).toBe(true)
    await fixtureState.manager.stop(fixtureState.id)
    await worker
  })

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
    const nativeSessionId = 'aaaaaaaa-1111-4111-8111-111111111111'
    await writeFile(
      join(fixtureState.configRoot, 'sessions', '12345.json'),
      JSON.stringify({
        pid: 12345,
        sessionId: nativeSessionId,
        cwd: otherCwd,
        startedAt: 1,
        kind: 'interactive',
        name: 'native Claude session',
        status: 'idle',
      }),
    )
    await writeFile(
      join(fixtureState.configRoot, 'sessions', '12346.json'),
      JSON.stringify({
        id: 'native000',
        sessionId: 'bbbbbbbb-1111-4111-8111-111111111111',
        cwd: otherCwd,
        startedAt: 2,
        kind: 'background',
        name: 'native completed session',
        state: 'done',
      }),
    )
    const nativeTranscript = resolveClaudePaths({
      configDir: fixtureState.configRoot,
      cwd: otherCwd,
      sessionId: nativeSessionId,
    }).sessionFile
    await mkdir(dirname(nativeTranscript), { recursive: true })
    await writeFile(nativeTranscript, 'NATIVE_TRANSCRIPT\n')
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
        sessionId: nativeSessionId,
        status: 'idle',
      }),
    ])
    await expect(fixtureState.manager.list({ all: true })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: fixtureState.id, state: 'stopped' }),
        expect.objectContaining({ sessionId: nativeSessionId }),
        expect.objectContaining({
          id: 'native000',
          sessionId: 'bbbbbbbb-1111-4111-8111-111111111111',
          state: 'done',
        }),
      ]),
    )
    await expect(
      fixtureState.manager.list({ cwd: fixtureState.cwd, all: true }),
    ).resolves.toEqual([
      expect.objectContaining({ id: fixtureState.id, cwd: fixtureState.cwd }),
    ])
    await expect(
      fixtureState.manager.review({
        cwd: otherCwd,
        sessionId: nativeSessionId,
      }),
    ).resolves.toBe('NATIVE_TRANSCRIPT\n')
  })

  it('reviews a native Praxis transcript from the sessions root', async () => {
    const configRoot = await mkdtemp(join(tmpdir(), 'praxis-native-review-'))
    roots.push(configRoot)
    const cwd = join(configRoot, 'work')
    const sessionId = 'aaaaaaaa-1111-4111-8111-111111111111'
    const paths = resolveDataPlanePaths({
      dataPlane: 'native',
      root: configRoot,
      cwd,
      sessionId,
    })
    await mkdir(dirname(paths.sessionFile), { recursive: true })
    await writeFile(paths.sessionFile, 'PRAXIS_NATIVE_TRANSCRIPT\n')
    const manager = new TopLevelAgentManager({
      configRoot,
      dataPlane: 'native',
      cwd,
      cliPath: '/tmp/praxis-cli.js',
      version: '0.1.0',
    })

    await expect(manager.review({ cwd, sessionId })).resolves.toBe(
      'PRAXIS_NATIVE_TRANSCRIPT\n',
    )
  })

  it('lists native process records from state without treating transcripts as registry entries', async () => {
    const fixtureState = await fixture({ dataPlane: 'native' })
    await fixtureState.store.update(fixtureState.id, (state) => ({
      ...state,
      state: 'stopped',
      tempo: 'idle',
      firstTerminalAt: new Date().toISOString(),
    }))
    const processSessionId = 'aaaaaaaa-1111-4111-8111-111111111111'
    const transcriptSessionId = 'bbbbbbbb-1111-4111-8111-111111111111'
    const registryRoot = topLevelAgentProcessRegistryRoot(
      fixtureState.configRoot,
      'native',
    )
    await mkdir(registryRoot, { recursive: true })
    await writeFile(
      join(registryRoot, '12345.json'),
      JSON.stringify({
        pid: 12345,
        sessionId: processSessionId,
        cwd: fixtureState.cwd,
        startedAt: 10,
        kind: 'interactive',
        name: 'native process',
        status: 'idle',
      }),
    )
    const transcriptPath = resolveDataPlanePaths({
      dataPlane: 'native',
      root: fixtureState.configRoot,
      cwd: fixtureState.cwd,
      sessionId: transcriptSessionId,
    }).sessionFile
    await mkdir(dirname(transcriptPath), { recursive: true })
    await writeFile(
      transcriptPath.replace(/\.jsonl$/u, '.json'),
      JSON.stringify({
        pid: 12346,
        sessionId: transcriptSessionId,
        cwd: fixtureState.cwd,
        startedAt: 11,
        kind: 'interactive',
        name: 'transcript-shaped record',
        status: 'idle',
      }),
    )

    const listed = await fixtureState.manager.list({ all: true })
    expect(
      listed.some((session) => session.sessionId === processSessionId),
    ).toBe(true)
    expect(
      listed.some((session) => session.sessionId === transcriptSessionId),
    ).toBe(false)
  })

  it('lists native Claude bg/daemon registry records and rejects unknown or malformed ones', async () => {
    const fixtureState = await fixture()
    const sessionsDir = join(fixtureState.configRoot, 'sessions')
    await mkdir(sessionsDir)
    const base = {
      pid: 12345,
      cwd: fixtureState.cwd,
      startedAt: 10,
      name: 'native daemon session',
    }
    const nativeBgSessionId = 'aaaaaaaa-1111-4111-8111-111111111111'
    const nativeDaemonSessionId = 'bbbbbbbb-1111-4111-8111-111111111111'
    const nativeDaemonWorkerSessionId = 'cccccccc-1111-4111-8111-111111111111'
    const unknownKindSessionId = 'dddddddd-1111-4111-8111-111111111111'
    const unknownStatusSessionId = 'eeeeeeee-1111-4111-8111-111111111111'
    await writeFile(
      join(sessionsDir, 'bg-busy.json'),
      JSON.stringify({
        ...base,
        sessionId: nativeBgSessionId,
        kind: 'bg',
        status: 'busy',
      }),
    )
    await writeFile(
      join(sessionsDir, 'daemon-idle.json'),
      JSON.stringify({
        ...base,
        pid: 12346,
        sessionId: nativeDaemonSessionId,
        kind: 'daemon',
        status: 'idle',
      }),
    )
    await writeFile(
      join(sessionsDir, 'daemon-worker-waiting.json'),
      JSON.stringify({
        ...base,
        pid: 12347,
        sessionId: nativeDaemonWorkerSessionId,
        kind: 'daemon-worker',
        status: 'waiting',
      }),
    )
    await writeFile(
      join(sessionsDir, 'unknown-kind.json'),
      JSON.stringify({
        ...base,
        pid: 12348,
        sessionId: unknownKindSessionId,
        kind: 'weird',
        status: 'busy',
      }),
    )
    await writeFile(
      join(sessionsDir, 'unknown-status.json'),
      JSON.stringify({
        ...base,
        pid: 12349,
        sessionId: unknownStatusSessionId,
        kind: 'bg',
        status: 'unknown',
      }),
    )
    const malformedSessionId = 'ffffffff-1111-4111-8111-111111111111'
    await writeFile(
      join(sessionsDir, 'malformed.json'),
      JSON.stringify({
        ...base,
        sessionId: malformedSessionId,
        kind: 'bg',
        status: 'busy',
        cwd: undefined,
      }),
    )

    await expect(fixtureState.manager.list({ all: true })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pid: 12345,
          kind: 'bg',
          status: 'busy',
          sessionId: nativeBgSessionId,
          cwd: fixtureState.cwd,
        }),
        expect.objectContaining({
          pid: 12346,
          kind: 'daemon',
          status: 'idle',
          sessionId: nativeDaemonSessionId,
        }),
        expect.objectContaining({
          pid: 12347,
          kind: 'daemon-worker',
          status: 'waiting',
          sessionId: nativeDaemonWorkerSessionId,
        }),
      ]),
    )
    const listed = await fixtureState.manager.list({ all: true })
    expect(
      listed.some((session) => session.sessionId === unknownKindSessionId),
    ).toBe(false)
    expect(
      listed.some((session) => session.sessionId === unknownStatusSessionId),
    ).toBe(false)
    expect(
      listed.some((session) => session.sessionId === malformedSessionId),
    ).toBe(false)
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
        PRAXIS_ANTHROPIC_PROMPT_CACHING: 'true',
        PRAXIS_ANTHROPIC_PROMPT_CACHE_TTL: '1h',
        DISABLE_PROMPT_CACHING_SONNET: '1',
        FORCE_PROMPT_CACHING_5M: '1',
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
    expect(environment.PRAXIS_ANTHROPIC_PROMPT_CACHING).toBe('true')
    expect(environment.PRAXIS_ANTHROPIC_PROMPT_CACHE_TTL).toBe('1h')
    expect(environment.DISABLE_PROMPT_CACHING_SONNET).toBe('1')
    expect(environment.FORCE_PROMPT_CACHING_5M).toBe('1')
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
