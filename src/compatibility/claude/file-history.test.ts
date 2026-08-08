import { randomUUID } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ClaudeFileHistory } from './file-history.js'
import type { ClaudeTranscriptEntry } from './schema.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

function user(uuid: string): ClaudeTranscriptEntry {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content: 'prompt' },
  }
}

describe('ClaudeFileHistory', () => {
  it('records native snapshots and restores existing and newly created files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-file-history-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'work')
    await mkdir(cwd)
    const existing = join(cwd, 'existing.txt')
    const created = join(cwd, 'created.txt')
    await writeFile(existing, 'original')
    const sessionId = randomUUID()
    const firstId = randomUUID()
    const assistantId = randomUUID()
    const history = new ClaudeFileHistory(configRoot, sessionId, [cwd])
    const entries: ClaudeTranscriptEntry[] = [user(firstId)]
    const snapshot = await history.snapshot(entries, firstId)
    entries.push(snapshot)

    const existingBackup = await history.prepareMutation(
      entries,
      firstId,
      existing,
    )
    await writeFile(existing, 'changed')
    const existingDelta = existingBackup.commit(assistantId)
    expect(existingDelta).not.toBeNull()
    entries.push(existingDelta as ClaudeTranscriptEntry)
    const createdBackup = await history.prepareMutation(
      entries,
      firstId,
      created,
    )
    await writeFile(created, 'created')
    entries.push(createdBackup.commit(assistantId) as ClaudeTranscriptEntry)

    await writeFile(existing, 'external')
    await history.rewind(entries, firstId)

    await expect(readFile(existing, 'utf8')).resolves.toBe('original')
    await expect(readFile(created, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('captures current tracked state at each later user message', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-file-snapshot-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'work')
    await mkdir(cwd)
    const path = join(cwd, 'tracked.txt')
    await writeFile(path, 'first')
    const history = new ClaudeFileHistory(configRoot, randomUUID(), [cwd])
    const firstId = randomUUID()
    const entries: ClaudeTranscriptEntry[] = [user(firstId)]
    entries.push(await history.snapshot(entries, firstId))
    const mutation = await history.prepareMutation(entries, firstId, path)
    await writeFile(path, 'second')
    entries.push(mutation.commit(randomUUID()) as ClaudeTranscriptEntry)
    const secondId = randomUUID()
    entries.push(user(secondId))
    entries.push(await history.snapshot(entries, secondId))
    await writeFile(path, 'external')

    await history.rewind(entries, secondId)

    await expect(readFile(path, 'utf8')).resolves.toBe('second')
  })

  it('treats Claude relative and Praxis absolute tracking paths as the same file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-relative-history-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'work')
    await mkdir(cwd)
    const path = join(cwd, 'tracked.txt')
    await writeFile(path, 'original')
    const history = new ClaudeFileHistory(configRoot, randomUUID(), [cwd])
    const messageId = randomUUID()
    const entries: ClaudeTranscriptEntry[] = [
      user(messageId),
      {
        type: 'file-history-snapshot',
        messageId,
        snapshot: {
          messageId,
          trackedFileBackups: {
            'tracked.txt': {
              backupFileName: null,
              version: 1,
              backupTime: new Date().toISOString(),
            },
          },
          timestamp: new Date().toISOString(),
        },
        isSnapshotUpdate: false,
      },
    ]

    const mutation = await history.prepareMutation(entries, messageId, path)

    expect(mutation.commit(randomUUID())).toBeNull()
  })

  it('rejects non-user targets and paths outside allowed roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-file-boundary-'))
    roots.push(root)
    const cwd = join(root, 'work')
    const outside = join(root, 'outside')
    await Promise.all([mkdir(cwd), mkdir(outside)])
    const history = new ClaudeFileHistory(join(root, 'config'), randomUUID(), [
      cwd,
    ])
    await expect(history.rewind([], randomUUID())).rejects.toThrow(
      /not a user message/,
    )
    const id = randomUUID()
    const entries = [user(id), await history.snapshot([user(id)], id)]
    await expect(
      history.prepareMutation(entries, id, join(outside, 'file.txt')),
    ).rejects.toThrow(/outside allowed roots/)
    await symlink(outside, join(cwd, 'escape'))
    await expect(
      history.prepareMutation(entries, id, join(cwd, 'escape', 'file.txt')),
    ).rejects.toThrow(/outside allowed roots/)
  })
})
