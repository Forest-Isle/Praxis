import { afterEach, describe, expect, it } from 'vitest'
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
import {
  readNativeTranscript,
  readNativeTranscriptIndexes,
  exportNativeTranscript,
  NATIVE_TRANSCRIPT_INDEX_TAIL_BYTES,
  NativeTranscriptIndexCandidateError,
} from './native-transcript-reader.js'

const roots: string[] = []
const event = {
  kind: 'messages' as const,
  id: '1',
  parentId: null,
  sessionId: '11111111-1111-4111-8111-111111111111',
  timestamp: '2026-08-23T00:00:00.000Z',
  messages: [{ role: 'user' as const, content: 'hello' }],
}
const line = (version: unknown = 1, e: unknown = event) =>
  JSON.stringify({ schema: 'praxis.transcript', version, event: e }) + '\n'

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'praxis-native-reader-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

describe('native transcript reader', () => {
  it('reads full documents, preserves export bytes, and reports unknown versions', async () => {
    const root = await temporaryRoot()
    const path = join(root, 'a.jsonl')
    const source = Buffer.from(line() + line(9))
    await writeFile(path, source)
    const result = await readNativeTranscript(path)
    expect(result.format).toBe('native')
    if (result.format !== 'native') return
    expect(result.issue?.kind).toBe('unsupported-version')
    expect(result.issue).toMatchObject({
      schemaVersion: 9,
      byteOffset: Buffer.byteLength(line()),
    })
    expect(await exportNativeTranscript(path)).toEqual(source)
    expect(await readFile(path)).toEqual(source)
  })
  it('uses real tail offsets for large files and isolates malformed tails', async () => {
    const root = await temporaryRoot()
    const path = join(root, 'large.jsonl')
    const emptyPath = join(root, 'empty-line.jsonl')
    const prefix = line().repeat(3000)
    const source = Buffer.from(prefix + '{bad\n')
    await writeFile(path, source)
    await writeFile(emptyPath, `${prefix}\n`)
    const [corrupt, empty] = await readNativeTranscriptIndexes([
      { sessionId: event.sessionId, path },
      { sessionId: 'empty', path: emptyPath },
    ])
    expect(corrupt && 'result' in corrupt).toBe(true)
    if (
      !corrupt ||
      !('result' in corrupt) ||
      corrupt.result.format !== 'native'
    )
      return
    expect(corrupt.result.issue?.kind).toBe('corrupt-line')
    expect(corrupt.result.issue?.byteOffset).toBe(Buffer.byteLength(prefix))
    expect(empty).toMatchObject({
      result: {
        format: 'native',
        issue: {
          kind: 'corrupt-line',
          byteOffset: Buffer.byteLength(prefix),
        },
      },
    })
  })
  it('keeps healthy large-file windows separate and ignores partial final appends', async () => {
    const root = await temporaryRoot()
    const healthyPath = join(root, 'healthy.jsonl')
    const partialPath = join(root, 'partial.jsonl')
    const completePath = join(root, 'complete.jsonl')
    const healthy = line().repeat(3000)
    const completeFinal = line(1, {
      ...event,
      id: 'complete-final',
      parentId: event.id,
      messages: [{ role: 'user', content: 'complete without newline' }],
    }).trimEnd()
    await writeFile(healthyPath, healthy)
    await writeFile(partialPath, `${healthy}{"schema":"praxis.transcript"`)
    await writeFile(completePath, `${healthy}${completeFinal}`)

    const [healthyResult, partialResult, completeResult] =
      await readNativeTranscriptIndexes([
        { sessionId: 'healthy', path: healthyPath },
        { sessionId: 'partial', path: partialPath },
        { sessionId: 'complete', path: completePath },
      ])

    expect(healthyResult).toMatchObject({
      result: { format: 'native', issue: null, newlineTerminated: true },
    })
    expect(partialResult).toMatchObject({
      result: { format: 'native', issue: null, newlineTerminated: false },
    })
    expect(completeResult).toMatchObject({
      result: { format: 'native', issue: null, newlineTerminated: false },
    })
    if (
      !completeResult ||
      !('result' in completeResult) ||
      completeResult.result.format !== 'native'
    )
      return
    expect(completeResult.result.records.at(-1)).toMatchObject({
      event: { id: 'complete-final' },
    })
  })
  it('reads the complete bounded window between 64 and 192 KiB', async () => {
    const root = await temporaryRoot()
    const path = join(root, 'medium.jsonl')
    const largeFirst = line(1, {
      ...event,
      id: 'large-first',
      messages: [{ role: 'assistant', content: 'x'.repeat(70 * 1024) }],
    })
    const latest = line(1, {
      ...event,
      id: 'latest',
      parentId: 'large-first',
      timestamp: '2026-08-23T00:01:00.000Z',
      messages: [{ role: 'user', content: 'latest prompt' }],
    })
    const validPrefix = `${largeFirst}${latest}`
    const source = `${validPrefix}{bad\n`
    expect(Buffer.byteLength(source)).toBeGreaterThan(64 * 1024)
    expect(Buffer.byteLength(source)).toBeLessThan(192 * 1024)
    await writeFile(path, source)

    const [response] = await readNativeTranscriptIndexes([
      { sessionId: event.sessionId, path },
    ])

    expect(response).toMatchObject({
      result: {
        format: 'native',
        records: [
          { event: { id: 'large-first' } },
          { event: { id: 'latest' } },
        ],
        issue: {
          kind: 'corrupt-line',
          byteOffset: Buffer.byteLength(validPrefix),
        },
        byteLength: Buffer.byteLength(source),
      },
    })
  })
  it('classifies native files with first records larger than the head window', async () => {
    const root = await temporaryRoot()
    const path = join(root, 'long-first-line.jsonl')
    const first = line(1, {
      ...event,
      messages: [{ role: 'user', content: 'x'.repeat(200 * 1024) }],
    })
    const latest = line(1, {
      ...event,
      id: 'latest',
      parentId: event.id,
      timestamp: '2026-08-23T00:01:00.000Z',
      messages: [{ role: 'assistant', content: 'done' }],
    })
    await writeFile(path, `${first}${latest}`)

    const [response] = await readNativeTranscriptIndexes([
      { sessionId: event.sessionId, path },
    ])

    expect(response).toMatchObject({
      result: {
        format: 'native',
        issue: null,
        records: [{ event: { id: 'latest' } }],
      },
    })
  })
  it('classifies canonical native files whose first record exceeds the bounded probe', async () => {
    const root = await temporaryRoot()
    const path = join(root, 'oversized-first-line.jsonl')
    const unknownPath = join(root, 'oversized-unknown-version.jsonl')
    const first = line(1, {
      ...event,
      messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024 + 1) }],
    })
    const latest = line(1, {
      ...event,
      id: 'latest',
      parentId: event.id,
      timestamp: '2026-08-23T00:01:00.000Z',
      messages: [{ role: 'assistant', content: 'done' }],
    })
    await writeFile(path, `${first}${latest}`)
    await writeFile(
      unknownPath,
      line(9, {
        ...event,
        messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024 + 1) }],
      }),
    )

    const [response, unknown] = await readNativeTranscriptIndexes([
      { sessionId: 'known', path },
      { sessionId: 'unknown', path: unknownPath },
    ])

    expect(response).toMatchObject({
      result: {
        format: 'native',
        issue: null,
        records: [{ event: { id: 'latest' } }],
      },
    })
    expect(unknown).toMatchObject({
      result: {
        format: 'native',
        codecVersion: 9,
        records: [],
        issue: {
          kind: 'unsupported-version',
          schemaVersion: 9,
          byteOffset: 0,
          lineNumber: 1,
        },
      },
    })
  })
  it('accepts a complete final native record without a newline terminator', async () => {
    const root = await temporaryRoot()
    const path = join(root, 'unterminated.jsonl')
    const source = line().trimEnd()
    await writeFile(path, source)

    const full = await readNativeTranscript(path)
    const [indexed] = await readNativeTranscriptIndexes([
      { sessionId: event.sessionId, path },
    ])

    expect(full).toMatchObject({
      format: 'native',
      newlineTerminated: false,
      records: [{ event: { id: event.id } }],
    })
    expect(indexed).toMatchObject({
      result: {
        format: 'native',
        newlineTerminated: false,
        records: [{ event: { id: event.id } }],
      },
    })
  })
  it('keeps a complete final record aligned with the large-file tail boundary', async () => {
    const root = await temporaryRoot()
    const path = join(root, 'aligned-tail.jsonl')
    const prefix = line().repeat(400)
    const emptyFinal = line(1, {
      ...event,
      id: 'aligned-final',
      parentId: event.id,
      messages: [{ role: 'user', content: '' }],
    }).trimEnd()
    const final = line(1, {
      ...event,
      id: 'aligned-final',
      parentId: event.id,
      messages: [
        {
          role: 'user',
          content: 'x'.repeat(
            NATIVE_TRANSCRIPT_INDEX_TAIL_BYTES - Buffer.byteLength(emptyFinal),
          ),
        },
      ],
    }).trimEnd()
    expect(Buffer.byteLength(final)).toBe(NATIVE_TRANSCRIPT_INDEX_TAIL_BYTES)
    await writeFile(path, `${prefix}${final}`)

    const [response] = await readNativeTranscriptIndexes([
      { sessionId: event.sessionId, path },
    ])

    expect(response).toMatchObject({
      result: {
        format: 'native',
        newlineTerminated: false,
      },
    })
    if (
      !response ||
      !('result' in response) ||
      response.result.format !== 'native'
    )
      return
    expect(response.result.records.at(-1)).toMatchObject({
      event: { id: 'aligned-final' },
    })
  })
  it('reports exact invalid UTF-8 offsets and unsupported event diagnostics', async () => {
    const root = await temporaryRoot()
    const utf8Path = join(root, 'utf8.jsonl')
    const unsupportedPath = join(root, 'unsupported.jsonl')
    const unsupportedUnterminatedPath = join(
      root,
      'unsupported-unterminated.jsonl',
    )
    const prefix = Buffer.from(line())
    await writeFile(
      utf8Path,
      Buffer.concat([prefix, Buffer.from([0xff, 0x0a])]),
    )
    await writeFile(
      unsupportedPath,
      line(1, {
        ...event,
        kind: 'future-event',
      }),
    )
    await writeFile(
      unsupportedUnterminatedPath,
      line(1, { ...event, kind: 'future-event' }).trimEnd(),
    )

    const [utf8, unsupported, unsupportedUnterminated] =
      await readNativeTranscriptIndexes([
        { sessionId: 'utf8', path: utf8Path },
        { sessionId: 'unsupported', path: unsupportedPath },
        {
          sessionId: 'unsupported-unterminated',
          path: unsupportedUnterminatedPath,
        },
      ])
    expect(utf8).toMatchObject({
      result: {
        issue: {
          kind: 'corrupt-line',
          byteOffset: prefix.length,
        },
      },
    })
    expect(unsupported).toMatchObject({
      result: {
        issue: {
          kind: 'unsupported-event',
          eventKind: 'future-event',
          byteOffset: 0,
        },
      },
    })
    expect(unsupportedUnterminated).toMatchObject({
      result: {
        issue: {
          kind: 'unsupported-event',
          eventKind: 'future-event',
          byteOffset: 0,
        },
      },
    })
  })
  it('keeps a damaged canonical first record in the native diagnostic path', async () => {
    const root = await temporaryRoot()
    const path = join(root, 'damaged-first.jsonl')
    const source = Buffer.from(
      '{"schema":"praxis.transcript","version":1,"event":{bad}\n',
    )
    await writeFile(path, source)

    const full = await readNativeTranscript(path)
    const [indexed] = await readNativeTranscriptIndexes([
      { sessionId: event.sessionId, path },
    ])

    expect(full).toMatchObject({
      format: 'native',
      issue: { kind: 'corrupt-line', byteOffset: 0, lineNumber: 1 },
    })
    expect(indexed).toMatchObject({
      result: {
        format: 'native',
        issue: { kind: 'corrupt-line', byteOffset: 0, lineNumber: 1 },
      },
    })
    expect(await readFile(path)).toEqual(source)
  })
  it('rejects symlinks and preserves request order', async () => {
    const root = await temporaryRoot()
    const a = join(root, 'a.jsonl')
    const b = join(root, 'b.jsonl')
    const link = join(root, 'link.jsonl')
    await writeFile(a, line())
    await writeFile(b, line())
    await symlink(a, link)
    const results = await readNativeTranscriptIndexes(
      [
        { sessionId: 'a', path: a },
        { sessionId: 'b', path: b },
        { sessionId: 'l', path: link },
      ],
      1,
    )
    expect(results.map((item) => item.sessionId)).toEqual(['a', 'b', 'l'])
    expect(results[2]).toHaveProperty('error')
  })
  it('rejects directory candidates without hiding neighboring files', async () => {
    const root = await temporaryRoot()
    const file = join(root, 'file.jsonl')
    const directory = join(root, 'directory.jsonl')
    await writeFile(file, line())
    await mkdir(directory)

    await expect(readNativeTranscript(directory)).rejects.toThrow(
      'Expected a regular file',
    )
    const results = await readNativeTranscriptIndexes([
      { sessionId: 'file', path: file },
      { sessionId: 'directory', path: directory },
    ])
    expect(results[0]).toHaveProperty('result')
    expect(results[1]).toMatchObject({
      error: expect.any(NativeTranscriptIndexCandidateError),
    })
  })
})
