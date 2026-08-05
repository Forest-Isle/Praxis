import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ClaudeTaskStore } from './claude-task-store.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function store() {
  const root = await mkdtemp(join(tmpdir(), 'praxis-task-store-'))
  roots.push(root)
  const taskRoot = join(root, 'config', 'tasks', 'session-id')
  return { root, taskRoot, store: new ClaudeTaskStore({ taskRoot }) }
}

describe('ClaudeTaskStore', () => {
  it('persists Claude task files and merges task updates', async () => {
    const { taskRoot, store: tasks } = await store()
    await expect(
      tasks.create({
        subject: 'First task',
        description: 'Complete the first task',
        activeForm: 'Completing first task',
        metadata: { priority: 'high', count: 1 },
      }),
    ).resolves.toMatchObject({ id: '1', status: 'pending' })
    await tasks.create({
      subject: 'Second task',
      description: 'Complete the second task',
    })

    await tasks.update('2', {
      owner: 'worker-a',
      addBlockedBy: ['1'],
      metadata: { note: 'waiting' },
    })
    await tasks.update('2', {
      metadata: { note: null, priority: 'low' },
    })

    await expect(
      readFile(join(taskRoot, '.highwatermark'), 'utf8'),
    ).resolves.toBe('2')
    await expect(tasks.get('1')).resolves.toMatchObject({ blocks: ['2'] })
    await expect(tasks.get('2')).resolves.toEqual({
      id: '2',
      subject: 'Second task',
      description: 'Complete the second task',
      status: 'pending',
      blocks: [],
      blockedBy: ['1'],
      owner: 'worker-a',
      metadata: { priority: 'low' },
    })
  })

  it('keeps dependency fidelity while filtering completed blockers from lists', async () => {
    const { store: tasks } = await store()
    await tasks.create({ subject: 'First', description: 'First description' })
    await tasks.create({ subject: 'Second', description: 'Second description' })
    await tasks.update('2', { addBlockedBy: ['1'] })
    await tasks.update('1', { addBlockedBy: ['2'] })
    await tasks.update('1', { status: 'completed' })

    expect((await tasks.get('2'))?.blockedBy).toEqual(['1'])
    await expect(tasks.listSummaries()).resolves.toEqual([
      { id: '1', subject: 'First', status: 'completed', blockedBy: ['2'] },
      { id: '2', subject: 'Second', status: 'pending', blockedBy: [] },
    ])
  })

  it('deletes tasks, cleans reciprocal dependencies, and keeps IDs monotonic', async () => {
    const { store: tasks } = await store()
    await tasks.create({ subject: 'First', description: 'First description' })
    await tasks.create({ subject: 'Second', description: 'Second description' })
    await tasks.update('2', { addBlockedBy: ['1'] })

    await expect(
      tasks.update('1', { status: 'deleted' }),
    ).resolves.toMatchObject({
      statusChange: { from: 'pending', to: 'deleted' },
    })
    await expect(tasks.get('1')).resolves.toBeNull()
    await expect(tasks.get('2')).resolves.toMatchObject({ blockedBy: [] })
    await expect(
      tasks.create({ subject: 'Third', description: 'Third description' }),
    ).resolves.toMatchObject({ id: '3' })
  })

  it('allocates distinct IDs across concurrent store instances', async () => {
    const { root, taskRoot } = await store()
    const first = new ClaudeTaskStore({
      taskRoot,
      lockFile: join(root, 'first-runtime.lock'),
    })
    const second = new ClaudeTaskStore({
      taskRoot,
      lockFile: join(root, 'second-runtime.lock'),
    })
    const created = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        (index % 2 === 0 ? first : second).create({
          subject: `Task ${index}`,
          description: `Description ${index}`,
        }),
      ),
    )

    expect(new Set(created.map(({ id }) => id)).size).toBe(12)
    await expect(first.list()).resolves.toHaveLength(12)
    await expect(
      readFile(join(taskRoot, '.highwatermark'), 'utf8'),
    ).resolves.toBe('12')
  })

  it('does not regress the high-watermark when independent runtimes overlap', async () => {
    const { root, taskRoot } = await store()
    const first = new ClaudeTaskStore({
      taskRoot,
      lockFile: join(root, 'first-runtime.lock'),
    })
    const second = new ClaudeTaskStore({
      taskRoot,
      lockFile: join(root, 'second-runtime.lock'),
    })
    const internal = first as unknown as {
      atomicWrite(filePath: string, content: string): Promise<void>
    }
    const atomicWrite = internal.atomicWrite.bind(first)
    let entered!: () => void
    let release!: () => void
    const watermarkWriteEntered = new Promise<void>((resolveEntered) => {
      entered = resolveEntered
    })
    const watermarkWriteReleased = new Promise<void>((resolveReleased) => {
      release = resolveReleased
    })
    let delayFirstWatermark = true
    internal.atomicWrite = async (filePath, content) => {
      if (delayFirstWatermark && filePath.endsWith('.highwatermark')) {
        delayFirstWatermark = false
        entered()
        await watermarkWriteReleased
      }
      await atomicWrite(filePath, content)
    }

    const firstCreate = first.create({
      subject: 'First runtime',
      description: 'Delayed watermark writer',
    })
    await watermarkWriteEntered
    const secondTask = await second.create({
      subject: 'Second runtime',
      description: 'Concurrent writer',
    })
    release()
    const firstTask = await firstCreate

    expect(new Set([firstTask.id, secondTask.id])).toEqual(new Set(['1', '2']))
    await expect(
      readFile(join(taskRoot, '.highwatermark'), 'utf8'),
    ).resolves.toBe('2')
  })

  it('reports only fields that actually changed', async () => {
    const { store: tasks } = await store()
    await tasks.create({ subject: 'First', description: 'Description' })

    await expect(
      tasks.update('1', {
        subject: 'First',
        description: 'Description',
        status: 'pending',
        owner: '',
        metadata: { missing: null },
        addBlocks: ['999'],
      }),
    ).resolves.toMatchObject({ updatedFields: [] })
  })

  it('does not rewrite a task when an update makes no changes', async () => {
    const { taskRoot, store: tasks } = await store()
    await tasks.create({ subject: 'First', description: 'Description' })
    const internal = tasks as unknown as {
      atomicWrite(filePath: string, content: string): Promise<unknown>
    }
    const atomicWrite = internal.atomicWrite.bind(tasks)
    let taskWrites = 0
    internal.atomicWrite = async (filePath, content) => {
      if (filePath === join(taskRoot, '1.json')) taskWrites += 1
      return atomicWrite(filePath, content)
    }

    await tasks.update('1', {
      subject: 'First',
      description: 'Description',
      metadata: { missing: null },
    })

    expect(taskWrites).toBe(0)
  })

  it('replays an update over a concurrent native task edit', async () => {
    const { taskRoot, store: tasks } = await store()
    await tasks.create({ subject: 'First', description: 'Description' })
    const taskFile = join(taskRoot, '1.json')
    const internal = tasks as unknown as {
      atomicWrite(
        filePath: string,
        content: string,
        ...rest: unknown[]
      ): Promise<unknown>
    }
    const atomicWrite = internal.atomicWrite.bind(tasks)
    let injected = false
    internal.atomicWrite = async (filePath, content, ...rest) => {
      if (!injected && filePath === taskFile) {
        injected = true
        const native = JSON.parse(await readFile(taskFile, 'utf8')) as Record<
          string,
          unknown
        >
        native.subject = 'Edited by Claude'
        await writeFile(taskFile, JSON.stringify(native, null, 2))
      }
      return atomicWrite(filePath, content, ...rest)
    }

    await tasks.update('1', { metadata: { priority: 'high' } })

    await expect(tasks.get('1')).resolves.toMatchObject({
      subject: 'Edited by Claude',
      metadata: { priority: 'high' },
    })
  })

  it('does not remove a lock replaced by another owner', async () => {
    const { root, taskRoot } = await store()
    const lockFile = join(root, 'owner-safe.lock')
    const tasks = new ClaudeTaskStore({ taskRoot, lockFile })
    await tasks.create({ subject: 'First', description: 'Description' })
    const internal = tasks as unknown as {
      loadTaskRecords(): Promise<unknown[]>
    }
    const loadTaskRecords = internal.loadTaskRecords.bind(tasks)
    let entered!: () => void
    let release!: () => void
    const operationEntered = new Promise<void>((resolveEntered) => {
      entered = resolveEntered
    })
    const operationReleased = new Promise<void>((resolveReleased) => {
      release = resolveReleased
    })
    internal.loadTaskRecords = async () => {
      entered()
      await operationReleased
      return loadTaskRecords()
    }

    const update = tasks.update('1', { status: 'completed' })
    await operationEntered
    await rm(lockFile, { force: true })
    await writeFile(
      lockFile,
      JSON.stringify({
        version: 1,
        pid: process.pid,
        token: 'replacement-owner',
        createdAt: new Date().toISOString(),
      }),
    )
    release()
    await update

    await expect(readFile(lockFile, 'utf8')).resolves.toContain(
      'replacement-owner',
    )
  })

  it('hides internal tasks and their blocker edges from summaries', async () => {
    const { store: tasks } = await store()
    await tasks.create({ subject: 'Internal', description: 'Hidden work' })
    await tasks.create({ subject: 'Public', description: 'Visible work' })
    await tasks.update('1', { metadata: { _internal: true } })
    await tasks.update('2', { addBlockedBy: ['1'] })

    await expect(tasks.listSummaries()).resolves.toEqual([
      { id: '2', subject: 'Public', status: 'pending', blockedBy: [] },
    ])
  })
})
