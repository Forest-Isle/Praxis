import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { selectClaudeSchemaAdapter } from '../compatibility/claude/schema.js'
import {
  CLAUDE_SESSION_INDEX_HEAD_BYTES,
  readClaudeSessionIndex,
} from './claude-session-index.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

describe('bounded Claude session index', () => {
  it('reads head and tail metadata without parsing a large middle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-session-index-'))
    roots.push(root)
    const path = join(root, 'session.jsonl')
    const sessionId = '11111111-1111-4111-8111-111111111111'
    const head = JSON.stringify({
      type: 'user',
      uuid: '22222222-2222-4222-8222-222222222222',
      sessionId,
      message: { role: 'user', content: 'first' },
    })
    const middle = JSON.stringify({ type: 'future', value: 'x'.repeat(256) })
    const tail = JSON.stringify({ type: 'tag', tag: 'current', sessionId })
    await writeFile(
      path,
      `${head}\n${`${middle}\n`.repeat(
        Math.ceil((CLAUDE_SESSION_INDEX_HEAD_BYTES * 4) / middle.length),
      )}${tail}\n`,
    )

    const index = await readClaudeSessionIndex(
      path,
      selectClaudeSchemaAdapter('2.1.208'),
    )

    expect(index.byteLength).toBeGreaterThan(
      CLAUDE_SESSION_INDEX_HEAD_BYTES * 3,
    )
    expect(index.entries[0]).toMatchObject({ type: 'user', sessionId })
    expect(index.entries.at(-1)).toMatchObject({ type: 'tag', tag: 'current' })
    expect(index.issue).toBeNull()
  })

  it('ignores a truncated final line while retaining committed metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-session-index-'))
    roots.push(root)
    const path = join(root, 'session.jsonl')
    await writeFile(
      path,
      `${JSON.stringify({ type: 'custom-title', customTitle: 'ready' })}\n{"type":"last-prompt"`,
    )

    await expect(
      readClaudeSessionIndex(path, selectClaudeSchemaAdapter('2.1.208')),
    ).resolves.toMatchObject({
      entries: [{ type: 'custom-title', customTitle: 'ready' }],
      issue: null,
      newlineTerminated: false,
    })
  })

  it('reports malformed committed lines without throwing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-session-index-'))
    roots.push(root)
    const path = join(root, 'session.jsonl')
    await writeFile(path, '{}\n')

    const index = await readClaudeSessionIndex(
      path,
      selectClaudeSchemaAdapter('2.1.208'),
    )
    expect(index.entries).toEqual([])
    expect(index.issue).toMatchObject({ lineNumber: 1, byteOffset: 0 })
  })

  it('reports an exact byte offset without inventing a large-tail line number', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-session-index-'))
    roots.push(root)
    const path = join(root, 'session.jsonl')
    const sessionId = '11111111-1111-4111-8111-111111111111'
    const head = JSON.stringify({
      type: 'user',
      uuid: '22222222-2222-4222-8222-222222222222',
      sessionId,
      message: { role: 'user', content: 'first' },
    })
    const filler = JSON.stringify({ type: 'future', value: 'x'.repeat(256) })
    const prefix = `${head}\n${`${filler}\n`.repeat(1_000)}`
    await writeFile(path, `${prefix}{}\n`)

    const index = await readClaudeSessionIndex(
      path,
      selectClaudeSchemaAdapter('2.1.208'),
    )

    expect(index.issue).toEqual({
      lineNumber: null,
      byteOffset: Buffer.byteLength(prefix),
      message: expect.any(String),
    })
  })
})
