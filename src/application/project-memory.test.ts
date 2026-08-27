import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ModelToolCall } from '../core/runtime.js'
import {
  loadProjectMemoryIndex,
  listProjectMemoryCandidates,
  parseProjectMemoryTopic,
  ProjectMemoryExtractionController,
  ProjectMemoryAgentExtractor,
  ProjectMemoryModelSelector,
  ProjectMemoryRecallController,
  type ProjectMemoryCandidate,
  type ProjectMemoryExtractorInput,
  type ProjectMemoryRecallHandle,
  type ProjectMemoryRecallPayload,
} from './project-memory.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise<void>((resolve) => setImmediate(resolve))
}

async function consumeRecall(
  handle: ProjectMemoryRecallHandle,
): Promise<ProjectMemoryRecallPayload> {
  let payload: ProjectMemoryRecallPayload | null = null
  await vi.waitFor(() => {
    payload = handle.consumeIfSettled()
    expect(payload).not.toBeNull()
  })
  if (!payload) throw new Error('Project-memory recall did not settle')
  return payload
}

function attachmentBlocks(payload: ProjectMemoryRecallPayload): string[] {
  return (
    payload.content.match(/<project-memory[\s\S]*?<\/project-memory>/gu) ?? []
  )
}

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('Project memory', () => {
  it('bounds the injected index by both lines and UTF-8 bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-project-memory-'))
    roots.push(root)
    const indexPath = join(root, 'MEMORY.md')
    await writeFile(
      indexPath,
      Array.from(
        { length: 250 },
        (_, index) =>
          `${String(index + 1).padStart(3, '0')} ${'界'.repeat(100)}`,
      ).join('\n'),
    )

    const index = await loadProjectMemoryIndex(root)

    expect(index?.content.split('\n')).toHaveLength(84)
    expect(Buffer.byteLength(index?.content ?? '', 'utf8')).toBeLessThanOrEqual(
      25 * 1024,
    )
    expect(index?.content).toContain('001 ')
    expect(index?.content).not.toContain('201 ')
  })

  it('parses typed topics and keeps legacy or unknown types readable', () => {
    expect(
      parseProjectMemoryTopic(
        '/memory/preferences.md',
        '---\nname: Preferences\ndescription: User conventions\ntype: user\n---\nUse concise output.',
      ),
    ).toMatchObject({
      name: 'Preferences',
      description: 'User conventions',
      type: 'user',
      typeStatus: 'known',
      content: 'Use concise output.',
    })
    expect(
      parseProjectMemoryTopic('/memory/legacy.md', '# Legacy\nStill readable.'),
    ).toMatchObject({
      name: 'legacy',
      type: null,
      typeStatus: 'missing',
      content: '# Legacy\nStill readable.',
    })
    expect(
      parseProjectMemoryTopic(
        '/memory/future.md',
        '---\nname: Future\ntype: rollout\n---\nKeep this too.',
      ),
    ).toMatchObject({
      name: 'Future',
      type: null,
      rawType: 'rollout',
      typeStatus: 'unknown',
      content: 'Keep this too.',
    })
  })

  it('offers only the 200 newest bounded topic metadata records to recall', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-project-memory-'))
    roots.push(root)
    await writeFile(join(root, 'MEMORY.md'), '- [index](topic-000.md)')
    for (let index = 0; index < 205; index += 1) {
      const path = join(root, `topic-${String(index).padStart(3, '0')}.md`)
      await writeFile(
        path,
        `---\nname: Topic ${index}\ndescription: ${'x'.repeat(20_000)}\ntype: project\n---\nDETAIL_${index}`,
      )
      const timestamp = new Date(1_700_000_000_000 + index * 1_000)
      await utimes(path, timestamp, timestamp)
    }

    const candidates = await listProjectMemoryCandidates(root)

    expect(candidates).toHaveLength(200)
    expect(candidates[0]?.name).toBe('Topic 204')
    expect(candidates.at(-1)?.name).toBe('Topic 5')
    expect(candidates.some(({ path }) => path.endsWith('MEMORY.md'))).toBe(
      false,
    )
    expect(candidates[0]?.description?.length).toBeLessThan(20_000)
  })

  it('prefetches recall once without waiting and consumes only a settled bounded result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-project-memory-'))
    roots.push(root)
    await Promise.all([
      writeFile(
        join(root, 'preferences.md'),
        '---\nname: Preferences\ndescription: User preferences\ntype: user\n---\n' +
          Array.from({ length: 300 }, (_, index) => `line ${index}`).join('\n'),
      ),
      writeFile(
        join(root, 'project.md'),
        '---\nname: Project\ndescription: Durable project fact\ntype: project\n---\nPROJECT_FACT',
      ),
    ])
    const selection = deferred<readonly string[]>()
    const started = deferred<void>()
    const selector = {
      select: vi.fn(() => {
        started.resolve(undefined)
        return selection.promise
      }),
    }
    const recall = new ProjectMemoryRecallController({
      directory: root,
      selector,
    })

    const turn = recall.prefetch({
      sessionId: 'session',
      turnId: 'turn-1',
      prompt: 'remember my project preferences',
    })
    const duplicate = recall.prefetch({
      sessionId: 'session',
      turnId: 'turn-1',
      prompt: 'ignored duplicate',
    })

    expect(turn.consumeIfSettled()).toBeNull()
    expect(duplicate).toBe(turn)
    await started.promise
    expect(selector.select).toHaveBeenCalledTimes(1)
    selection.resolve(['preferences.md', 'preferences.md', 'project.md'])
    const payload = await consumeRecall(turn)
    expect(payload.attachmentCount).toBe(2)
    expect(payload.content).toContain('path="preferences.md"')
    expect(payload.content).toContain('path="project.md"')
    expect(payload.content).toContain('PROJECT_FACT')
    expect(attachmentBlocks(payload)).toHaveLength(2)
    expect(
      attachmentBlocks(payload).every(
        (attachment) => Buffer.byteLength(attachment, 'utf8') <= 4 * 1024,
      ),
    ).toBe(true)
    expect(
      attachmentBlocks(payload).every(
        (attachment) => attachment.split('\n').length <= 200,
      ),
    ).toBe(true)
    expect(Buffer.byteLength(payload.content, 'utf8')).toBeLessThanOrEqual(
      20 * 1024,
    )
    expect(turn.consumeIfSettled()).toBeNull()
  })

  it('excludes surfaced and read topics until compaction permits recall again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-project-memory-'))
    roots.push(root)
    const topic = join(root, 'topic.md')
    await writeFile(
      topic,
      '---\nname: Topic\ndescription: Relevant\ntype: reference\n---\nDETAIL',
    )
    const selector = {
      select: vi.fn(async () => ['topic.md']),
    }
    const recall = new ProjectMemoryRecallController({
      directory: root,
      selector,
    })
    const first = recall.prefetch({
      sessionId: 'session',
      turnId: 'turn-1',
      prompt: 'topic',
    })
    expect((await consumeRecall(first)).attachmentCount).toBe(1)

    const second = recall.prefetch({
      sessionId: 'session',
      turnId: 'turn-2',
      prompt: 'topic',
    })
    await settle()
    await settle()
    expect(second.consumeIfSettled()).toBeNull()

    recall.recordRead('session', topic)
    recall.recordCompact('session')
    const third = recall.prefetch({
      sessionId: 'session',
      turnId: 'turn-3',
      prompt: 'topic',
    })
    expect((await consumeRecall(third)).attachmentCount).toBe(1)
  })

  it('enforces per-file, per-turn, and per-session recall budgets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-project-memory-'))
    roots.push(root)
    const content = Array.from({ length: 200 }, () => 'x'.repeat(100)).join(
      '\n',
    )
    await Promise.all(
      Array.from({ length: 16 }, async (_, index) => {
        const path = join(root, `topic-${String(index).padStart(2, '0')}.md`)
        await writeFile(
          path,
          `---\nname: ${index === 0 ? '界'.repeat(10_000) : `Topic ${index}`}\ndescription: ${'metadata'.repeat(500)}\ntype: project\n---\n${content}`,
        )
        const timestamp = new Date(1_700_000_000_000 + index * 1_000)
        await utimes(path, timestamp, timestamp)
      }),
    )
    const selector = vi.fn(
      async ({
        candidates,
      }: {
        candidates: readonly ProjectMemoryCandidate[]
      }) =>
        candidates.slice(0, 5).map(({ path }) => path.slice(root.length + 1)),
    )
    const recall = new ProjectMemoryRecallController({
      directory: root,
      selector: { select: selector },
    })

    let sessionBytes = 0
    for (let turnIndex = 0; turnIndex < 4; turnIndex += 1) {
      const turn = recall.prefetch({
        sessionId: 'session',
        turnId: `turn-${turnIndex}`,
        prompt: 'topic',
      })
      const payload = await consumeRecall(turn)
      expect(payload.attachmentCount).toBeGreaterThan(0)
      expect(payload.attachmentCount).toBeLessThanOrEqual(5)
      const bytes = Buffer.byteLength(payload.content, 'utf8')
      expect(bytes).toBeLessThanOrEqual(20 * 1024)
      sessionBytes += bytes
      expect(sessionBytes).toBeLessThanOrEqual(60 * 1024)
      expect(
        attachmentBlocks(payload).every(
          (attachment) => Buffer.byteLength(attachment, 'utf8') <= 4 * 1024,
        ),
      ).toBe(true)
      expect(
        attachmentBlocks(payload).every(
          (attachment) => attachment.split('\n').length <= 200,
        ),
      ).toBe(true)
    }
    const exhausted = recall.prefetch({
      sessionId: 'session',
      turnId: 'turn-exhausted',
      prompt: 'topic',
    })
    await vi.waitFor(() => expect(selector).toHaveBeenCalledTimes(5))
    await settle()
    await settle()
    expect(exhausted.consumeIfSettled()).toBeNull()
  })

  it('extracts only after the durable cursor and advances it only on success', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-project-memory-'))
    roots.push(root)
    const cursorPath = join(root, 'state', 'cursor.json')
    let fail = true
    const extractor = {
      extract: vi.fn(async (input: ProjectMemoryExtractorInput) => {
        void input
        if (fail) throw new Error('retry me')
      }),
    }
    const warnings: string[] = []
    const controller = new ProjectMemoryExtractionController({
      directory: join(root, 'memory'),
      cursorPath,
      extractor,
      onWarning: (message) => warnings.push(message),
    })
    const messages = [
      { id: 'u1', role: 'user' as const, content: 'first' },
      { id: 'a1', role: 'assistant' as const, content: 'answer' },
    ]

    controller.observe({ sessionId: 'session', messages })
    await controller.drain()
    await expect(readFile(cursorPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(warnings).toEqual(['Project memory extraction failed: retry me'])

    fail = false
    controller.observe({ sessionId: 'session', messages })
    await controller.drain()
    expect(JSON.parse(await readFile(cursorPath, 'utf8'))).toEqual({
      version: 1,
      lastMessageId: 'a1',
    })
    controller.observe({
      sessionId: 'session',
      messages: [...messages, { id: 'u2', role: 'user', content: 'second' }],
    })
    await controller.drain()
    expect(extractor.extract.mock.calls.at(-1)?.[0]).toMatchObject({
      messages: [{ id: 'u2', role: 'user', content: 'second' }],
      constraints: {
        persistTranscript: false,
        allowSubagents: false,
        allowRemote: false,
        maxModelTurns: 4,
        tools: ['Read', 'Write', 'Edit'],
      },
    })
    controller.observe({
      sessionId: 'session',
      messages: [
        { id: 'u3', role: 'user', content: 'remaining after compact' },
        { id: 'a3', role: 'assistant', content: 'remaining answer' },
      ],
    })
    await controller.drain()
    expect(extractor.extract.mock.calls.at(-1)?.[0]).toMatchObject({
      messages: [
        { id: 'u3', role: 'user', content: 'remaining after compact' },
        { id: 'a3', role: 'assistant', content: 'remaining answer' },
      ],
    })
  })

  it('skips directly maintained ranges and coalesces one trailing extraction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-project-memory-'))
    roots.push(root)
    const active = deferred<void>()
    const extractor = {
      extract: vi
        .fn<() => Promise<void>>()
        .mockImplementationOnce(() => active.promise)
        .mockResolvedValue(undefined),
    }
    const controller = new ProjectMemoryExtractionController({
      directory: join(root, 'memory'),
      cursorPath: join(root, 'state', 'cursor.json'),
      extractor,
    })
    controller.observe({
      sessionId: 'session',
      messages: [{ id: 'u1', role: 'user', content: 'first' }],
    })
    await settle()
    controller.observe({
      sessionId: 'session',
      messages: [
        { id: 'u1', role: 'user', content: 'first' },
        { id: 'a1', role: 'assistant', content: 'answer' },
      ],
    })
    controller.observe({
      sessionId: 'session',
      directMaintenance: true,
      messages: [
        { id: 'u1', role: 'user', content: 'first' },
        { id: 'a1', role: 'assistant', content: 'answer' },
        { id: 'u2', role: 'user', content: 'maintained memory directly' },
      ],
    })
    active.resolve()
    await controller.drain()

    expect(extractor.extract).toHaveBeenCalledTimes(1)
    expect(
      JSON.parse(await readFile(join(root, 'state', 'cursor.json'), 'utf8')),
    ).toEqual({ version: 1, lastMessageId: 'u2' })
  })

  it('bounds shutdown and aborts extraction without wall-clock waiting', async () => {
    vi.useFakeTimers()
    try {
      const root = await mkdtemp(join(tmpdir(), 'praxis-project-memory-'))
      roots.push(root)
      const started = deferred<void>()
      let extractionSignal: AbortSignal | undefined
      const warnings: string[] = []
      const controller = new ProjectMemoryExtractionController({
        directory: join(root, 'memory'),
        cursorPath: join(root, 'state', 'cursor.json'),
        extractor: {
          extract: async ({ signal }) => {
            extractionSignal = signal
            started.resolve(undefined)
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener(
                'abort',
                () => reject(signal.reason ?? new Error('aborted')),
                { once: true },
              )
            })
          },
        },
        onWarning: (message) => warnings.push(message),
      })
      controller.observe({
        sessionId: 'session',
        messages: [{ id: 'u1', role: 'user', content: 'remember this' }],
      })
      await started.promise

      const close = controller.close(25)
      await vi.advanceTimersByTimeAsync(25)
      await close

      expect(extractionSignal?.aborted).toBe(true)
      expect(warnings).toContain(
        'Project memory extraction drain timed out after 25ms',
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('selects topic paths through an isolated no-tool model request and fails empty', async () => {
    const requests: Array<{
      messages: readonly unknown[]
      tools?: readonly unknown[]
    }> = []
    const responses = ['["topic.md"]', 'not-json']
    const selector = new ProjectMemoryModelSelector({
      directory: '/memory',
      providerFactory: () => ({
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete(request) {
          requests.push(request)
          yield { type: 'text-delta', delta: responses.shift() ?? '[]' }
        },
      }),
    })
    const input = {
      prompt: 'project topic',
      candidates: [
        {
          path: '/memory/topic.md',
          name: 'Topic',
          description: 'Relevant context',
          type: 'project' as const,
          typeStatus: 'known' as const,
          modifiedAtMs: 1,
        },
      ],
    }

    await expect(selector.select(input)).resolves.toEqual(['topic.md'])
    await expect(selector.select(input)).resolves.toEqual([])
    expect(requests[0]?.tools).toBeUndefined()
    expect(JSON.stringify(requests[0]?.messages)).toContain('Relevant context')
    expect(JSON.stringify(requests[0]?.messages)).not.toContain(
      'PROJECT_MEMORY_DETAIL',
    )
  })

  it('runs extraction with only memory-local Read Write and Edit tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-project-memory-'))
    roots.push(root)
    const memoryDirectory = join(root, 'memory')
    const topicPath = join(memoryDirectory, 'topic.md')
    const requests: Array<{
      tools?: readonly { name: string }[]
      messages: readonly unknown[]
    }> = []
    let turn = 0
    const extractor = new ProjectMemoryAgentExtractor({
      providerFactory: () => ({
        capabilities: { streaming: true, usage: true, tools: true },
        async *complete(request) {
          requests.push(request)
          turn += 1
          if (turn === 1) {
            yield {
              type: 'tool-call',
              call: {
                id: 'write-topic',
                name: 'Write',
                input: {
                  file_path: topicPath,
                  content:
                    '---\nname: Topic\ndescription: Durable\ntype: project\n---\nFACT',
                },
              },
            }
            return
          }
          yield { type: 'text-delta', delta: 'done' }
        },
      }),
    })

    await extractor.extract({
      directory: memoryDirectory,
      sessionId: 'session',
      messages: [{ id: 'u1', role: 'user', content: 'remember this' }],
      constraints: {
        persistTranscript: false,
        allowSubagents: false,
        allowRemote: false,
        maxModelTurns: 4,
        tools: ['Read', 'Write', 'Edit'],
      },
      signal: new AbortController().signal,
    })

    expect(await readFile(topicPath, 'utf8')).toContain('FACT')
    expect(requests[0]?.tools?.map(({ name }) => name)).toEqual([
      'Read',
      'Write',
      'Edit',
    ])
    expect(JSON.stringify(requests[0]?.messages)).toContain('remember this')
    expect(
      (await readdir(root, { recursive: true })).filter((path) =>
        path.endsWith('.jsonl'),
      ),
    ).toEqual([])
  })

  it('keeps the cursor retryable when an isolated memory mutation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-project-memory-'))
    roots.push(root)
    const memoryDirectory = join(root, 'memory')
    const cursorPath = join(root, 'state', 'cursor.json')
    const topicPath = join(memoryDirectory, 'topic.md')
    let extractionAttempt = 0
    const warnings: string[] = []
    const extractor = new ProjectMemoryAgentExtractor({
      providerFactory: () => {
        extractionAttempt += 1
        const attempt = extractionAttempt
        let turn = 0
        return {
          capabilities: { streaming: true, usage: true, tools: true },
          async *complete() {
            turn += 1
            if (turn === 1) {
              yield {
                type: 'tool-call',
                call: {
                  id: `write-${attempt}`,
                  name: 'Write',
                  input: {
                    file_path:
                      attempt === 1 ? join(root, 'outside.md') : topicPath,
                    content:
                      '---\nname: Topic\ndescription: Durable\ntype: project\n---\nFACT',
                  },
                },
              }
              return
            }
            yield { type: 'text-delta', delta: 'done' }
          },
        }
      },
    })
    const controller = new ProjectMemoryExtractionController({
      directory: memoryDirectory,
      cursorPath,
      extractor,
      onWarning: (message) => warnings.push(message),
    })
    const observation = {
      sessionId: 'session',
      messages: [{ id: 'u1', role: 'user' as const, content: 'remember this' }],
    }

    controller.observe(observation)
    await controller.drain()
    await expect(readFile(cursorPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(
      readFile(join(root, 'outside.md'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(warnings).toContain(
      'Project memory extraction failed: Project memory tool failed',
    )

    controller.observe(observation)
    await controller.drain()
    expect(await readFile(topicPath, 'utf8')).toContain('FACT')
    expect(JSON.parse(await readFile(cursorPath, 'utf8'))).toEqual({
      version: 1,
      lastMessageId: 'u1',
    })
  })

  it('rejects Read Write and Edit through symlinks outside the memory root without advancing the cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-project-memory-'))
    roots.push(root)
    const memoryDirectory = join(root, 'memory')
    const outsideDirectory = join(root, 'outside')
    const cursorPath = join(root, 'state', 'cursor.json')
    await mkdir(memoryDirectory, { recursive: true })
    await mkdir(outsideDirectory, { recursive: true })
    await writeFile(join(outsideDirectory, 'read.md'), 'PRIVATE')
    await writeFile(join(outsideDirectory, 'edit.md'), 'ORIGINAL')
    await symlink(outsideDirectory, join(memoryDirectory, 'link'))

    const calls: ModelToolCall[] = [
      {
        id: 'read-link',
        name: 'Read',
        input: { file_path: join(memoryDirectory, 'link', 'read.md') },
      },
      {
        id: 'write-link',
        name: 'Write',
        input: {
          file_path: join(memoryDirectory, 'link', 'write.md'),
          content: 'ESCAPED',
        },
      },
      {
        id: 'edit-link',
        name: 'Edit',
        input: {
          file_path: join(memoryDirectory, 'link', 'edit.md'),
          old_string: 'ORIGINAL',
          new_string: 'ESCAPED',
        },
      },
    ]
    let extractionAttempt = 0
    const warnings: string[] = []
    const extractor = new ProjectMemoryAgentExtractor({
      providerFactory: () => {
        const call = calls[extractionAttempt]
        extractionAttempt += 1
        let turn = 0
        return {
          capabilities: { streaming: true, usage: true, tools: true },
          async *complete() {
            turn += 1
            if (turn === 1 && call) {
              yield { type: 'tool-call' as const, call }
              return
            }
            yield { type: 'text-delta' as const, delta: 'done' }
          },
        }
      },
    })
    const controller = new ProjectMemoryExtractionController({
      directory: memoryDirectory,
      cursorPath,
      extractor,
      onWarning: (message) => warnings.push(message),
    })
    const observation = {
      sessionId: 'session',
      messages: [{ id: 'u1', role: 'user' as const, content: 'remember this' }],
    }

    for (let attempt = 0; attempt < calls.length; attempt += 1) {
      controller.observe(observation)
      await controller.drain()
      await expect(readFile(cursorPath, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })
    }

    expect(await readFile(join(outsideDirectory, 'read.md'), 'utf8')).toBe(
      'PRIVATE',
    )
    await expect(
      readFile(join(outsideDirectory, 'write.md'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(outsideDirectory, 'edit.md'), 'utf8')).toBe(
      'ORIGINAL',
    )
    expect(warnings).toHaveLength(3)
  })
})
