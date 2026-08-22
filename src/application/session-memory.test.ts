import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentRunCancelledError, type ModelMessage } from '../core/runtime.js'
import {
  SessionMemoryController,
  SessionMemoryStateError,
  SessionMemoryStore,
} from './session-memory.js'

const SESSION_ID = '20202020-2020-4020-8020-202020202020'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function tempConfigRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'praxis-session-memory-'))
  roots.push(root)
  return join(root, 'config')
}

function sessionDirectory(configRoot: string): string {
  return join(configRoot, 'praxis', 'session-memory', SESSION_ID)
}

function summaryExtractor() {
  const calls: string[] = []
  const extractor = async (input: {
    summary: string
    tokens: number
    toolCalls: number
  }) => {
    calls.push(input.summary)
    return `extracted ${input.tokens} tokens / ${input.toolCalls} tool calls`
  }
  return { calls, extractor }
}

async function seedState(configRoot: string, state: unknown): Promise<void> {
  const directory = sessionDirectory(configRoot)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'state.json'), JSON.stringify(state))
}

describe('SessionMemoryStore', () => {
  it('loads state and its referenced immutable summary as one snapshot', async () => {
    const configRoot = await tempConfigRoot()
    const store = new SessionMemoryStore({ configRoot, sessionId: SESSION_ID })
    const state = {
      schemaVersion: 1 as const,
      initialized: true,
      lastObservedTokens: 100,
      lastObservedToolCalls: 1,
      lastSummarizedMessageId: 'm1',
      extractionStartedAt: null,
      extractionCompletedAt: 1,
      extractionError: null,
    }
    await store.commitExtraction(state, 'snapshot summary')

    await expect(store.loadSnapshot()).resolves.toEqual({
      state,
      summary: 'snapshot summary',
    })
  })

  it('retains superseded immutable artifacts for readers holding an old pointer', async () => {
    const configRoot = await tempConfigRoot()
    const store = new SessionMemoryStore({ configRoot, sessionId: SESSION_ID })
    const base = {
      schemaVersion: 1 as const,
      initialized: true,
      extractionStartedAt: null,
      extractionError: null,
    }
    await store.commitExtraction(
      {
        ...base,
        lastObservedTokens: 100,
        lastObservedToolCalls: 1,
        lastSummarizedMessageId: 'm1',
        extractionCompletedAt: 1,
      },
      'first summary',
    )
    const firstRecord = JSON.parse(
      await readFile(join(sessionDirectory(configRoot), 'state.json'), 'utf8'),
    ) as { summaryFile: string }

    await store.commitExtraction(
      {
        ...base,
        lastObservedTokens: 200,
        lastObservedToolCalls: 2,
        lastSummarizedMessageId: 'm2',
        extractionCompletedAt: 2,
      },
      'second summary',
    )

    await expect(
      readFile(
        join(sessionDirectory(configRoot), firstRecord.summaryFile),
        'utf8',
      ),
    ).resolves.toBe('first summary')
    await expect(store.loadSummary()).resolves.toBe('second summary')
  })

  it('uses an explicit selected data-plane root instead of the Claude compatibility fallback', async () => {
    const configRoot = await tempConfigRoot()
    const sidecarRoot = join(configRoot, 'state')
    const store = new SessionMemoryStore({
      configRoot,
      sessionId: SESSION_ID,
      sidecarRoot,
    })

    await store.writeSummary('native memory')

    await expect(
      readFile(
        join(sidecarRoot, 'session-memory', SESSION_ID, 'summary.md'),
        'utf8',
      ),
    ).resolves.toBe('native memory')
    await expect(
      readFile(join(sessionDirectory(configRoot), 'summary.md'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects path traversal and invalid session IDs', async () => {
    const configRoot = await tempConfigRoot()
    expect(
      () => new SessionMemoryStore({ configRoot, sessionId: '../../../etc' }),
    ).toThrow(SessionMemoryStateError)
    expect(
      () => new SessionMemoryStore({ configRoot, sessionId: 'not-a-uuid' }),
    ).toThrow(SessionMemoryStateError)
    expect(
      () => new SessionMemoryStore({ configRoot: '', sessionId: SESSION_ID }),
    ).toThrow(SessionMemoryStateError)
    const store = new SessionMemoryStore({ configRoot, sessionId: SESSION_ID })
    expect(store).toBeInstanceOf(SessionMemoryStore)
  })

  it('rejects malformed and versioned state and fails closed on empty summaries', async () => {
    const configRoot = await tempConfigRoot()
    const directory = sessionDirectory(configRoot)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'state.json'), '{not json')
    const store = new SessionMemoryStore({ configRoot, sessionId: SESSION_ID })
    await expect(store.load()).rejects.toThrow(SessionMemoryStateError)
    await expect(store.writeSummary('   ')).rejects.toThrow(
      SessionMemoryStateError,
    )
    await seedState(configRoot, { schemaVersion: 2, initialized: false })
    await expect(store.load()).rejects.toThrow(SessionMemoryStateError)
  })

  it('fails closed when the atomic summary write cannot rename', async () => {
    const configRoot = await tempConfigRoot()
    const directory = sessionDirectory(configRoot)
    // summary.md exists as a directory so the atomic rename fails.
    await mkdir(join(directory, 'summary.md'), { recursive: true })
    const store = new SessionMemoryStore({ configRoot, sessionId: SESSION_ID })
    await expect(store.writeSummary('hello')).rejects.toThrow()
    // Progress state remains writable and versioned after the failed write.
    await store.writeState({
      schemaVersion: 1,
      initialized: false,
      lastObservedTokens: 0,
      lastObservedToolCalls: 0,
      lastSummarizedMessageId: null,
      extractionStartedAt: null,
      extractionCompletedAt: null,
      extractionError: null,
    })
    expect((await store.load()).schemaVersion).toBe(1)
  })

  it('keeps selected data-plane summaries isolated for reads and clears', async () => {
    const configRoot = await tempConfigRoot()
    const native = new SessionMemoryStore({
      configRoot,
      sessionId: SESSION_ID,
      sidecarRoot: join(configRoot, 'state'),
    })
    const claude = new SessionMemoryStore({
      configRoot,
      sessionId: SESSION_ID,
    })

    await native.writeSummary('native summary')
    await claude.writeSummary('claude summary')

    await expect(native.loadSummary()).resolves.toBe('native summary')
    await expect(claude.loadSummary()).resolves.toBe('claude summary')

    await native.clear()
    await expect(native.loadSummary()).resolves.toBe('')
    await expect(claude.loadSummary()).resolves.toBe('claude summary')
  })
})

describe('SessionMemoryController', () => {
  it('loads through the store snapshot seam instead of pairing separate reads', async () => {
    const configRoot = await tempConfigRoot()
    const store = new SessionMemoryStore({ configRoot, sessionId: SESSION_ID })
    await store.writeSummary('legacy summary')
    vi.spyOn(store, 'load').mockRejectedValue(new Error('separate state read'))
    vi.spyOn(store, 'loadSummary').mockRejectedValue(
      new Error('separate summary read'),
    )
    const controller = new SessionMemoryController({
      store,
      extractor: summaryExtractor().extractor,
    })

    await expect(controller.summary()).resolves.toBe('legacy summary')
  })

  it('initializes on first threshold crossing and persists summary and state', async () => {
    const configRoot = await tempConfigRoot()
    const store = new SessionMemoryStore({ configRoot, sessionId: SESSION_ID })
    const { calls, extractor } = summaryExtractor()
    const controller = new SessionMemoryController({
      store,
      extractor,
      initTokens: 10_000,
    })
    expect((await store.load()).initialized).toBe(false)
    expect(await store.loadSummary()).toBe('')
    expect(await controller.observe(5_000, 2, 'm1')).toBe(false)
    expect(await controller.observe(12_000, 5, 'm2')).toBe(true)
    await controller.waitForIdle()
    expect(calls).toEqual([''])
    const state = await store.load()
    expect(state.initialized).toBe(true)
    expect(state.lastObservedTokens).toBe(12_000)
    expect(state.lastObservedToolCalls).toBe(5)
    expect(state.lastSummarizedMessageId).toBe('m2')
    expect(state.extractionStartedAt).toBeNull()
    expect(state.extractionCompletedAt).not.toBeNull()
    expect(state.extractionError).toBeNull()
    expect(await store.loadSummary()).toBe(
      'extracted 12000 tokens / 5 tool calls',
    )
  })

  it('triggers on update-token growth plus a tool-call threshold or a natural break', async () => {
    const configRoot = await tempConfigRoot()
    const store = new SessionMemoryStore({ configRoot, sessionId: SESSION_ID })
    const { extractor } = summaryExtractor()
    const controller = new SessionMemoryController({
      store,
      extractor,
      initTokens: 10_000,
      updateTokens: 5_000,
      updateToolCalls: 3,
    })
    expect(await controller.observe(12_000, 5, 'm-init')).toBe(true)
    await controller.waitForIdle()
    // +3000 tokens is below the update threshold.
    expect(await controller.observe(15_000, 5, 'm3')).toBe(false)
    // Exactly +5000 tokens with no tool calls since the watermark is a
    // natural break.
    expect(await controller.observe(17_000, 5, 'm4')).toBe(true)
    await controller.waitForIdle()
    // Tool-call growth alone does not trigger without token growth.
    expect(await controller.observe(17_000, 8, 'm5')).toBe(false)
    // +5000 tokens plus +3 tool calls since the watermark triggers.
    expect(await controller.observe(22_000, 8, 'm6')).toBe(true)
    await controller.waitForIdle()
    // The durable tool-call counter is monotonic even though context occupancy
    // may legitimately shrink after compaction.
    await expect(controller.observe(10_000, 5, 'm-backwards')).rejects.toThrow(
      SessionMemoryStateError,
    )
    const state = await store.load()
    expect(state.lastObservedTokens).toBe(22_000)
    expect(state.lastObservedToolCalls).toBe(8)
    expect(state.lastSummarizedMessageId).toBe('m6')
  })

  it('serializes concurrent observations onto one extraction', async () => {
    const configRoot = await tempConfigRoot()
    const store = new SessionMemoryStore({ configRoot, sessionId: SESSION_ID })
    let calls = 0
    let release: ((summary: string) => void) | undefined
    const controller = new SessionMemoryController({
      store,
      initTokens: 100,
      extractor: async () => {
        calls += 1
        return new Promise<string>((resolve) => {
          release = resolve
        })
      },
    })
    expect(await controller.observe(200, 2, 'm1')).toBe(true)
    await vi.waitFor(() => expect(calls).toBe(1))
    // A concurrent caller shares the in-flight extraction instead of rerunning.
    expect(await controller.observe(300, 5, 'm2')).toBe(true)
    expect(calls).toBe(1)
    release?.('shared summary')
    await controller.waitForIdle()
    expect(calls).toBe(1)
    const state = await store.load()
    expect(state.lastObservedTokens).toBe(200)
    expect(state.lastObservedToolCalls).toBe(2)
    expect(state.lastSummarizedMessageId).toBe('m1')
  })

  it('recovers a stale persisted extraction and resumes counters safely', async () => {
    const configRoot = await tempConfigRoot()
    const directory = sessionDirectory(configRoot)
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'state.json'),
      JSON.stringify({
        schemaVersion: 1,
        initialized: true,
        lastObservedTokens: 5_000,
        lastObservedToolCalls: 5,
        lastSummarizedMessageId: 'm-old',
        extractionStartedAt: Date.now() - 60_000,
        extractionCompletedAt: null,
        extractionError: null,
      }),
    )
    await writeFile(join(directory, 'summary.md'), 'previous summary')
    const store = new SessionMemoryStore({ configRoot, sessionId: SESSION_ID })
    let receivedSummary = ''
    const controller = new SessionMemoryController({
      store,
      initTokens: 10_000,
      updateTokens: 1_000,
      updateToolCalls: 3,
      waitTimeoutMs: 1_000,
      extractor: async ({ summary, tokens }) => {
        receivedSummary = summary
        return `extracted ${tokens}`
      },
    })
    // Reopening marks the stale extraction failed; the resumed counters keep
    // the session below the update threshold.
    expect(await controller.observe(5_200, 5, 'm-reopen')).toBe(false)
    let state = await store.load()
    expect(state.extractionStartedAt).toBeNull()
    expect(state.extractionError).toContain('stale')
    // Crossing the resumed update threshold retries the extraction with the
    // persisted summary.
    expect(await controller.observe(6_200, 8, 'm-retry')).toBe(true)
    await controller.waitForIdle()
    expect(receivedSummary).toBe('previous summary')
    state = await store.load()
    expect(state.lastObservedTokens).toBe(6_200)
    expect(state.lastObservedToolCalls).toBe(8)
    expect(state.lastSummarizedMessageId).toBe('m-retry')
    expect(state.extractionError).toBeNull()
  })

  it('fails closed when the extractor returns an empty summary', async () => {
    const configRoot = await tempConfigRoot()
    const store = new SessionMemoryStore({ configRoot, sessionId: SESSION_ID })
    const controller = new SessionMemoryController({
      store,
      initTokens: 100,
      extractor: async () => '',
    })
    expect(await controller.observe(200, 1, 'm1')).toBe(true)
    await expect(controller.waitForIdle()).rejects.toThrow(
      SessionMemoryStateError,
    )
    const state = await store.load()
    expect(state.initialized).toBe(false)
    expect(state.extractionStartedAt).toBeNull()
    expect(state.extractionError).toContain('empty summary')
  })

  it('retains the last good summary and watermark when the atomic commit fails', async () => {
    const configRoot = await tempConfigRoot()
    const store = new SessionMemoryStore({ configRoot, sessionId: SESSION_ID })
    let extraction = 0
    const controller = new SessionMemoryController({
      store,
      initTokens: 100,
      updateTokens: 50,
      updateToolCalls: 1,
      extractor: async () =>
        extraction++ === 0 ? 'last good summary' : 'uncommitted summary',
    })

    expect(await controller.observe(100, 1, 'm-good')).toBe(true)
    await controller.waitForIdle()

    const writeState = store.writeState.bind(store)
    let writes = 0
    vi.spyOn(store, 'writeState').mockImplementation(async (...args) => {
      writes += 1
      if (writes === 2) throw new Error('state commit failed')
      await writeState(...args)
    })

    expect(await controller.observe(150, 2, 'm-uncommitted')).toBe(true)
    await expect(controller.waitForIdle()).rejects.toThrow(
      'state commit failed',
    )

    const state = await store.load()
    expect(state.lastSummarizedMessageId).toBe('m-good')
    expect(state.lastObservedTokens).toBe(100)
    expect(state.lastObservedToolCalls).toBe(1)
    expect(state.extractionError).toContain('state commit failed')
    await expect(store.loadSummary()).resolves.toBe('last good summary')
    await expect(
      readFile(join(sessionDirectory(configRoot), 'summary.md'), 'utf8'),
    ).resolves.toBe('last good summary')
  })

  it('passes an isolated immutable snapshot to asynchronous extraction', async () => {
    const configRoot = await tempConfigRoot()
    const store = new SessionMemoryStore({ configRoot, sessionId: SESSION_ID })
    let release: (() => void) | undefined
    let extractionStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      extractionStarted = resolve
    })
    let seen = ''
    const controller = new SessionMemoryController({
      store,
      initTokens: 100,
      extractor: async ({ messages }) => {
        extractionStarted?.()
        await new Promise<void>((resolve) => {
          release = resolve
        })
        seen = JSON.stringify(messages)
        const assistant = messages?.find(
          (message) => message.role === 'assistant',
        )
        const nested = assistant?.toolCalls?.[0]?.input.nested as
          { value: string } | undefined
        if (nested) nested.value = 'extractor mutation'
        return 'isolated summary'
      },
    })
    const messages: ModelMessage[] = [
      { role: 'user', content: 'original prompt' },
      {
        role: 'assistant',
        content: 'original answer',
        toolCalls: [
          {
            id: 'tool-1',
            name: 'Read',
            input: { nested: { value: 'original input' } },
          },
        ],
      },
    ]

    expect(await controller.observe(100, 1, 'm1', messages)).toBe(true)
    await started
    messages[0] = { role: 'user', content: 'foreground mutation' }
    const foregroundNested =
      messages[1]?.role === 'assistant'
        ? (messages[1].toolCalls?.[0]?.input.nested as { value: string })
        : undefined
    if (foregroundNested) foregroundNested.value = 'foreground mutation'
    release?.()
    await controller.waitForIdle()

    expect(seen).toContain('original prompt')
    expect(seen).toContain('original input')
    expect(seen).not.toContain('foreground mutation')
    expect(foregroundNested?.value).toBe('foreground mutation')
  })

  it('cancels an in-flight extraction on close without advancing memory', async () => {
    const configRoot = await tempConfigRoot()
    const store = new SessionMemoryStore({ configRoot, sessionId: SESSION_ID })
    let extraction = 0
    let slowStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      slowStarted = resolve
    })
    const controller = new SessionMemoryController({
      store,
      initTokens: 100,
      updateTokens: 50,
      updateToolCalls: 1,
      extractor: async ({ signal }) => {
        if (extraction++ === 0) return 'last good summary'
        slowStarted?.()
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new AgentRunCancelledError()),
            { once: true },
          )
        })
      },
    })

    expect(await controller.observe(100, 1, 'm-good')).toBe(true)
    await controller.waitForIdle()
    expect(await controller.observe(150, 2, 'm-cancelled')).toBe(true)
    await started
    await controller.close()

    const state = await store.load()
    expect(state.lastSummarizedMessageId).toBe('m-good')
    expect(state.lastObservedTokens).toBe(100)
    expect(state.lastObservedToolCalls).toBe(1)
    expect(state.extractionError).toContain('Agent run cancelled')
    await expect(store.loadSummary()).resolves.toBe('last good summary')
  })

  it('clears state and resumes like first initialization', async () => {
    const configRoot = await tempConfigRoot()
    const store = new SessionMemoryStore({ configRoot, sessionId: SESSION_ID })
    const { extractor } = summaryExtractor()
    const controller = new SessionMemoryController({
      store,
      extractor,
      initTokens: 100,
    })
    expect(await controller.observe(200, 2, 'm1')).toBe(true)
    await controller.waitForIdle()
    expect((await store.load()).initialized).toBe(true)
    await controller.clear()
    expect((await store.load()).initialized).toBe(false)
    expect(await store.loadSummary()).toBe('')
    expect(await controller.observe(50, 1, 'm2')).toBe(false)
    expect(await controller.observe(150, 2, 'm3')).toBe(true)
    await controller.waitForIdle()
    const state = await store.load()
    expect(state.initialized).toBe(true)
    expect(state.lastObservedTokens).toBe(150)
    expect(state.lastObservedToolCalls).toBe(2)
    expect(state.lastSummarizedMessageId).toBe('m3')
  })

  it('returns from a context observation before a slow extraction and lets compact wait', async () => {
    const configRoot = await tempConfigRoot()
    const store = new SessionMemoryStore({ configRoot, sessionId: SESSION_ID })
    let calls = 0
    let release: (() => void) | undefined
    const controller = new SessionMemoryController({
      store,
      initTokens: 100,
      extractor: async () => {
        calls += 1
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return 'slow summary'
      },
    })
    // A normal turn schedules extraction and returns before it finishes.
    expect(await controller.observeContext(200, 0, 'm1')).toBe(true)
    await vi.waitFor(() => expect(calls).toBe(1))
    // The turn already resolved while the slow extractor is still running.
    let idleResolved = false
    const idle = controller.waitForIdle().then(() => {
      idleResolved = true
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(idleResolved).toBe(false)
    release?.()
    await idle
    expect(idleResolved).toBe(true)
    expect(calls).toBe(1)
    const state = await store.load()
    expect(state.initialized).toBe(true)
    expect(state.lastObservedTokens).toBe(200)
    expect(state.lastObservedToolCalls).toBe(0)
    expect(state.lastSummarizedMessageId).toBe('m1')
  })

  it('waits softly for compact when extraction fails', async () => {
    const configRoot = await tempConfigRoot()
    const controller = new SessionMemoryController({
      store: new SessionMemoryStore({ configRoot, sessionId: SESSION_ID }),
      initTokens: 100,
      extractor: async () => {
        throw new Error('retry later')
      },
    })

    expect(await controller.observeContext(100, 0, 'm1')).toBe(true)
    await expect(controller.waitForCompact()).resolves.toBeUndefined()
    expect((await controller.state()).extractionError).toContain('retry later')
  })

  it('retries a failed extraction only after context growth', async () => {
    const configRoot = await tempConfigRoot()
    let calls = 0
    const controller = new SessionMemoryController({
      store: new SessionMemoryStore({ configRoot, sessionId: SESSION_ID }),
      initTokens: 100,
      extractor: async () => {
        calls += 1
        if (calls === 1) throw new Error('retry later')
        return 'recovered summary'
      },
    })

    expect(await controller.observeContext(100, 0, 'm-failed')).toBe(true)
    await controller.waitForIdle().catch(() => undefined)
    expect(await controller.observeContext(100, 0, 'm-same')).toBe(false)
    expect(calls).toBe(1)
    expect(await controller.observeContext(101, 0, 'm-grown')).toBe(true)
    await controller.waitForIdle()
    expect(calls).toBe(2)
  })

  it('retains the failed-attempt growth watermark across reopen', async () => {
    const configRoot = await tempConfigRoot()
    const store = new SessionMemoryStore({ configRoot, sessionId: SESSION_ID })
    const failed = new SessionMemoryController({
      store,
      initTokens: 100,
      extractor: async () => {
        throw new Error('retry after growth')
      },
    })
    expect(await failed.observeContext(100, 0, 'm-failed')).toBe(true)
    await failed.waitForIdle().catch(() => undefined)

    let reopenedCalls = 0
    const reopened = new SessionMemoryController({
      store,
      initTokens: 100,
      extractor: async () => {
        reopenedCalls += 1
        return 'recovered summary'
      },
    })
    expect(await reopened.observeContext(100, 0, 'm-same')).toBe(false)
    expect(reopenedCalls).toBe(0)
    expect(await reopened.observeContext(101, 0, 'm-grown')).toBe(true)
    await reopened.waitForIdle()
    expect(reopenedCalls).toBe(1)
  })

  it('records and warns when the extraction progress write fails', async () => {
    const configRoot = await tempConfigRoot()
    const store = new SessionMemoryStore({ configRoot, sessionId: SESSION_ID })
    const writeState = store.writeState.bind(store)
    let writes = 0
    vi.spyOn(store, 'writeState').mockImplementation(async (...args) => {
      writes += 1
      if (writes === 1) throw new Error('progress write failed')
      await writeState(...args)
    })
    const errors: unknown[] = []
    let extractorCalls = 0
    const controller = new SessionMemoryController({
      store,
      initTokens: 100,
      onExtractionError: (error) => errors.push(error),
      extractor: async () => {
        extractorCalls += 1
        return 'must not run'
      },
    })

    expect(await controller.observeContext(100, 0, 'm1')).toBe(true)
    await expect(controller.waitForIdle()).rejects.toThrow(
      'progress write failed',
    )
    expect(extractorCalls).toBe(0)
    expect(errors).toHaveLength(1)
    expect((await store.load()).extractionError).toContain(
      'progress write failed',
    )
  })

  it('aborts an extraction that exceeds the compact wait without advancing memory', async () => {
    const configRoot = await tempConfigRoot()
    let extraction = 0
    let aborted = false
    let slowStarted: (() => void) | undefined
    const extractionStarted = new Promise<void>((resolve) => {
      slowStarted = resolve
    })
    const controller = new SessionMemoryController({
      store: new SessionMemoryStore({ configRoot, sessionId: SESSION_ID }),
      initTokens: 100,
      updateTokens: 50,
      updateToolCalls: 1,
      waitTimeoutMs: 5,
      extractor: async ({ signal }) => {
        if (extraction++ === 0) return 'last committed summary'
        return new Promise<string>((_resolve, reject) => {
          slowStarted?.()
          signal.addEventListener(
            'abort',
            () => {
              aborted = true
              reject(new AgentRunCancelledError())
            },
            { once: true },
          )
        })
      },
    })

    expect(await controller.observeContext(100, 1, 'm-good')).toBe(true)
    await controller.waitForIdle()
    expect(await controller.observeContext(150, 1, 'm-slow')).toBe(true)
    await extractionStarted
    await controller.waitForCompact()
    await vi.waitFor(() => expect(aborted).toBe(true))
    await controller.waitForIdle().catch(() => undefined)

    const state = await controller.state()
    expect(state.lastSummarizedMessageId).toBe('m-good')
    expect(await controller.summary()).toBe('last committed summary')
  })

  it('aborts extraction older than the compact staleness threshold', async () => {
    const configRoot = await tempConfigRoot()
    let aborted = false
    let started: (() => void) | undefined
    const extractionStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const controller = new SessionMemoryController({
      store: new SessionMemoryStore({ configRoot, sessionId: SESSION_ID }),
      initTokens: 100,
      staleExtractionMs: 1,
      waitTimeoutMs: 100,
      extractor: async ({ signal }) => {
        started?.()
        return new Promise<string>(() => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true
            },
            { once: true },
          )
        })
      },
    })

    expect(await controller.observeContext(100, 0, 'm1')).toBe(true)
    await extractionStarted
    await new Promise((resolve) => setTimeout(resolve, 2))
    const before = performance.now()
    await expect(controller.waitForCompact()).resolves.toBeUndefined()
    expect(performance.now() - before).toBeLessThan(50)
    await vi.waitFor(() => expect(aborted).toBe(true))
    expect((await controller.state()).lastSummarizedMessageId).toBeNull()
    await controller.close()
  })

  it('rebases current-context growth after compaction reduces occupancy', async () => {
    const configRoot = await tempConfigRoot()
    const received: number[] = []
    const controller = new SessionMemoryController({
      store: new SessionMemoryStore({ configRoot, sessionId: SESSION_ID }),
      initTokens: 100,
      updateTokens: 50,
      updateToolCalls: 3,
      extractor: async ({ tokens }) => {
        received.push(tokens)
        return `summary at ${tokens}`
      },
    })

    expect(await controller.observeContext(120, 0, 'm1')).toBe(true)
    await controller.waitForIdle()
    expect(await controller.observeContext(40, 0, 'm2')).toBe(false)
    expect(await controller.observeContext(89, 0, 'm3')).toBe(false)
    expect(await controller.observeContext(90, 0, 'm4')).toBe(true)
    await controller.waitForIdle()

    expect(received).toEqual([120, 90])
    expect((await controller.state()).lastObservedTokens).toBe(90)
  })

  it('retains the reduced context baseline across reopen', async () => {
    const configRoot = await tempConfigRoot()
    const store = new SessionMemoryStore({ configRoot, sessionId: SESSION_ID })
    const initial = new SessionMemoryController({
      store,
      initTokens: 100,
      updateTokens: 50,
      extractor: async () => 'initial summary',
    })
    expect(await initial.observeContext(120, 0, 'm-initial')).toBe(true)
    await initial.waitForIdle()
    expect(await initial.observeContext(40, 0, 'm-compact')).toBe(false)

    let reopenedCalls = 0
    const reopened = new SessionMemoryController({
      store,
      initTokens: 100,
      updateTokens: 50,
      extractor: async () => {
        reopenedCalls += 1
        return 'post-compact summary'
      },
    })
    expect(await reopened.observeContext(90, 0, 'm-grown')).toBe(true)
    await reopened.waitForIdle()
    expect(reopenedCalls).toBe(1)
  })
})
