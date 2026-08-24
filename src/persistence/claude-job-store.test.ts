import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ExclusiveFileLease } from '../platform/exclusive-file-lease.js'
import {
  ClaudeJobStore,
  newClaudeJobIdentity,
  type ClaudeJobExecution,
  type ClaudeJobState,
} from './claude-job-store.js'

type LeasePrototype = {
  releaseOwned(filePath: string, token: string): Promise<void>
}

function requireExecution(
  execution: ClaudeJobExecution | null,
): ClaudeJobExecution {
  if (!execution) throw new Error('Expected execution fixture')
  return execution
}

const roots: string[] = []

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'praxis-job-store-'))
  roots.push(path)
  return path
}

function state(id: string, sessionId: string, cwd: string): ClaudeJobState {
  const now = new Date().toISOString()
  return {
    state: 'working',
    detail: 'starting',
    tempo: 'active',
    inFlight: { tasks: 1, queued: 0, kinds: ['prompt'] },
    tokens: 0,
    output: null,
    children: null,
    template: 'bg',
    respawnFlags: ['test prompt'],
    intent: 'test prompt',
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
  }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true })),
  )
})

describe('ClaudeJobStore', () => {
  it('releases the owner lease when parent-directory setup fails', async () => {
    const configRoot = await root()
    const store = new ClaudeJobStore(configRoot)
    const identity = newClaudeJobIdentity()
    const jobsPath = join(configRoot, 'jobs')
    await writeFile(jobsPath, 'not a directory')

    await expect(
      store.createExecution(
        state(identity.id, identity.sessionId, configRoot),
        { version: 1, argv: [], resume: false },
      ),
    ).rejects.toThrow()

    await rm(jobsPath)
    const execution = await store.createExecution(
      state(identity.id, identity.sessionId, configRoot),
      { version: 1, argv: [], resume: false },
    )
    expect(execution).not.toBeNull()
    await execution?.release()
  })

  it('retains setup and cleanup failures while releasing the owner lease', async () => {
    const configRoot = await root()
    const store = new ClaudeJobStore(configRoot)
    const identity = newClaudeJobIdentity()
    const lifecyclePath = join(
      configRoot,
      'praxis',
      'agent-lifecycle',
      `${identity.id}.json`,
    )
    await mkdir(join(configRoot, 'praxis', 'agent-lifecycle'), {
      recursive: true,
    })
    await mkdir(lifecyclePath)

    try {
      const error = await store
        .createExecution(state(identity.id, identity.sessionId, configRoot), {
          version: 1,
          argv: [],
          resume: false,
        })
        .catch((failure: unknown) => failure)
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toHaveLength(2)
    } finally {
      await rm(lifecyclePath, { recursive: true, force: true })
    }

    const execution = await store.createExecution(
      state(identity.id, identity.sessionId, configRoot),
      { version: 1, argv: [], resume: false },
    )
    expect(execution).not.toBeNull()
    await execution?.release()
  })

  it('preserves an existing job on directory collision and releases the lease', async () => {
    const configRoot = await root()
    const store = new ClaudeJobStore(configRoot)
    const identity = newClaudeJobIdentity()
    const initial = state(identity.id, identity.sessionId, configRoot)
    await store.create(initial, { version: 1, argv: [], resume: false })
    const statePath = join(configRoot, 'jobs', identity.id, 'state.json')
    const before = await readFile(statePath, 'utf8')

    await expect(
      store.createExecution(initial, { version: 1, argv: [], resume: false }),
    ).resolves.toBeNull()
    await expect(readFile(statePath, 'utf8')).resolves.toBe(before)
    await expect(
      store.createExecution(initial, { version: 1, argv: [], resume: false }),
    ).resolves.toBeNull()
    await expect(readFile(statePath, 'utf8')).resolves.toBe(before)
  })

  it('adopts legacy active and waiting jobs through legal transitions', async () => {
    const configRoot = await root()
    const activeIdentity = newClaudeJobIdentity()
    const waitingIdentity = newClaudeJobIdentity()
    const store = new ClaudeJobStore(configRoot)
    await store.create(
      state(activeIdentity.id, activeIdentity.sessionId, configRoot),
      { version: 1, argv: [], resume: false },
    )
    const waitingState = state(
      waitingIdentity.id,
      waitingIdentity.sessionId,
      configRoot,
    )
    await store.create(waitingState, { version: 1, argv: [], resume: false })
    await store.update(waitingIdentity.id, (current) => ({
      ...current,
      tempo: 'blocked',
      needs: 'input',
    }))

    const active = await store.claimExecution(activeIdentity.id)
    const waiting = await store.claimExecution(waitingIdentity.id)
    expect(active.snapshot).toMatchObject({
      generation: 1,
      revision: 1,
      state: 'running',
    })
    expect(waiting.snapshot).toMatchObject({
      generation: 1,
      revision: 2,
      state: 'waiting',
    })
    await active.release()
    await waiting.release()
  })

  it('retries a handoff when physical lease release fails', async () => {
    const configRoot = await root()
    const store = new ClaudeJobStore(configRoot)
    const identity = newClaudeJobIdentity()
    const owner = requireExecution(
      await store.createExecution(
        state(identity.id, identity.sessionId, configRoot),
        { version: 1, argv: [], resume: false },
      ),
    )
    const leasePrototype =
      ExclusiveFileLease.prototype as unknown as LeasePrototype
    const originalRelease = leasePrototype.releaseOwned
    const releaseOwned = vi.spyOn(leasePrototype, 'releaseOwned')
    let failed = false
    releaseOwned.mockImplementation(async function (
      this: LeasePrototype,
      filePath,
      token,
    ) {
      if (!failed && filePath.endsWith(`job-${identity.id}.owner.lock`)) {
        failed = true
        throw new Error('injected handoff lease release failure')
      }
      await originalRelease.call(this, filePath, token)
    })
    try {
      await expect(owner.handoff()).rejects.toThrow(
        'injected handoff lease release failure',
      )
      await expect(store.claimExecution(identity.id)).rejects.toThrow(
        'already owned',
      )
      await owner.handoff()
      const child = await store.claimExecution(identity.id)
      expect(child.generation).toBe(owner.generation)
      expect(child.token).not.toBe(owner.token)
      await child.release()
    } finally {
      releaseOwned.mockRestore()
      await owner.release().catch(() => undefined)
    }
  })

  it('retries a normal release after physical lease failure and recovers a fresh generation', async () => {
    const configRoot = await root()
    const store = new ClaudeJobStore(configRoot)
    const identity = newClaudeJobIdentity()
    const owner = requireExecution(
      await store.createExecution(
        state(identity.id, identity.sessionId, configRoot),
        { version: 1, argv: [], resume: false },
      ),
    )
    await owner.running()
    const leasePrototype =
      ExclusiveFileLease.prototype as unknown as LeasePrototype
    const originalRelease = leasePrototype.releaseOwned
    const releaseOwned = vi.spyOn(leasePrototype, 'releaseOwned')
    let failed = false
    releaseOwned.mockImplementation(async function (
      this: LeasePrototype,
      filePath,
      token,
    ) {
      if (!failed && filePath.endsWith(`job-${identity.id}.owner.lock`)) {
        failed = true
        throw new Error('injected release lease failure')
      }
      await originalRelease.call(this, filePath, token)
    })
    try {
      await expect(owner.release()).rejects.toThrow(
        'injected release lease failure',
      )
      await expect(store.claimExecution(identity.id)).rejects.toThrow(
        'already owned',
      )
      await owner.release()
      const recovered = await store.claimExecution(identity.id)
      expect(recovered.generation).toBe(owner.generation + 1)
      expect(recovered.snapshot.state).toBe('queued')
      await recovered.release()
    } finally {
      releaseOwned.mockRestore()
      await owner.release().catch(() => undefined)
    }
  })

  it('preserves child worker PID metadata while keeping owner PID private', async () => {
    const configRoot = await root()
    const store = new ClaudeJobStore(configRoot)
    const identity = newClaudeJobIdentity()
    const execution = await store.createExecution(
      state(identity.id, identity.sessionId, configRoot),
      { version: 1, argv: [], resume: false },
    )
    const childPid = 999999
    const owner = requireExecution(execution)
    await owner.running((current) => ({
      ...current,
      pid: childPid,
      socketPath: '/tmp/child.sock',
      controlToken: 'child-control',
    }))
    const projected = await store.read(identity.id)
    expect(projected).toMatchObject({
      pid: childPid,
      socketPath: '/tmp/child.sock',
      controlToken: 'child-control',
    })
    const sidecar = JSON.parse(
      await readFile(
        join(configRoot, 'praxis', 'agent-lifecycle', `${identity.id}.json`),
        'utf8',
      ),
    ) as { lifecycle: { owner: { pid: number } } }
    expect(sidecar.lifecycle.owner.pid).toBe(process.pid)
    expect(projected.pid).not.toBe(sidecar.lifecycle.owner.pid)
    const rawDispatch = JSON.parse(
      await readFile(
        join(configRoot, 'jobs', identity.id, 'dispatch.json'),
        'utf8',
      ),
    ) as Record<string, unknown>
    for (const value of [projected, rawDispatch])
      for (const field of [
        'lifecycle',
        'lifecycleState',
        'generation',
        'revision',
        'owner',
        'ownerToken',
        'previousOwnerToken',
        'terminalAt',
        'acceptance',
      ])
        expect(value).not.toHaveProperty(field)
    await owner.release()
  })

  it('projects running, waiting, and running transitions with worker metadata intact', async () => {
    const configRoot = await root()
    const store = new ClaudeJobStore(configRoot)
    const identity = newClaudeJobIdentity()
    const execution = await store.createExecution(
      state(identity.id, identity.sessionId, configRoot),
      { version: 1, argv: [], resume: false },
    )
    const owner = requireExecution(execution)
    await owner.running((current) => ({
      ...current,
      pid: 999999,
      socketPath: '/tmp/worker.sock',
      controlToken: 'worker-control',
      needs: 'input',
    }))
    await owner.waiting()
    await expect(store.read(identity.id)).resolves.toMatchObject({
      state: 'working',
      tempo: 'blocked',
      pid: 999999,
      socketPath: '/tmp/worker.sock',
      controlToken: 'worker-control',
      needs: 'input',
    })
    await owner.running()
    await expect(store.read(identity.id)).resolves.toMatchObject({
      state: 'working',
      tempo: 'active',
      pid: 999999,
      socketPath: '/tmp/worker.sock',
      controlToken: 'worker-control',
      needs: 'input',
    })
    await owner.release()
  })

  it('rejects old-generation finish and update after orphan recovery', async () => {
    const configRoot = await root()
    const store = new ClaudeJobStore(configRoot)
    const identity = newClaudeJobIdentity()
    const execution = await store.createExecution(
      state(identity.id, identity.sessionId, configRoot),
      { version: 1, argv: [], resume: false },
    )
    const old = requireExecution(execution)
    await old.running()
    await old.release()
    const recovered = await new ClaudeJobStore(configRoot).claimExecution(
      identity.id,
    )
    expect(recovered.generation).toBe(old.generation + 1)
    await expect(old.finish('failed')).rejects.toThrow(/released/u)
    await expect(
      old.update((current) => ({ ...current, detail: 'stale' })),
    ).rejects.toThrow(/released/u)
    expect(recovered.snapshot.generation).toBe(old.generation + 1)
    await recovered.release()
  })

  it('refuses adoption of a legacy job with a different live PID', async () => {
    const configRoot = await root()
    const store = new ClaudeJobStore(configRoot)
    const identity = newClaudeJobIdentity()
    expect(process.ppid).toBeGreaterThan(0)
    expect(process.ppid).not.toBe(process.pid)
    const initial = {
      ...state(identity.id, identity.sessionId, configRoot),
      pid: process.ppid,
    }
    await store.create(initial, { version: 1, argv: [], resume: false })
    const before = await readFile(
      join(configRoot, 'jobs', identity.id, 'state.json'),
      'utf8',
    )
    await expect(store.claimExecution(identity.id)).rejects.toThrow(
      /live process/u,
    )
    await expect(
      readFile(
        join(configRoot, 'praxis', 'agent-lifecycle', `${identity.id}.json`),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      readFile(join(configRoot, 'jobs', identity.id, 'state.json'), 'utf8'),
    ).resolves.toBe(before)
  })

  it('projects legacy states without creating a lifecycle sidecar', async () => {
    const configRoot = await root()
    const store = new ClaudeJobStore(configRoot)
    const identity = newClaudeJobIdentity()
    const initial = state(identity.id, identity.sessionId, configRoot)
    await store.create(initial, { version: 1, argv: [], resume: false })

    await expect(store.readWithLifecycle(identity.id)).resolves.toMatchObject({
      lifecycleState: 'running',
      lifecycle: null,
      legacy: true,
    })
    await store.update(identity.id, (current) => ({
      ...current,
      tempo: 'blocked',
      needs: 'input',
    }))
    await expect(store.readWithLifecycle(identity.id)).resolves.toMatchObject({
      lifecycleState: 'waiting',
      lifecycle: null,
      legacy: true,
    })
    await store.update(identity.id, (current) => ({
      ...current,
      state: 'stopped',
    }))
    await expect(store.readWithLifecycle(identity.id)).resolves.toMatchObject({
      lifecycleState: 'cancelled',
      legacy: true,
    })
    await store.update(identity.id, (current) => ({
      ...current,
      state: 'failed',
    }))
    await expect(store.readWithLifecycle(identity.id)).resolves.toMatchObject({
      lifecycleState: 'failed',
      legacy: true,
    })
    await expect(
      readFile(
        join(configRoot, 'praxis', 'agent-lifecycle', `${identity.id}.json`),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('hands off a queued execution and recovers owner loss by generation', async () => {
    const configRoot = await root()
    const firstStore = new ClaudeJobStore(configRoot)
    const identity = newClaudeJobIdentity()
    const execution = await firstStore.createExecution(
      state(identity.id, identity.sessionId, configRoot),
      { version: 1, argv: [], resume: false },
    )
    expect(execution).not.toBeNull()
    const parent = requireExecution(execution)
    const generation = parent.generation
    const parentToken = parent.token
    await parent.handoff()
    const child = await new ClaudeJobStore(configRoot).claimExecution(
      identity.id,
    )
    expect(child.generation).toBe(generation)
    expect(child.token).not.toBe(parentToken)
    await expect(parent.running()).rejects.toThrow(/released/u)
    await child.running()
    await child.release()
    const recovered = await new ClaudeJobStore(configRoot).claimExecution(
      identity.id,
    )
    expect(recovered.generation).toBe(generation + 1)
    expect(recovered.snapshot.state).toBe('queued')
    await recovered.release()
  })

  it('refuses a competing physical owner and reports terminal state unowned', async () => {
    const configRoot = await root()
    const store = new ClaudeJobStore(configRoot)
    const identity = newClaudeJobIdentity()
    const execution = await store.createExecution(
      state(identity.id, identity.sessionId, configRoot),
      { version: 1, argv: [], resume: false },
    )
    const owner = requireExecution(execution)
    await expect(store.claimExecution(identity.id)).rejects.toThrow(
      /already owned/u,
    )
    await owner.running()
    await owner.finish('failed')
    await expect(store.reconcileOwnerLoss(identity.id)).resolves.toMatchObject({
      owned: false,
      view: { lifecycleState: 'failed', legacy: false },
    })
    await owner.release()
  })

  it('projects cancellation and enforces one terminal transition', async () => {
    const configRoot = await root()
    const store = new ClaudeJobStore(configRoot)
    const identity = newClaudeJobIdentity()
    const execution = await store.createExecution(
      state(identity.id, identity.sessionId, configRoot),
      { version: 1, argv: [], resume: false },
    )
    const owner = requireExecution(execution)
    await owner.running()
    await owner.beginCancellation()
    await owner.finish('cancelled')
    await expect(owner.finish('failed')).rejects.toThrow()
    await expect(store.readWithLifecycle(identity.id)).resolves.toMatchObject({
      lifecycleState: 'cancelled',
      state: { state: 'stopped', tempo: 'idle' },
    })
    await owner.release()
  })

  it('writes terminal canonical state before repairing stale legacy projection', async () => {
    const configRoot = await root()
    const store = new ClaudeJobStore(configRoot)
    const identity = newClaudeJobIdentity()
    const execution = await store.createExecution(
      state(identity.id, identity.sessionId, configRoot),
      { version: 1, argv: [], resume: false },
    )
    const run = requireExecution(execution)
    await run.running()
    await store.appendTimeline(identity.id, {
      at: new Date().toISOString(),
      state: 'working',
      detail: 'running',
      text: 'timeline',
    })
    await run.finish('failed')
    const dispatchBefore = await readFile(
      join(configRoot, 'jobs', identity.id, 'dispatch.json'),
      'utf8',
    )
    const timelineBefore = await readFile(
      join(configRoot, 'jobs', identity.id, 'timeline.jsonl'),
      'utf8',
    )
    await writeFile(
      join(configRoot, 'jobs', identity.id, 'state.json'),
      JSON.stringify({
        ...(await store.read(identity.id)),
        state: 'working',
        tempo: 'active',
        pid: 999999,
        socketPath: '/tmp/stale.sock',
        controlToken: 'stale-control',
        inFlight: { tasks: 1, queued: 1, kinds: ['stale'] },
        needs: 'stale input',
      }),
    )
    const view = await store.readWithLifecycle(identity.id)
    expect(view.lifecycleState).toBe('failed')
    expect(view.state.state).toBe('failed')
    expect(view.state.pid).toBeUndefined()
    expect(view.state.socketPath).toBeUndefined()
    expect(view.state.controlToken).toBeUndefined()
    expect(view.state.inFlight).toBeUndefined()
    expect(view.state.needs).toBeUndefined()
    expect(
      await readFile(
        join(configRoot, 'jobs', identity.id, 'dispatch.json'),
        'utf8',
      ),
    ).toBe(dispatchBefore)
    expect(
      await readFile(
        join(configRoot, 'jobs', identity.id, 'timeline.jsonl'),
        'utf8',
      ),
    ).toBe(timelineBefore)
    await run.release()
  })

  it('isolates corrupt and mismatched sidecars without changing state bytes', async () => {
    const configRoot = await root()
    const store = new ClaudeJobStore(configRoot)
    const corruptIdentity = newClaudeJobIdentity()
    await store.create(
      state(corruptIdentity.id, corruptIdentity.sessionId, configRoot),
      { version: 1, argv: [], resume: false },
    )
    const corruptStatePath = join(
      configRoot,
      'jobs',
      corruptIdentity.id,
      'state.json',
    )
    const corruptBefore = await readFile(corruptStatePath, 'utf8')
    const corruptPath = join(
      configRoot,
      'praxis',
      'agent-lifecycle',
      `${corruptIdentity.id}.json`,
    )
    await mkdir(join(configRoot, 'praxis', 'agent-lifecycle'), {
      recursive: true,
    })
    await writeFile(corruptPath, '{invalid')
    await expect(store.readWithLifecycle(corruptIdentity.id)).rejects.toThrow(
      `Invalid Claude job lifecycle: ${corruptPath}`,
    )
    await expect(readFile(corruptStatePath, 'utf8')).resolves.toBe(
      corruptBefore,
    )

    const mismatchIdentity = newClaudeJobIdentity()
    const execution = await store.createExecution(
      state(mismatchIdentity.id, mismatchIdentity.sessionId, configRoot),
      { version: 1, argv: [], resume: false },
    )
    const mismatchPath = join(
      configRoot,
      'praxis',
      'agent-lifecycle',
      `${mismatchIdentity.id}.json`,
    )
    const mismatchStatePath = join(
      configRoot,
      'jobs',
      mismatchIdentity.id,
      'state.json',
    )
    const mismatchBefore = await readFile(mismatchStatePath, 'utf8')
    const record = JSON.parse(await readFile(mismatchPath, 'utf8')) as {
      jobId: string
    }
    await writeFile(
      mismatchPath,
      JSON.stringify({ ...record, jobId: 'deadbeef' }),
    )
    await expect(store.readWithLifecycle(mismatchIdentity.id)).rejects.toThrow(
      `Invalid Claude job lifecycle: ${mismatchPath}`,
    )
    await expect(readFile(mismatchStatePath, 'utf8')).resolves.toBe(
      mismatchBefore,
    )
    await execution?.release().catch(() => undefined)
  })

  it('lists canonical and legacy views while isolating an invalid sidecar', async () => {
    const configRoot = await root()
    const store = new ClaudeJobStore(configRoot)
    const legacyIdentity = newClaudeJobIdentity()
    const canonicalIdentity = newClaudeJobIdentity()
    const invalidIdentity = newClaudeJobIdentity()
    await store.create(
      state(legacyIdentity.id, legacyIdentity.sessionId, configRoot),
      { version: 1, argv: [], resume: false },
    )
    const canonical = await store.createExecution(
      state(canonicalIdentity.id, canonicalIdentity.sessionId, configRoot),
      { version: 1, argv: [], resume: false },
    )
    await store.create(
      state(invalidIdentity.id, invalidIdentity.sessionId, configRoot),
      { version: 1, argv: [], resume: false },
    )
    await writeFile(
      join(
        configRoot,
        'praxis',
        'agent-lifecycle',
        `${invalidIdentity.id}.json`,
      ),
      '{invalid',
    )
    const views = await store.listWithLifecycle()
    expect(views).toHaveLength(2)
    expect(views.map((view) => view.state.daemonShort)).toEqual(
      expect.arrayContaining([legacyIdentity.id, canonicalIdentity.id]),
    )
    await canonical?.release()
  })

  it('publishes jobs exclusively and persists atomic state and timeline updates', async () => {
    const configRoot = await root()
    const store = new ClaudeJobStore(configRoot)
    const identity = newClaudeJobIdentity()
    const initial = state(identity.id, identity.sessionId, configRoot)

    await expect(
      store.create(initial, {
        version: 1,
        argv: ['test prompt'],
        resume: false,
      }),
    ).resolves.toBe(true)
    await expect(
      store.create(initial, { version: 1, argv: ['other'], resume: false }),
    ).resolves.toBe(false)

    await store.appendTimeline(identity.id, {
      at: new Date().toISOString(),
      state: 'working',
      detail: 'done',
      text: 'RESULT',
    })
    await store.appendOutput(identity.id, 'PARTIAL')
    await store.appendOutput(identity.id, '_RESULT\n')
    const updated = await store.update(identity.id, (current) => ({
      ...current,
      detail: 'done',
      tempo: 'idle',
      tokens: 3,
      updatedAt: new Date().toISOString(),
    }))

    expect(updated).toMatchObject({ detail: 'done', tempo: 'idle', tokens: 3 })
    await expect(store.timeline(identity.id)).resolves.toEqual([
      expect.objectContaining({ text: 'RESULT' }),
    ])
    await expect(store.output(identity.id)).resolves.toBe('PARTIAL_RESULT\n')
    await store.appendOutput(identity.id, '世界')
    await store.trimOutput(identity.id, 6)
    await expect(store.output(identity.id)).resolves.toBe('世界')
    await expect(store.readDispatch(identity.id)).resolves.toEqual({
      version: 1,
      argv: ['test prompt'],
      resume: false,
    })
    await expect(
      store.updateDispatch(identity.id, (dispatch) => ({
        ...dispatch,
        resume: true,
        handoffComplete: true,
      })),
    ).resolves.toEqual({
      version: 1,
      argv: ['test prompt'],
      resume: true,
      handoffComplete: true,
    })
    expect(
      await readFile(
        join(configRoot, 'jobs', identity.id, 'state.json'),
        'utf8',
      ),
    ).toMatch(/\n$/u)
  })

  it('isolates corrupt jobs and keeps valid timeline records before a torn tail', async () => {
    const configRoot = await root()
    const store = new ClaudeJobStore(configRoot)
    const identity = newClaudeJobIdentity()
    await store.create(state(identity.id, identity.sessionId, configRoot), {
      version: 1,
      argv: ['test prompt'],
      resume: false,
    })
    await store.appendTimeline(identity.id, {
      at: new Date().toISOString(),
      state: 'working',
      detail: 'done',
      text: 'VALID',
    })
    await writeFile(
      join(configRoot, 'jobs', identity.id, 'timeline.jsonl'),
      `${JSON.stringify({
        at: new Date().toISOString(),
        state: 'working',
        detail: 'done',
        text: 'VALID',
      })}\n{torn`,
    )
    await mkdir(join(configRoot, 'jobs', 'deadbeef'), { recursive: true })
    await writeFile(
      join(configRoot, 'jobs', 'deadbeef', 'state.json'),
      '{invalid',
    )

    await expect(store.list()).resolves.toHaveLength(1)
    await expect(store.timeline(identity.id)).resolves.toEqual([
      expect.objectContaining({ text: 'VALID' }),
    ])
  })
})
