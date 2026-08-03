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

import { selectClaudeSchemaAdapter } from '../compatibility/claude/schema.js'
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

  it('refuses last-prompt metadata for a non-tail leaf', async () => {
    const { store } = await createStore()
    const snapshot = await store.load()

    await expect(
      store.append(snapshot.tail, {
        type: 'last-prompt',
        lastPrompt: 'stale',
        sessionId: '11111111-1111-4111-8111-111111111111',
        leafUuid: '22222222-2222-4222-8222-222222222222',
      }),
    ).rejects.toThrow('leafUuid does not match transcript tail')
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
})
