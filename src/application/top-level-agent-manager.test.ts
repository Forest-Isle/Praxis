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
import { Server } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ClaudeJobExecution,
  ClaudeJobStore,
  isProcessAlive,
  newClaudeJobIdentity,
  type ClaudeJobState,
} from '../persistence/claude-job-store.js'
import { resolveDataPlanePaths } from '../persistence/data-plane.js'
import { ExclusiveFileLease } from '../platform/exclusive-file-lease.js'
import {
  runTopLevelAgentWorker,
  topLevelAgentProcessRegistryRoot,
  TopLevelAgentManager,
  type TopLevelAgentRuntime,
} from './top-level-agent-manager.js'
import type { SessionRunResult } from './session-service.js'

type LeasePrototype = {
  releaseOwned(filePath: string, token: string): Promise<void>
}

const roots: string[] = []

async function fixture(
  options: {
    deferInitialTurn?: boolean
    dataPlane?: 'native'
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
  const store = new ClaudeJobStore(configRoot, join(configRoot, 'state'))
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

async function waitForProcessExit(pid: number): Promise<void> {
  await waitFor(async () => !isProcessAlive(pid))
}

async function waitForRegisteredWorker(
  configRoot: string,
  id: string,
): Promise<void> {
  const processFile = join(
    topLevelAgentProcessRegistryRoot(configRoot),
    `${process.pid}.json`,
  )
  await waitFor(async () => {
    try {
      const value = JSON.parse(await readFile(processFile, 'utf8')) as {
        jobId?: string
        status?: string
      }
      return value.jobId === id && value.status === 'idle'
    } catch {
      return false
    }
  })
}

async function writeSignalHeldWorker(configRoot: string): Promise<string> {
  const scriptPath = join(configRoot, 'held-worker.mjs')
  await writeFile(
    scriptPath,
    "const hold = setInterval(() => undefined, 1_000)\nconst stop = () => { clearInterval(hold); process.exit(0) }\nprocess.once('SIGTERM', stop)\nprocess.once('SIGINT', stop)\n",
  )
  return scriptPath
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
      access(
        join(
          topLevelAgentProcessRegistryRoot(fixtureState.configRoot),
          `${process.pid}.json`,
        ),
      ),
    ).resolves.toBeUndefined()
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
            join(
              topLevelAgentProcessRegistryRoot(fixtureState.configRoot),
              `${process.pid}.json`,
            ),
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
  })

  it('does not resurrect a terminal lifecycle from a stale working projection', async () => {
    const fixtureState = await fixture()
    const worker = runTopLevelAgentWorker({
      configRoot: fixtureState.configRoot,
      id: fixtureState.id,
      async createRuntime() {
        return {
          async run() {
            return {
              sessionId: fixtureState.sessionId,
              text: 'terminal baseline',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume() {
            throw new Error('terminal worker must not resume')
          },
        }
      },
    })
    await waitFor(
      async () =>
        (await fixtureState.store.read(fixtureState.id)).tempo === 'idle',
    )
    await fixtureState.manager.stop(fixtureState.id)
    await worker
    await fixtureState.store.update(fixtureState.id, (state) => ({
      ...state,
      state: 'working',
      detail: 'stopped projection overwritten',
      tempo: 'idle',
      socketPath: join(fixtureState.configRoot, 'control.sock'),
      controlToken: 'fixture-control-token',
      updatedAt: new Date().toISOString(),
    }))
    let createdRuntime = false
    const restartedWorker = runTopLevelAgentWorker({
      configRoot: fixtureState.configRoot,
      id: fixtureState.id,
      async createRuntime() {
        createdRuntime = true
        throw new Error('terminal worker must not create a runtime')
      },
    })
    await restartedWorker
    expect(createdRuntime).toBe(false)
    await expect(
      fixtureState.manager.attach(
        fixtureState.id,
        (async function* () {
          yield 'must not attach\n'
        })(),
        () => undefined,
      ),
    ).rejects.toThrow('not attachable')
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
          join(
            topLevelAgentProcessRegistryRoot(fixtureState.configRoot),
            `${process.pid}.json`,
          ),
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
        join(
          topLevelAgentProcessRegistryRoot(fixtureState.configRoot),
          `${process.pid}.json`,
        ),
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
    await mkdir(topLevelAgentProcessRegistryRoot(fixtureState.configRoot), {
      recursive: true,
    })
    const nativeSessionId = 'aaaaaaaa-1111-4111-8111-111111111111'
    await writeFile(
      join(
        topLevelAgentProcessRegistryRoot(fixtureState.configRoot),
        '12345.json',
      ),
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
      join(
        topLevelAgentProcessRegistryRoot(fixtureState.configRoot),
        '12346.json',
      ),
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
    const nativeTranscript = resolveDataPlanePaths({
      dataPlane: 'native',
      root: fixtureState.configRoot,
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
    const sessionsDir = topLevelAgentProcessRegistryRoot(
      fixtureState.configRoot,
    )
    await mkdir(sessionsDir, { recursive: true })
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
    const stopping = fixtureState.manager.stop(fixtureState.id)
    await waitFor(
      async () =>
        (await fixtureState.store.readWithLifecycle(fixtureState.id))
          .lifecycleState === 'cancelling',
    )
    releaseRuntime?.({
      async run() {
        throw new Error('must not run')
      },
      async resume() {
        throw new Error('must not resume')
      },
    })

    await stopping
    await worker
    const stopped = await fixtureState.store.read(fixtureState.id)
    expect(stopped.state).toBe('stopped')
    expect(stopped).not.toHaveProperty('pid')
    expect(stopped).not.toHaveProperty('socketPath')
  })

  it('serializes a waiting transition before cancellation without returning to running', async () => {
    const fixtureState = await fixture()
    const originalWaiting = ClaudeJobExecution.prototype.waiting
    let waitingStarted: (() => void) | undefined
    const started = new Promise<void>((resolveStarted) => {
      waitingStarted = resolveStarted
    })
    let releaseWaiting: (() => void) | undefined
    const waitingGate = new Promise<void>((resolveWaiting) => {
      releaseWaiting = resolveWaiting
    })
    const waiting = vi
      .spyOn(ClaudeJobExecution.prototype, 'waiting')
      .mockImplementationOnce(async function (
        this: ClaudeJobExecution,
        mutate,
      ) {
        waitingStarted?.()
        await waitingGate
        return originalWaiting.call(this, mutate)
      })
    const worker = runTopLevelAgentWorker({
      configRoot: fixtureState.configRoot,
      id: fixtureState.id,
      async createRuntime() {
        return {
          async run(_prompt, _signal, sessionId) {
            return {
              sessionId,
              text: 'READY TO WAIT',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume() {
            throw new Error('unused')
          },
        }
      },
    })
    try {
      await started
      process.emit('SIGTERM')
      releaseWaiting?.()
      await worker
      await expect(
        fixtureState.store.readWithLifecycle(fixtureState.id),
      ).resolves.toMatchObject({ lifecycleState: 'cancelled' })
    } finally {
      releaseWaiting?.()
      waiting.mockRestore()
      await worker.catch(() => undefined)
    }
  })

  it('does not acknowledge stopped while canonical cancelled finish is held', async () => {
    const fixtureState = await fixture({ deferInitialTurn: true })
    const worker = runTopLevelAgentWorker({
      configRoot: fixtureState.configRoot,
      id: fixtureState.id,
      async createRuntime() {
        return {
          async run() {
            throw new Error('deferred worker must not run')
          },
          async resume() {
            throw new Error('deferred worker must not resume')
          },
        }
      },
    })
    await waitForRegisteredWorker(fixtureState.configRoot, fixtureState.id)
    await expect(
      fixtureState.store.readWithLifecycle(fixtureState.id),
    ).resolves.toMatchObject({
      lifecycleState: 'waiting',
      lifecycle: { state: 'waiting' },
      state: { pid: process.pid },
    })
    await fixtureState.store.update(fixtureState.id, (state) => ({
      ...state,
      pid: 999999,
    }))
    const originalFinish = ClaudeJobExecution.prototype.finish
    let finishStarted: (() => void) | undefined
    const started = new Promise<void>((resolveStarted) => {
      finishStarted = resolveStarted
    })
    let releaseFinish: (() => void) | undefined
    const finishGate = new Promise<void>((resolveFinish) => {
      releaseFinish = resolveFinish
    })
    const finish = vi
      .spyOn(ClaudeJobExecution.prototype, 'finish')
      .mockImplementation(async function (
        this: ClaudeJobExecution,
        state,
        mutate,
      ) {
        if (state === 'cancelled') {
          finishStarted?.()
          await finishGate
        }
        return originalFinish.call(this, state, mutate)
      })
    let stopSettled = false
    let stopping: Promise<void> | undefined
    try {
      stopping = fixtureState.manager.stop(fixtureState.id).finally(() => {
        stopSettled = true
      })
      await started
      await Promise.resolve()
      expect(stopSettled).toBe(false)
      await expect(
        fixtureState.store.readWithLifecycle(fixtureState.id),
      ).resolves.toMatchObject({ lifecycleState: 'cancelling' })
      releaseFinish?.()
      await stopping
      await worker
      await expect(
        fixtureState.store.readWithLifecycle(fixtureState.id),
      ).resolves.toMatchObject({ lifecycleState: 'cancelled' })
    } finally {
      releaseFinish?.()
      finish.mockRestore()
      await stopping?.catch(() => undefined)
      await worker.catch(() => undefined)
    }
  })

  it('orphanizes a rejected cancelled finish without hanging or stopped acknowledgement', async () => {
    const fixtureState = await fixture({ deferInitialTurn: true })
    const worker = runTopLevelAgentWorker({
      configRoot: fixtureState.configRoot,
      id: fixtureState.id,
      async createRuntime() {
        return {
          async run() {
            throw new Error('deferred worker must not run')
          },
          async resume() {
            throw new Error('deferred worker must not resume')
          },
        }
      },
    })
    void worker.catch(() => undefined)
    await waitForRegisteredWorker(fixtureState.configRoot, fixtureState.id)
    await expect(
      fixtureState.store.readWithLifecycle(fixtureState.id),
    ).resolves.toMatchObject({
      lifecycleState: 'waiting',
      lifecycle: { state: 'waiting' },
      state: { pid: process.pid },
    })
    await fixtureState.store.update(fixtureState.id, (state) => ({
      ...state,
      pid: 999999,
    }))
    const originalFinish = ClaudeJobExecution.prototype.finish
    const finish = vi
      .spyOn(ClaudeJobExecution.prototype, 'finish')
      .mockImplementation(async function (
        this: ClaudeJobExecution,
        state,
        mutate,
      ) {
        if (state === 'cancelled')
          throw new Error('injected cancelled finish failure')
        return originalFinish.call(this, state, mutate)
      })
    try {
      await expect(fixtureState.manager.stop(fixtureState.id)).rejects.toThrow(
        `Agent ${fixtureState.id} stop ended in state orphaned`,
      )
      await expect(worker).rejects.toThrow('Agent worker cleanup failed')
      await expect(
        fixtureState.store.readWithLifecycle(fixtureState.id),
      ).resolves.toMatchObject({
        lifecycleState: 'orphaned',
        lifecycle: { owner: null },
      })
    } finally {
      finish.mockRestore()
      await worker.catch(() => undefined)
    }
  })

  it('orphanizes a server close-start failure before stopped acknowledgement', async () => {
    const fixtureState = await fixture({ deferInitialTurn: true })
    const worker = runTopLevelAgentWorker({
      configRoot: fixtureState.configRoot,
      id: fixtureState.id,
      async createRuntime() {
        return {
          async run() {
            throw new Error('deferred worker must not run')
          },
          async resume() {
            throw new Error('deferred worker must not resume')
          },
        }
      },
    })
    void worker.catch(() => undefined)
    await waitForRegisteredWorker(fixtureState.configRoot, fixtureState.id)
    await expect(
      fixtureState.store.readWithLifecycle(fixtureState.id),
    ).resolves.toMatchObject({
      lifecycleState: 'waiting',
      lifecycle: { state: 'waiting' },
      state: { pid: process.pid },
    })
    await fixtureState.store.update(fixtureState.id, (state) => ({
      ...state,
      pid: 999999,
    }))
    const originalClose = Server.prototype.close
    let injected = false
    const close = vi
      .spyOn(Server.prototype, 'close')
      .mockImplementation(function (this: Server, callback) {
        if (!injected) {
          injected = true
          originalClose.call(this, callback)
          throw new Error('injected server close-start failure')
        }
        return originalClose.call(this, callback)
      })
    try {
      await expect(fixtureState.manager.stop(fixtureState.id)).rejects.toThrow(
        `Agent ${fixtureState.id} stop ended in state orphaned`,
      )
      await expect(worker).rejects.toThrow('Agent worker cleanup failed')
      await expect(
        fixtureState.store.readWithLifecycle(fixtureState.id),
      ).resolves.toMatchObject({ lifecycleState: 'orphaned' })
    } finally {
      close.mockRestore()
      await worker.catch(() => undefined)
    }
  })

  it('captures SIGTERM before claim and cancels without creating a runtime', async () => {
    const fixtureState = await fixture()
    const baselineTerm = process.listenerCount('SIGTERM')
    const baselineInt = process.listenerCount('SIGINT')
    let claimStarted: (() => void) | undefined
    const started = new Promise<void>((resolveStarted) => {
      claimStarted = resolveStarted
    })
    let releaseClaim: (() => void) | undefined
    const claimGate = new Promise<void>((resolveClaim) => {
      releaseClaim = resolveClaim
    })
    const originalClaim = ClaudeJobStore.prototype.claimExecution
    const claim = vi
      .spyOn(ClaudeJobStore.prototype, 'claimExecution')
      .mockImplementation(async function (this: ClaudeJobStore, id) {
        claimStarted?.()
        await claimGate
        return originalClaim.call(this, id)
      })
    let createdRuntime = false
    const worker = runTopLevelAgentWorker({
      configRoot: fixtureState.configRoot,
      id: fixtureState.id,
      async createRuntime() {
        createdRuntime = true
        throw new Error('runtime must not be created')
      },
    })
    try {
      await started
      process.emit('SIGTERM')
      releaseClaim?.()
      await worker
      expect(createdRuntime).toBe(false)
      await expect(
        fixtureState.store.readWithLifecycle(fixtureState.id),
      ).resolves.toMatchObject({ lifecycleState: 'cancelled' })
      expect(process.listenerCount('SIGTERM')).toBe(baselineTerm)
      expect(process.listenerCount('SIGINT')).toBe(baselineInt)
    } finally {
      releaseClaim?.()
      claim.mockRestore()
    }
  })

  it('closes a listen-window cancellation without late worker files', async () => {
    const fixtureState = await fixture({ deferInitialTurn: true })
    let listenStarted: (() => void) | undefined
    const started = new Promise<void>((resolveStarted) => {
      listenStarted = resolveStarted
    })
    const originalListen = Server.prototype.listen
    const listen = vi
      .spyOn(Server.prototype, 'listen')
      .mockImplementation(function (this: Server, ...args) {
        listenStarted?.()
        return originalListen.call(this, ...args)
      })
    const worker = runTopLevelAgentWorker({
      configRoot: fixtureState.configRoot,
      id: fixtureState.id,
      async createRuntime() {
        return {
          async run() {
            throw new Error('deferred worker must not run')
          },
          async resume() {
            throw new Error('deferred worker must not resume')
          },
        }
      },
    })
    try {
      await started
      process.emit('SIGTERM')
      await worker
      await expect(
        fixtureState.store.readWithLifecycle(fixtureState.id),
      ).resolves.toMatchObject({ lifecycleState: 'cancelled' })
      await expect(
        access(
          join(
            topLevelAgentProcessRegistryRoot(fixtureState.configRoot),
            `${process.pid}.json`,
          ),
        ),
      ).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      listen.mockRestore()
    }
  })

  it('settles a listen rejection as failed and restores signal listeners', async () => {
    const fixtureState = await fixture()
    const baselineTerm = process.listenerCount('SIGTERM')
    const baselineInt = process.listenerCount('SIGINT')
    const listen = vi
      .spyOn(Server.prototype, 'listen')
      .mockImplementation(function (this: Server) {
        queueMicrotask(() =>
          this.emit('error', new Error('injected listen failure')),
        )
        return this
      })
    try {
      await runTopLevelAgentWorker({
        configRoot: fixtureState.configRoot,
        id: fixtureState.id,
        async createRuntime() {
          return {
            async run() {
              throw new Error('listen failure must prevent turns')
            },
            async resume() {
              throw new Error('listen failure must prevent turns')
            },
          }
        },
      })
      await expect(
        fixtureState.store.readWithLifecycle(fixtureState.id),
      ).resolves.toMatchObject({ lifecycleState: 'failed' })
      expect(process.listenerCount('SIGTERM')).toBe(baselineTerm)
      expect(process.listenerCount('SIGINT')).toBe(baselineInt)
    } finally {
      listen.mockRestore()
    }
  })

  it('orphanizes cancellation cleanup failure without stopped acknowledgement', async () => {
    const fixtureState = await fixture()
    const worker = runTopLevelAgentWorker({
      configRoot: fixtureState.configRoot,
      id: fixtureState.id,
      async createRuntime() {
        return {
          async run(_prompt, _signal, sessionId) {
            return {
              sessionId,
              text: 'READY',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume() {
            throw new Error('unused')
          },
          async close() {
            throw new Error('runtime close failed')
          },
        }
      },
    })
    void worker.catch(() => undefined)
    await waitFor(
      async () =>
        (await fixtureState.store.read(fixtureState.id)).tempo === 'idle',
    )
    await fixtureState.store.update(fixtureState.id, (state) => ({
      ...state,
      pid: 999999,
    }))
    await expect(fixtureState.manager.stop(fixtureState.id)).rejects.toThrow(
      `Agent ${fixtureState.id} stop ended in state orphaned`,
    )
    await expect(worker).rejects.toThrow('Agent worker cleanup failed')
    await expect(
      fixtureState.store.readWithLifecycle(fixtureState.id),
    ).resolves.toMatchObject({
      lifecycleState: 'orphaned',
      state: { detail: expect.stringContaining('runtime close failed') },
    })
  })

  it('hands off a launched parent execution to a fresh child token in the same generation', async () => {
    const configRoot = await mkdtemp(
      join(tmpdir(), 'praxis-top-agent-handoff-'),
    )
    roots.push(configRoot)
    const cwd = join(configRoot, 'work')
    await mkdir(cwd)
    const scriptPath = await writeSignalHeldWorker(configRoot)
    const manager = new TopLevelAgentManager({
      configRoot,
      cwd,
      cliPath: scriptPath,
      executablePath: process.execPath,
      version: '0.1.0',
    })
    const store = new ClaudeJobStore(configRoot, join(configRoot, 'state'))
    let spawnedPid: number | undefined
    let child: ClaudeJobExecution | undefined
    try {
      const identity = await manager.launch({
        prompt: 'handoff success',
        argv: [],
      })
      const queued = await store.readWithLifecycle(identity.id)
      spawnedPid = queued.state.pid
      if (spawnedPid === undefined) throw new Error('Expected spawned PID')
      expect(isProcessAlive(spawnedPid)).toBe(true)
      expect(queued.lifecycleState).toBe('queued')
      const parentGeneration = queued.lifecycle?.generation
      const parentToken = queued.lifecycle?.owner?.token

      child = await store.claimExecution(identity.id)
      expect(child.generation).toBe(parentGeneration)
      expect(child.token).not.toBe(parentToken)
      await child.running()
      await child.waiting()
      expect(child.snapshot.state).toBe('waiting')

      process.kill(spawnedPid, 'SIGTERM')
      await waitForProcessExit(spawnedPid)
      await child.release()
      child = undefined
    } finally {
      await child?.release().catch(() => undefined)
      if (spawnedPid !== undefined && isProcessAlive(spawnedPid)) {
        process.kill(spawnedPid, 'SIGTERM')
        await waitForProcessExit(spawnedPid)
      }
    }
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
    const [failed] = await new ClaudeJobStore(
      configRoot,
      join(configRoot, 'state'),
    ).list()
    expect(failed?.state).toBe('failed')
    expect(failed).not.toHaveProperty('pid')
    expect(failed).not.toHaveProperty('socketPath')
    expect(failed).not.toHaveProperty('controlToken')
  })

  it('releases the canonical owner when child PID publication fails', async () => {
    const configRoot = await mkdtemp(
      join(tmpdir(), 'praxis-top-agent-pid-update-'),
    )
    roots.push(configRoot)
    const cwd = join(configRoot, 'work')
    await mkdir(cwd)
    const manager = new TopLevelAgentManager({
      configRoot,
      cwd,
      cliPath: await writeSignalHeldWorker(configRoot),
      executablePath: process.execPath,
      version: '0.1.0',
    })
    const store = new ClaudeJobStore(configRoot, join(configRoot, 'state'))
    let spawnedPid: number | undefined
    const update = vi
      .spyOn(ClaudeJobExecution.prototype, 'update')
      .mockImplementationOnce(async function (
        this: ClaudeJobExecution,
        mutate,
      ) {
        spawnedPid = mutate(await store.read(this.jobId)).pid
        throw new Error('injected PID publication failure')
      })
    try {
      await expect(
        manager.launch({ prompt: 'PID failure', argv: [] }),
      ).rejects.toThrow('Could not start background agent')
    } finally {
      update.mockRestore()
    }
    if (spawnedPid === undefined) throw new Error('Expected spawned PID')
    await waitForProcessExit(spawnedPid)
    expect(isProcessAlive(spawnedPid)).toBe(false)
    const [state] = await store.list()
    if (!state) throw new Error('Expected failed job state')
    const failed = await store.readWithLifecycle(state.daemonShort)
    expect(failed).toMatchObject({
      lifecycleState: 'failed',
      lifecycle: { owner: null },
      state: { state: 'failed' },
    })
    expect(failed.state).not.toHaveProperty('pid')
    expect(failed.state).not.toHaveProperty('socketPath')
    expect(failed.state).not.toHaveProperty('controlToken')
    await expect(
      store.reconcileOwnerLoss(state.daemonShort),
    ).resolves.toMatchObject({ owned: false })
  })

  it('recovers ownership after a parent handoff failure', async () => {
    const configRoot = await mkdtemp(
      join(tmpdir(), 'praxis-top-agent-handoff-failure-'),
    )
    roots.push(configRoot)
    const cwd = join(configRoot, 'work')
    await mkdir(cwd)
    const manager = new TopLevelAgentManager({
      configRoot,
      cwd,
      cliPath: await writeSignalHeldWorker(configRoot),
      executablePath: process.execPath,
      version: '0.1.0',
    })
    const store = new ClaudeJobStore(configRoot, join(configRoot, 'state'))
    const originalUpdate = ClaudeJobExecution.prototype.update
    let spawnedPid: number | undefined
    const update = vi
      .spyOn(ClaudeJobExecution.prototype, 'update')
      .mockImplementationOnce(async function (
        this: ClaudeJobExecution,
        mutate,
      ) {
        const next = mutate(await store.read(this.jobId))
        spawnedPid = next.pid
        return originalUpdate.call(this, () => next)
      })
    const leasePrototype =
      ExclusiveFileLease.prototype as unknown as LeasePrototype
    const originalRelease = leasePrototype.releaseOwned
    const releaseOwned = vi.spyOn(leasePrototype, 'releaseOwned')
    let releaseFailed = false
    releaseOwned.mockImplementation(async function (
      this: LeasePrototype,
      filePath,
      token,
    ) {
      if (!releaseFailed && /job-[^/]+\.owner\.lock$/u.test(filePath)) {
        releaseFailed = true
        throw new Error('injected handoff lease release failure')
      }
      await originalRelease.call(this, filePath, token)
    })
    try {
      await expect(
        manager.launch({ prompt: 'handoff failure', argv: [] }),
      ).rejects.toThrow('Background agent handoff failed')
    } finally {
      update.mockRestore()
      releaseOwned.mockRestore()
    }
    expect(releaseFailed).toBe(true)
    if (spawnedPid === undefined) throw new Error('Expected spawned PID')
    await waitForProcessExit(spawnedPid)
    expect(isProcessAlive(spawnedPid)).toBe(false)
    const [failed] = await store.list()
    if (!failed) throw new Error('Expected failed handoff job')
    const orphaned = await store.readWithLifecycle(failed.daemonShort)
    expect(orphaned).toMatchObject({
      lifecycleState: 'orphaned',
      lifecycle: { owner: null },
    })
    await expect(
      store.reconcileOwnerLoss(failed.daemonShort),
    ).resolves.toMatchObject({ owned: false })
    const recovered = await store.claimExecution(failed.daemonShort)
    expect(recovered.generation).toBe((orphaned.lifecycle?.generation ?? 0) + 1)
    expect(recovered.snapshot.state).toBe('queued')
    await recovered.release()
  })

  it('anchors queued handoff grace to the handoff-adjacent updatedAt', async () => {
    const fixtureState = await fixture()
    const createQueued = async (pid: number, updatedAt: string) => {
      const identity = newClaudeJobIdentity()
      const state: ClaudeJobState = {
        ...(await fixtureState.store.read(fixtureState.id)),
        daemonShort: identity.id,
        sessionId: identity.sessionId,
        resumeSessionId: identity.sessionId,
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        updatedAt,
        pid,
      }
      const execution = await fixtureState.store.createExecution(state, {
        version: 1,
        argv: [],
        resume: false,
      })
      if (!execution) throw new Error('Expected queued execution')
      await execution.update((current) => ({
        ...current,
        pid,
        updatedAt,
      }))
      await execution.handoff()
      return identity.id
    }
    const liveId = await createQueued(process.pid, new Date().toISOString())
    await expect(fixtureState.manager.list({ all: true })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: liveId, state: 'working' }),
      ]),
    )
    await expect(
      fixtureState.store.readWithLifecycle(liveId),
    ).resolves.toMatchObject({ lifecycleState: 'queued' })

    const freshDeadId = await createQueued(999999, new Date().toISOString())
    await expect(fixtureState.manager.list({ all: true })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: freshDeadId, state: 'failed' }),
      ]),
    )
    await expect(
      fixtureState.store.readWithLifecycle(freshDeadId),
    ).resolves.toMatchObject({ lifecycleState: 'orphaned' })

    const expiredLiveId = await createQueued(
      process.pid,
      new Date().toISOString(),
    )
    await fixtureState.store.update(expiredLiveId, (current) => ({
      ...current,
      updatedAt: new Date(Date.now() - 5_001).toISOString(),
    }))
    await expect(fixtureState.manager.list({ all: true })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: expiredLiveId, state: 'failed' }),
      ]),
    )
    await expect(
      fixtureState.store.readWithLifecycle(expiredLiveId),
    ).resolves.toMatchObject({ lifecycleState: 'orphaned' })

    const expiredId = await createQueued(
      999999,
      new Date(Date.now() - 5_001).toISOString(),
    )
    await expect(fixtureState.manager.list({ all: true })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: expiredId, state: 'failed' }),
      ]),
    )
    await expect(
      fixtureState.store.readWithLifecycle(expiredId),
    ).resolves.toMatchObject({ lifecycleState: 'orphaned' })
  })

  it('recovers an orphan with a fresh generation without repeating handoff fork', async () => {
    const fixtureState = await fixture({ deferInitialTurn: true })
    const previous = await fixtureState.store.claimExecution(fixtureState.id)
    const previousGeneration = previous.generation
    await previous.release()
    await fixtureState.store.updateDispatch(fixtureState.id, (dispatch) => ({
      ...dispatch,
      resume: true,
      handoffComplete: true,
    }))
    const calls: string[] = []
    const worker = runTopLevelAgentWorker({
      configRoot: fixtureState.configRoot,
      id: fixtureState.id,
      async createRuntime() {
        return {
          async run() {
            throw new Error('recovered handoff must resume')
          },
          async resume(sessionId, prompt) {
            calls.push(`resume:${sessionId}:${prompt}`)
            return {
              sessionId,
              text: 'RECOVERED',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async ensureFork() {
            throw new Error('completed handoff must not fork again')
          },
        }
      },
    })
    await waitFor(
      async () =>
        (await fixtureState.store.readWithLifecycle(fixtureState.id))
          .lifecycleState === 'waiting',
    )
    const recovered = await fixtureState.store.readWithLifecycle(
      fixtureState.id,
    )
    expect(recovered.lifecycle?.generation).toBe(previousGeneration + 1)
    const output: string[] = []
    await fixtureState.manager.attach(
      fixtureState.id,
      (async function* () {
        yield 'continue recovered\n'
      })(),
      (text) => output.push(text),
    )
    expect(calls).toEqual([
      `resume:${fixtureState.sessionId}:continue recovered`,
    ])
    expect(output.join('')).toContain('RECOVERED')
    await fixtureState.manager.stop(fixtureState.id)
    await worker
  })

  it('keeps a lazy-fork continuation provider error recoverable', async () => {
    const sourceSessionId = '99999999-9999-4999-8999-999999999999'
    const fixtureState = await fixture({
      deferInitialTurn: true,
      sourceSessionId,
      sourceCheckpoint: {
        resumeSessionAt: '88888888-8888-4888-8888-888888888888',
        entryCount: 4,
      },
    })
    const calls: string[] = []
    let resumes = 0
    const worker = runTopLevelAgentWorker({
      configRoot: fixtureState.configRoot,
      id: fixtureState.id,
      async createRuntime() {
        return {
          async run() {
            throw new Error('lazy continuation must resume')
          },
          async ensureFork() {
            calls.push('ensureFork')
            return {
              parentSessionId: sourceSessionId,
              sessionId: fixtureState.sessionId,
            }
          },
          async resume(sessionId, prompt) {
            resumes += 1
            if (resumes === 1) throw new Error('recoverable continuation error')
            return {
              sessionId,
              text: `RECOVERED ${prompt}`,
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
        }
      },
    })
    await waitFor(
      async () =>
        (await fixtureState.store.read(fixtureState.id)).tempo === 'blocked',
    )
    await expect(
      fixtureState.manager.attach(
        fixtureState.id,
        (async function* () {
          yield 'first continuation\n'
        })(),
        () => undefined,
      ),
    ).rejects.toThrow('recoverable continuation error')
    await expect(
      fixtureState.store.readWithLifecycle(fixtureState.id),
    ).resolves.toMatchObject({ lifecycleState: 'waiting' })
    const output: string[] = []
    await fixtureState.manager.attach(
      fixtureState.id,
      (async function* () {
        yield 'second continuation\n'
      })(),
      (text) => output.push(text),
    )
    expect(calls).toEqual(['ensureFork'])
    expect(output.join('')).toContain('RECOVERED second continuation')
    await fixtureState.manager.stop(fixtureState.id)
    await worker
  })

  it('passes only the worker runtime environment contract to detached workers', async () => {
    const configRoot = await mkdtemp(join(tmpdir(), 'praxis-top-agent-env-'))
    roots.push(configRoot)
    const cwd = join(configRoot, 'work')
    await mkdir(cwd)
    const outputPath = join(configRoot, 'environment.json')
    const scriptPath = join(configRoot, 'worker.mjs')
    const legacyDisableSonnet = ['DISABLE', 'PROMPT', 'CACHING', 'SONNET'].join(
      '_',
    )
    const legacyForceFiveMinutes = ['FORCE', 'PROMPT', 'CACHING', '5M'].join(
      '_',
    )
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
        PRAXIS_PROVIDER_PROFILE: 'worker-profile',
        PRAXIS_PROVIDER_DEADLINE_MS: '45000',
        PRAXIS_PROVIDER_CONNECT_TIMEOUT_MS: '12000',
        PRAXIS_PROVIDER_IDLE_TIMEOUT_MS: '23000',
        PRAXIS_PROVIDER_CREDENTIAL_STORE: 'file',
        CLAUDE_CODE_SIMPLE: 'true',
        CUSTOM_PROVIDER_SECRET: 'ambient-custom-secret',
        PRAXIS_ANTHROPIC_PROMPT_CACHING: 'true',
        PRAXIS_ANTHROPIC_PROMPT_CACHE_TTL: '1h',
        [legacyDisableSonnet]: '1',
        [legacyForceFiveMinutes]: '1',
        AWS_SECRET_ACCESS_KEY: 'ambient-secret',
        BASH_ENV: '/tmp/untrusted-startup',
        PRAXIS_TEST_SECRET: 'unrelated-secret',
      },
      resolveProviderEnvironment: async () => ({
        PRAXIS_API_KEY: 'resolved-provider-secret',
      }),
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
    expect(environment.PRAXIS_API_KEY).toBe('resolved-provider-secret')
    expect(environment.PRAXIS_MODEL).toBe('worker-model')
    expect(environment.PRAXIS_PROVIDER_PROFILE).toBe('worker-profile')
    expect(environment.PRAXIS_PROVIDER_DEADLINE_MS).toBe('45000')
    expect(environment.PRAXIS_PROVIDER_CONNECT_TIMEOUT_MS).toBe('12000')
    expect(environment.PRAXIS_PROVIDER_IDLE_TIMEOUT_MS).toBe('23000')
    expect(environment.PRAXIS_PROVIDER_CREDENTIAL_STORE).toBe('file')
    expect(environment.CLAUDE_CODE_SIMPLE).toBe('true')
    expect(environment.PRAXIS_ANTHROPIC_PROMPT_CACHING).toBe('true')
    expect(environment.PRAXIS_ANTHROPIC_PROMPT_CACHE_TTL).toBe('1h')
    expect(environment.PATH).toBe(process.env.PATH ?? '')
    expect(environment.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(environment.BASH_ENV).toBeUndefined()
    expect(environment.PRAXIS_TEST_SECRET).toBeUndefined()
    expect(environment.CUSTOM_PROVIDER_SECRET).toBeUndefined()
    expect(environment.PRAXIS_HOME).toBe(configRoot)
    expect(environment[legacyDisableSonnet]).toBeUndefined()
    expect(environment[legacyForceFiveMinutes]).toBeUndefined()
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

  it('classifies a primary streaming output failure as failed after diagnostic persistence', async () => {
    const fixtureState = await fixture()
    const append = vi
      .spyOn(ClaudeJobStore.prototype, 'appendOutput')
      .mockRejectedValueOnce(new Error('stream persistence failed'))
    try {
      await runTopLevelAgentWorker({
        configRoot: fixtureState.configRoot,
        id: fixtureState.id,
        async createRuntime(eventSink) {
          return {
            async run(_prompt, _signal, sessionId) {
              eventSink({ type: 'text-delta', delta: 'partial' })
              return {
                sessionId,
                text: 'result',
                usage: { inputTokens: 1, outputTokens: 1 },
              }
            },
            async resume() {
              throw new Error('unused')
            },
          }
        },
      })
    } finally {
      append.mockRestore()
    }
    await expect(
      fixtureState.store.readWithLifecycle(fixtureState.id),
    ).resolves.toMatchObject({
      lifecycleState: 'failed',
      lifecycle: { owner: null },
    })
  })

  it('orphanizes when streaming output and fatal diagnostic persistence both fail', async () => {
    const fixtureState = await fixture()
    const append = vi
      .spyOn(ClaudeJobStore.prototype, 'appendOutput')
      .mockRejectedValueOnce(new Error('stream persistence failed'))
      .mockRejectedValueOnce(new Error('diagnostic persistence failed'))
    try {
      await expect(
        runTopLevelAgentWorker({
          configRoot: fixtureState.configRoot,
          id: fixtureState.id,
          async createRuntime(eventSink) {
            return {
              async run(_prompt, _signal, sessionId) {
                eventSink({ type: 'text-delta', delta: 'partial' })
                return {
                  sessionId,
                  text: 'result',
                  usage: { inputTokens: 1, outputTokens: 1 },
                }
              },
              async resume() {
                throw new Error('unused')
              },
            }
          },
        }),
      ).rejects.toThrow('Agent worker cleanup failed')
    } finally {
      append.mockRestore()
    }
    await expect(
      fixtureState.store.readWithLifecycle(fixtureState.id),
    ).resolves.toMatchObject({
      lifecycleState: 'orphaned',
      lifecycle: { owner: null },
      state: {
        detail: expect.stringContaining('diagnostic persistence failed'),
      },
    })
  })
})
