import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { selectClaudeActiveTranscript } from '../compatibility/claude/history.js'
import { selectClaudeSchemaAdapter } from '../compatibility/claude/schema.js'
import { findUnresolvedClaudeToolCalls } from '../compatibility/claude/tool-links.js'
import {
  ClaudeTranscriptStore,
  classifyTranscriptAppend,
} from './claude-transcript-store.js'

const fixtureUrl = new URL(
  '../../test/fixtures/claude-code/2.1.208/basic-session.jsonl',
  import.meta.url,
)
const tempDirectories: string[] = []

async function createStore() {
  const root = await mkdtemp(join(tmpdir(), 'praxis-transcript-test-'))
  tempDirectories.push(root)
  const sessionFile = join(root, 'projects', 'fixture', 'session.jsonl')
  const lockFile = join(root, 'praxis', 'locks', 'session.lock')
  await mkdir(join(root, 'projects', 'fixture'), { recursive: true })
  await copyFile(fixtureUrl, sessionFile)

  return {
    root,
    sessionFile,
    lockFile,
    store: new ClaudeTranscriptStore({
      sessionFile,
      lockFile,
      schema: selectClaudeSchemaAdapter('2.1.208'),
    }),
  }
}

function firstEntry(
  snapshot: Awaited<ReturnType<ClaudeTranscriptStore['load']>>,
) {
  const entry = snapshot.entries[0]
  if (!entry) throw new Error('Fixture has no entries')
  return entry
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  )
})

describe('ClaudeTranscriptStore', () => {
  it('classifies unexpected bytes around an append as interleaving', () => {
    const before = Buffer.from('{"history":true}\n')
    const line = Buffer.from('{"type":"user"}\n')

    expect(
      classifyTranscriptAppend(
        Buffer.concat([before, line]),
        before.length,
        line,
      ),
    ).toBe('appended')
    expect(
      classifyTranscriptAppend(
        Buffer.concat([before, line, Buffer.from('external\n')]),
        before.length,
        line,
      ),
    ).toBe('interleaved-write')
    expect(
      classifyTranscriptAppend(
        Buffer.concat([before, Buffer.from('x'), line]),
        before.length,
        line,
      ),
    ).toBe('interleaved-write')
  })

  it('loads native entries and identifies the append parent', async () => {
    const { store } = await createStore()

    const snapshot = await store.load()

    expect(snapshot.entries).toHaveLength(3)
    expect(snapshot.tail.lastUuid).toBe('33333333-3333-4333-8333-333333333333')
    expect(snapshot.tail.byteLength).toBeGreaterThan(0)
    expect(snapshot.tail.lastLineHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('appends one complete native JSONL entry without rewriting history', async () => {
    const { sessionFile, store } = await createStore()
    const before = await readFile(sessionFile, 'utf8')
    const snapshot = await store.load()
    const entry = {
      ...firstEntry(snapshot),
      uuid: '55555555-5555-4555-8555-555555555555',
      parentUuid: snapshot.tail.lastUuid,
      timestamp: '2026-08-03T08:00:02.000Z',
      message: { role: 'user', content: 'continue' },
    }

    const result = await store.append(snapshot.tail, entry)
    const after = await readFile(sessionFile, 'utf8')

    expect(result.status).toBe('appended')
    expect(after.startsWith(before)).toBe(true)
    expect(after.slice(before.length)).toBe(`${JSON.stringify(entry)}\n`)
  })

  it('branches from an earlier message while retaining physical tail checks', async () => {
    const { sessionFile, store } = await createStore()
    const before = await readFile(sessionFile, 'utf8')
    const snapshot = await store.load()
    const targetUuid = snapshot.entries[0]?.uuid
    if (typeof targetUuid !== 'string')
      throw new Error('Fixture target missing')
    const branchTail = { ...snapshot.tail, branchParentUuid: targetUuid }

    const metadata = await store.append(branchTail, {
      type: 'custom-title',
      customTitle: 'Rewound branch',
      sessionId: String(snapshot.entries[0]?.sessionId),
    })
    expect(metadata).toMatchObject({
      status: 'appended',
      tail: { branchParentUuid: targetUuid },
    })
    if (metadata.status !== 'appended') throw new Error(metadata.reason)

    const branch = {
      ...firstEntry(snapshot),
      uuid: '56565656-5656-4656-8656-565656565656',
      parentUuid: targetUuid,
      timestamp: '2026-08-03T08:00:03.000Z',
      message: { role: 'user', content: 'branch prompt' },
    }
    await expect(store.append(metadata.tail, branch)).resolves.toMatchObject({
      status: 'appended',
      tail: { lastUuid: branch.uuid },
    })
    const after = await readFile(sessionFile, 'utf8')
    expect(after.startsWith(before)).toBe(true)
    expect(after).toContain(`"parentUuid":"${targetUuid}"`)
  })

  it('atomically appends a compact boundary and summary under one tail check', async () => {
    const { sessionFile, store } = await createStore()
    const before = await readFile(sessionFile, 'utf8')
    const snapshot = await store.load()
    const compactedPrefixUuid = firstEntry(snapshot).uuid
    const boundary = {
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      isMeta: false,
      level: 'info',
      logicalParentUuid: compactedPrefixUuid,
      compactMetadata: {
        trigger: 'auto',
        preTokens: 100,
        durationMs: 2,
        preservedSegment: {
          headUuid: compactedPrefixUuid,
          anchorUuid: 'compact-summary',
          tailUuid: compactedPrefixUuid,
        },
        preservedMessages: {
          anchorUuid: 'compact-summary',
          uuids: [compactedPrefixUuid],
          allUuids: [compactedPrefixUuid],
        },
        postTokens: 20,
        cumulativeDroppedTokens: 80,
      },
      parentUuid: null,
      isSidechain: false,
      userType: 'external',
      entrypoint: 'cli',
      cwd: '/tmp/praxis-fixture',
      sessionId: '11111111-1111-4111-8111-111111111111',
      version: '2.1.208',
      gitBranch: null,
      timestamp: '2026-08-04T00:00:00.000Z',
      uuid: 'compact-boundary',
    }
    const summary = {
      parentUuid: 'compact-boundary',
      isSidechain: false,
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
      message: { role: 'user', content: 'COMPACT_SUMMARY' },
      type: 'user',
      uuid: 'compact-summary',
      timestamp: '2026-08-04T00:00:00.000Z',
      userType: 'external',
      promptId: 'compact-summary',
      cwd: '/tmp/praxis-fixture',
      sessionId: '11111111-1111-4111-8111-111111111111',
      version: '2.1.208',
      gitBranch: null,
      entrypoint: 'cli',
    }

    const leaseResult = await store.withLease((lease) =>
      lease.appendMany(snapshot.tail, [boundary, summary]),
    )
    const after = await readFile(sessionFile, 'utf8')

    expect(leaseResult).toMatchObject({
      status: 'completed',
      value: { status: 'appended', tail: { lastUuid: 'compact-summary' } },
    })
    expect(after).toBe(
      `${before}${JSON.stringify(boundary)}\n${JSON.stringify(summary)}\n`,
    )
  })

  it('appends a local command as a normal tail-advancing system entry', async () => {
    const { sessionFile, store } = await createStore()
    const snapshot = await store.load()
    const entry = {
      type: 'system',
      subtype: 'local_command',
      content: '<command-name>/cd</command-name>',
      isMeta: false,
      level: 'info',
      parentUuid: snapshot.tail.lastUuid,
      isSidechain: false,
      userType: 'external',
      entrypoint: 'cli',
      cwd: '/tmp/praxis-fixture',
      sessionId: '11111111-1111-4111-8111-111111111111',
      version: '2.1.208',
      gitBranch: null,
      timestamp: '2026-08-04T00:00:00.000Z',
      uuid: 'local-command',
    }

    await expect(store.append(snapshot.tail, entry)).resolves.toMatchObject({
      status: 'appended',
      tail: { lastUuid: entry.uuid },
    })
    await expect(readFile(sessionFile, 'utf8')).resolves.toContain(
      `${JSON.stringify(entry)}\n`,
    )
  })

  it('creates a fork transcript exclusively without linearizing native entries', async () => {
    const source = await createStore()
    const snapshot = await source.store.load()
    const targetRoot = await mkdtemp(join(tmpdir(), 'praxis-transcript-test-'))
    tempDirectories.push(targetRoot)
    const sessionFile = join(targetRoot, 'projects', 'fixture', 'fork.jsonl')
    const target = new ClaudeTranscriptStore({
      sessionFile,
      lockFile: join(targetRoot, 'praxis', 'locks', 'fork.lock'),
      schema: selectClaudeSchemaAdapter('2.1.208'),
    })

    const created = await target.create(snapshot.entries)

    expect(created.status).toBe('created')
    expect((await target.load()).entries).toEqual(snapshot.entries)
    await expect(target.create(snapshot.entries)).resolves.toEqual({
      status: 'conflict',
      reason: 'already-exists',
    })
  })

  it('reserves an empty transcript exclusively', async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), 'praxis-transcript-test-'))
    tempDirectories.push(targetRoot)
    const sessionFile = join(
      targetRoot,
      'projects',
      'fixture',
      'reserved.jsonl',
    )
    const target = new ClaudeTranscriptStore({
      sessionFile,
      lockFile: join(targetRoot, 'praxis', 'locks', 'reserved.lock'),
      schema: selectClaudeSchemaAdapter('2.1.208'),
    })

    await expect(target.reserve()).resolves.toEqual({ status: 'reserved' })
    await expect(readFile(sessionFile, 'utf8')).resolves.toBe('')
    await expect(target.reserve()).resolves.toEqual({
      status: 'conflict',
      reason: 'already-exists',
    })
  })

  it('appends native session naming metadata without advancing the logical tail', async () => {
    const { sessionFile, store } = await createStore()
    const snapshot = await store.load()
    const entries = [
      {
        type: 'custom-title',
        customTitle: 'Named session',
        sessionId: '11111111-1111-4111-8111-111111111111',
      },
      {
        type: 'agent-name',
        agentName: 'Named session',
        sessionId: '11111111-1111-4111-8111-111111111111',
      },
    ]

    const result = await store.withLease((lease) =>
      lease.appendMany(snapshot.tail, entries),
    )

    expect(result).toMatchObject({
      status: 'completed',
      value: { status: 'appended', tail: { lastUuid: snapshot.tail.lastUuid } },
    })
    const source = await readFile(sessionFile, 'utf8')
    expect(
      source.endsWith(
        `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
      ),
    ).toBe(true)
  })

  it('appends native last-prompt metadata without advancing the logical tail', async () => {
    const { sessionFile, store } = await createStore()
    const snapshot = await store.load()
    const entry = {
      type: 'last-prompt',
      lastPrompt: 'continue',
      sessionId: '11111111-1111-4111-8111-111111111111',
      leafUuid: snapshot.tail.lastUuid,
    }

    const result = await store.append(snapshot.tail, entry)
    const after = await store.load()

    expect(result).toMatchObject({
      status: 'appended',
      tail: { lastUuid: snapshot.tail.lastUuid },
    })
    expect(after.entries.at(-1)).toEqual(entry)
    expect(
      (await readFile(sessionFile, 'utf8')).endsWith(
        `${JSON.stringify(entry)}\n`,
      ),
    ).toBe(true)
  })

  it('appends native PR link metadata without advancing the logical tail', async () => {
    const { sessionFile, store } = await createStore()
    const snapshot = await store.load()
    const entry = {
      type: 'pr-link',
      sessionId: '11111111-1111-4111-8111-111111111111',
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      prRepository: 'owner/repo',
      timestamp: '2026-08-08T00:00:00.000Z',
    }

    const result = await store.append(snapshot.tail, entry)

    expect(result).toMatchObject({
      status: 'appended',
      tail: { lastUuid: snapshot.tail.lastUuid },
    })
    expect(await readFile(sessionFile, 'utf8')).toContain(
      `${JSON.stringify(entry)}\n`,
    )
  })

  it('returns a tail-changed conflict for stale last-prompt metadata without writing', async () => {
    const { sessionFile, store } = await createStore()
    const snapshot = await store.load()
    const before = await readFile(sessionFile, 'utf8')
    const entry = {
      type: 'last-prompt',
      lastPrompt: 'stale',
      sessionId: '11111111-1111-4111-8111-111111111111',
      leafUuid: '22222222-2222-4222-8222-222222222222',
    }

    const result = await store.append(snapshot.tail, entry)

    expect(result).toEqual({ status: 'conflict', reason: 'tail-changed' })
    expect(await readFile(sessionFile, 'utf8')).toBe(before)
    expect((await store.load()).entries.at(-1)).not.toEqual(entry)
  })

  it('refuses last-prompt metadata unless the tail is an assistant in the same session', async () => {
    const first = await createStore()
    const firstSnapshot = await first.store.load()

    await expect(
      first.store.append(firstSnapshot.tail, {
        type: 'last-prompt',
        lastPrompt: 'wrong session',
        sessionId: '99999999-9999-4999-8999-999999999999',
        leafUuid: firstSnapshot.tail.lastUuid,
      }),
    ).rejects.toThrow('same session')

    const second = await createStore()
    const secondSnapshot = await second.store.load()
    const userEntry = {
      ...firstEntry(secondSnapshot),
      uuid: '55555555-5555-4555-8555-555555555555',
      parentUuid: secondSnapshot.tail.lastUuid,
      timestamp: '2026-08-03T08:00:02.000Z',
      message: { role: 'user', content: 'unfinished' },
    }
    const userResult = await second.store.append(secondSnapshot.tail, userEntry)
    if (userResult.status !== 'appended') {
      throw new Error('Could not append user fixture')
    }

    await expect(
      second.store.append(userResult.tail, {
        type: 'last-prompt',
        lastPrompt: 'unfinished',
        sessionId: '11111111-1111-4111-8111-111111111111',
        leafUuid: userEntry.uuid,
      }),
    ).rejects.toThrow('final assistant leaf')
  })

  it('refuses to append when an uncooperative writer advanced the tail', async () => {
    const { sessionFile, store } = await createStore()
    const snapshot = await store.load()
    const externalLine =
      '{"type":"assistant","uuid":"66666666-6666-4666-8666-666666666666"}\n'
    await appendFile(sessionFile, externalLine)
    const afterExternalWrite = await readFile(sessionFile, 'utf8')

    const result = await store.append(snapshot.tail, {
      ...firstEntry(snapshot),
      uuid: '55555555-5555-4555-8555-555555555555',
      parentUuid: snapshot.tail.lastUuid,
    })

    expect(result).toMatchObject({ status: 'conflict', reason: 'tail-changed' })
    expect(await readFile(sessionFile, 'utf8')).toBe(afterExternalWrite)
  })

  it('refuses a stale parent even when the expected tail fingerprint is current', async () => {
    const { store } = await createStore()
    const snapshot = await store.load()

    await expect(
      store.append(snapshot.tail, {
        ...firstEntry(snapshot),
        uuid: '55555555-5555-4555-8555-555555555555',
        parentUuid: null,
      }),
    ).rejects.toThrow('parentUuid does not match transcript tail')
  })

  it('refuses a tool result without its matching assistant tool call', async () => {
    const { store } = await createStore()
    const snapshot = await store.load()

    await expect(
      store.append(snapshot.tail, {
        ...firstEntry(snapshot),
        uuid: '55555555-5555-4555-8555-555555555555',
        parentUuid: snapshot.tail.lastUuid,
        sourceToolAssistantUUID: snapshot.tail.lastUuid,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_missing',
              content: 'unexpected',
              is_error: false,
            },
          ],
        },
      }),
    ).rejects.toThrow('no matching assistant tool_use')
  })

  it('refuses duplicate tool IDs within one appended entry', async () => {
    const first = await createStore()
    const firstSnapshot = await first.store.load()
    const assistantTemplate = firstSnapshot.entries.find(
      (entry) => entry.type === 'assistant',
    )
    if (!assistantTemplate) throw new Error('Fixture has no assistant entry')
    const toolBlock = {
      type: 'tool_use',
      id: 'call_duplicate',
      name: 'Bash',
      input: { command: 'pwd' },
    }

    await expect(
      first.store.append(firstSnapshot.tail, {
        ...assistantTemplate,
        uuid: '55555555-5555-4555-8555-555555555555',
        parentUuid: firstSnapshot.tail.lastUuid,
        message: {
          ...(assistantTemplate.message as Record<string, unknown>),
          content: [toolBlock, toolBlock],
          stop_reason: 'tool_use',
        },
      }),
    ).rejects.toThrow('Duplicate assistant tool_use id')

    const second = await createStore()
    const secondSnapshot = await second.store.load()
    const appendedToolCall = {
      ...assistantTemplate,
      uuid: '66666666-6666-4666-8666-666666666666',
      parentUuid: secondSnapshot.tail.lastUuid,
      message: {
        ...(assistantTemplate.message as Record<string, unknown>),
        content: [toolBlock],
        stop_reason: 'tool_use',
      },
    }
    const toolCallResult = await second.store.append(
      secondSnapshot.tail,
      appendedToolCall,
    )
    if (toolCallResult.status !== 'appended') {
      throw new Error('Could not append tool call fixture')
    }
    const resultBlock = {
      type: 'tool_result',
      tool_use_id: 'call_duplicate',
      content: 'result',
      is_error: false,
    }

    await expect(
      second.store.append(toolCallResult.tail, {
        ...firstEntry(secondSnapshot),
        uuid: '77777777-7777-4777-8777-777777777777',
        parentUuid: toolCallResult.tail.lastUuid,
        sourceToolAssistantUUID: appendedToolCall.uuid,
        message: { role: 'user', content: [resultBlock, resultBlock] },
      }),
    ).rejects.toThrow('Tool result already exists')
  })

  it('honors a Praxis advisory lock', async () => {
    const { lockFile, store } = await createStore()
    const snapshot = await store.load()
    await mkdir(dirname(lockFile), { recursive: true })
    await writeFile(lockFile, 'other-writer')

    const result = await store.append(snapshot.tail, {
      ...firstEntry(snapshot),
      uuid: '55555555-5555-4555-8555-555555555555',
      parentUuid: snapshot.tail.lastUuid,
    })

    expect(result).toEqual({ status: 'conflict', reason: 'locked' })
  })

  it('reclaims a lock owned by a dead Praxis process', async () => {
    const { lockFile, store } = await createStore()
    const snapshot = await store.load()
    await mkdir(dirname(lockFile), { recursive: true })
    await writeFile(
      lockFile,
      JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        token: 'stale-owner',
        createdAt: '2026-08-01T00:00:00.000Z',
      }),
    )

    const result = await store.append(snapshot.tail, {
      ...firstEntry(snapshot),
      uuid: '55555555-5555-4555-8555-555555555555',
      parentUuid: snapshot.tail.lastUuid,
    })

    expect(result.status).toBe('appended')
    await expect(readFile(lockFile, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('keeps a lock owned by the current live process', async () => {
    const { lockFile, store } = await createStore()
    await mkdir(dirname(lockFile), { recursive: true })
    await writeFile(
      lockFile,
      JSON.stringify({
        version: 1,
        pid: process.pid,
        token: 'live-owner',
        createdAt: '2026-08-04T00:00:00.000Z',
      }),
    )

    await expect(store.withLease(async () => 'unexpected')).resolves.toEqual({
      status: 'conflict',
      reason: 'locked',
    })
    expect(await readFile(lockFile, 'utf8')).toContain('live-owner')
  })

  it('cleans bounded dead-owner lock artifacts without touching live or unknown files', async () => {
    const { lockFile, store } = await createStore()
    const deadOwner = {
      version: 1,
      pid: 2_147_483_647,
      token: 'dead-artifact',
      createdAt: '2026-08-01T00:00:00.000Z',
    }
    const deadArtifacts = [
      `${lockFile}.dead-artifact.candidate`,
      `${lockFile}.old-owner.reclaim.dead-artifact.stale`,
    ]
    const reusableReclaimGuard = `${lockFile}.old-owner.reclaim`
    const liveArtifact = `${lockFile}.live-artifact.candidate`
    const liveStaleArtifact = `${lockFile}.old-owner.reclaim.live-artifact.stale`
    const unknownArtifact = `${lockFile}.unknown.candidate`
    await mkdir(dirname(lockFile), { recursive: true })
    await Promise.all([
      ...deadArtifacts.map((path) =>
        writeFile(path, JSON.stringify(deadOwner)),
      ),
      writeFile(reusableReclaimGuard, JSON.stringify(deadOwner)),
      writeFile(
        liveArtifact,
        JSON.stringify({
          ...deadOwner,
          pid: process.pid,
          token: 'live-artifact',
        }),
      ),
      writeFile(liveStaleArtifact, JSON.stringify(deadOwner)),
      writeFile(unknownArtifact, 'unknown-owner'),
    ])

    await expect(store.withLease(async () => 'completed')).resolves.toEqual({
      status: 'completed',
      value: 'completed',
    })
    for (const path of deadArtifacts) {
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    await expect(readFile(liveArtifact, 'utf8')).resolves.toContain(
      'live-artifact',
    )
    await expect(readFile(liveStaleArtifact, 'utf8')).resolves.toContain(
      'dead-artifact',
    )
    await expect(readFile(reusableReclaimGuard, 'utf8')).resolves.toContain(
      'dead-artifact',
    )
    await expect(readFile(unknownArtifact, 'utf8')).resolves.toBe(
      'unknown-owner',
    )
  })

  it('keeps concurrent writers serialized while reclaiming a stale guard', async () => {
    const { lockFile, store } = await createStore()
    const staleOwner = {
      version: 1,
      pid: 2_147_483_647,
      token: 'stale-owner',
      createdAt: '2026-08-01T00:00:00.000Z',
    }
    await mkdir(dirname(lockFile), { recursive: true })
    await writeFile(lockFile, JSON.stringify(staleOwner))
    await writeFile(
      `${lockFile}.${staleOwner.token}.reclaim`,
      JSON.stringify({ ...staleOwner, token: 'stale-reclaimer' }),
    )
    let activeWriters = 0
    let maximumActiveWriters = 0

    await Promise.all(
      Array.from({ length: 16 }, () =>
        store.withLease(async () => {
          activeWriters += 1
          maximumActiveWriters = Math.max(maximumActiveWriters, activeWriters)
          await new Promise((resolve) => setTimeout(resolve, 10))
          activeWriters -= 1
        }),
      ),
    )

    expect(maximumActiveWriters).toBeLessThanOrEqual(1)
    await expect(store.withLease(async () => 'recovered')).resolves.toEqual({
      status: 'completed',
      value: 'recovered',
    })
  })

  it('recovers an orphaned parallel tool result on both load paths without touching the source', async () => {
    const { sessionFile, store } = await createStore()
    const assistantUuid = 'rrrr0000-0000-4000-8000-000000000002'
    const resultUuid = 'rrrr0000-0000-4000-8000-000000000003'
    const entries = [
      {
        type: 'user',
        uuid: 'rrrr0000-0000-4000-8000-000000000001',
        parentUuid: null,
        message: { role: 'user', content: 'start' },
      },
      {
        type: 'assistant',
        uuid: assistantUuid,
        parentUuid: 'rrrr0000-0000-4000-8000-000000000001',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_orphan',
              name: 'Bash',
              input: { command: 'pwd' },
            },
            {
              type: 'tool_use',
              id: 'call_linked',
              name: 'Bash',
              input: { command: 'true' },
            },
            {
              type: 'tool_use',
              id: 'call_dup',
              name: 'Bash',
              input: { command: 'true' },
            },
          ],
        },
      },
      {
        type: 'user',
        uuid: resultUuid,
        parentUuid: assistantUuid,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_orphan',
              content: 'ok',
              is_error: false,
            },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'rrrr0000-0000-4000-8000-000000000004',
        parentUuid: assistantUuid,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_missing',
              content: 'unknown',
              is_error: false,
            },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'rrrr0000-0000-4000-8000-000000000005',
        parentUuid: assistantUuid,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_dup',
              content: 'first',
              is_error: false,
            },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'rrrr0000-0000-4000-8000-000000000006',
        parentUuid: assistantUuid,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_dup',
              content: 'second',
              is_error: false,
            },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'rrrr0000-0000-4000-8000-000000000007',
        parentUuid: assistantUuid,
        sourceToolAssistantUUID: assistantUuid,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_linked',
              content: 'linked',
              is_error: false,
            },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'rrrr0000-0000-4000-8000-000000000008',
        parentUuid: assistantUuid,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 42,
              content: 'malformed',
              is_error: false,
            },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'rrrr0000-0000-4000-8000-000000000009',
        parentUuid: assistantUuid,
        message: { role: 'user', content: 'continue' },
      },
      {
        type: 'assistant',
        uuid: 'rrrr0000-0000-4000-8000-000000000010',
        parentUuid: 'rrrr0000-0000-4000-8000-000000000009',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
        },
      },
    ]
    const encodedLines = entries.map((entry) => JSON.stringify(entry))
    const source = `${encodedLines.join('\n')}\n`
    await writeFile(sessionFile, source)

    const snapshot = await store.load()

    // The orphaned result is linked in memory to its unique assistant tool_use.
    expect(snapshot.entries[2]).toMatchObject({
      uuid: resultUuid,
      sourceToolAssistantUUID: assistantUuid,
    })
    // Unknown, duplicate, and malformed results remain unrecovered.
    const entry3 = snapshot.entries[3]
    const entry4 = snapshot.entries[4]
    const entry5 = snapshot.entries[5]
    const entry7 = snapshot.entries[7]
    if (!entry3 || !entry4 || !entry5 || !entry7)
      throw new Error('Fixture recovery entries missing')
    expect(entry3.sourceToolAssistantUUID).toBeUndefined()
    expect(entry4.sourceToolAssistantUUID).toBeUndefined()
    expect(entry5.sourceToolAssistantUUID).toBeUndefined()
    expect(entry7.sourceToolAssistantUUID).toBeUndefined()
    // An already-correct link is never rewritten.
    const entry6 = snapshot.entries[6]
    if (!entry6) throw new Error('Fixture recovery entry missing')
    expect(entry6.sourceToolAssistantUUID).toBe(assistantUuid)

    // Resume projection retains the recovered result and sees the call as
    // completed rather than unresolved.
    const active = selectClaudeActiveTranscript(snapshot.entries)
    expect(active.some((entry) => entry.uuid === resultUuid)).toBe(true)
    const unresolved = findUnresolvedClaudeToolCalls(snapshot.entries)
    expect(unresolved.map((call) => call.id)).not.toContain('call_orphan')
    expect(unresolved.map((call) => call.id)).toEqual(['call_dup'])

    // The read-only load path recovers the same in-memory link.
    const recovery = await store.loadReadOnly()
    expect(recovery.entries[2]).toMatchObject({
      uuid: resultUuid,
      sourceToolAssistantUUID: assistantUuid,
    })
    expect(recovery.issue).toBeNull()

    // Recovery never mutates the JSONL source bytes.
    expect(await readFile(sessionFile, 'utf8')).toBe(source)
    expect(Buffer.from(await store.exportReadOnly())).toEqual(
      Buffer.from(source),
    )
  })

  it('reports corrupt JSONL position and exposes read-only recovery', async () => {
    const { sessionFile, store } = await createStore()
    const firstLine = (await readFile(fixtureUrl, 'utf8')).split('\n')[0]
    if (!firstLine) throw new Error('Fixture has no first line')
    await writeFile(sessionFile, `${firstLine}\n{\n`)

    await expect(store.load()).rejects.toMatchObject({
      name: 'ClaudeTranscriptParseError',
      lineNumber: 2,
      byteOffset: Buffer.byteLength(`${firstLine}\n`),
    })

    const recovery = await store.loadReadOnly()
    expect(recovery.entries).toHaveLength(1)
    expect(recovery.issue).toMatchObject({
      lineNumber: 2,
      byteOffset: Buffer.byteLength(`${firstLine}\n`),
    })
  })

  it('preserves invalid UTF-8 bytes during read-only recovery and export', async () => {
    const { sessionFile, store } = await createStore()
    const firstLine = (await readFile(fixtureUrl, 'utf8')).split('\n')[0]
    if (!firstLine) throw new Error('Fixture has no first line')
    const prefix = Buffer.from(`${firstLine}\n`)
    const source = Buffer.concat([prefix, Buffer.from([0xff, 0x0a])])
    await writeFile(sessionFile, source)

    const recovery = await store.loadReadOnly()

    expect(recovery.entries).toHaveLength(1)
    expect(recovery.issue).toMatchObject({
      lineNumber: 2,
      byteOffset: prefix.length,
    })
    expect(Buffer.from(await store.exportReadOnly())).toEqual(source)
  })

  it.each([Buffer.alloc(0), Buffer.from('\n')])(
    'reports empty read-only recovery at the first byte',
    async (source) => {
      const { sessionFile, store } = await createStore()
      await writeFile(sessionFile, source)

      await expect(store.loadReadOnly()).resolves.toMatchObject({
        entries: [],
        issue: {
          lineNumber: 1,
          byteOffset: 0,
          message: 'Claude transcript contains no entries',
        },
      })
      expect(await store.exportReadOnly()).toEqual(source)
    },
  )
})
