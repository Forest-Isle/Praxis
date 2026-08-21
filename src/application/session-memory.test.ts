import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

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
})

describe('SessionMemoryController', () => {
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

  it('triggers on update token and tool-call thresholds after initialization', async () => {
    const configRoot = await tempConfigRoot()
    const store = new SessionMemoryStore({ configRoot, sessionId: SESSION_ID })
    const { extractor } = summaryExtractor()
    const controller = new SessionMemoryController({
      store,
      extractor,
      initTokens: 10_000,
      updateTokens: 5_000,
      updateToolCalls: 20,
    })
    expect(await controller.observe(12_000, 5, 'm-init')).toBe(true)
    await controller.waitForIdle()
    // +3000 tokens is below the update threshold.
    expect(await controller.observe(15_000, 5, 'm3')).toBe(false)
    // Exactly +5000 tokens crosses the token threshold.
    expect(await controller.observe(17_000, 5, 'm4')).toBe(true)
    await controller.waitForIdle()
    // +20 tool calls crosses the tool-call threshold.
    expect(await controller.observe(17_000, 25, 'm5')).toBe(true)
    await controller.waitForIdle()
    // Observed counters are monotonic; a regression fails closed.
    await expect(controller.observe(10_000, 5, 'm-backwards')).rejects.toThrow(
      SessionMemoryStateError,
    )
    const state = await store.load()
    expect(state.lastObservedTokens).toBe(17_000)
    expect(state.lastObservedToolCalls).toBe(25)
    expect(state.lastSummarizedMessageId).toBe('m5')
  })

  it('observeDelta accumulates deltas and extracts once at the update threshold', async () => {
    const configRoot = await tempConfigRoot()
    const store = new SessionMemoryStore({ configRoot, sessionId: SESSION_ID })
    const received: Array<{ tokens: number; toolCalls: number }> = []
    const controller = new SessionMemoryController({
      store,
      initTokens: 10_000,
      updateTokens: 5_000,
      updateToolCalls: 20,
      extractor: async ({ tokens, toolCalls }) => {
        received.push({ tokens, toolCalls })
        return `extracted ${tokens} tokens / ${toolCalls} tool calls`
      },
    })
    // Initialize with the absolute-total observe API.
    expect(await controller.observe(12_000, 5, 'm-init')).toBe(true)
    await controller.waitForIdle()
    expect(received).toHaveLength(1)
    // A delta below the update threshold is retained for the next call.
    expect(await controller.observeDelta(3_000, 0, 'm-below')).toBe(false)
    // The next delta reaches exactly +5000 accumulated tokens and extracts once.
    expect(await controller.observeDelta(2_000, 0, 'm-cross')).toBe(true)
    await controller.waitForIdle()
    expect(received).toHaveLength(2)
    expect(received[1]).toEqual({ tokens: 17_000, toolCalls: 5 })
    const state = await store.load()
    expect(state.lastObservedTokens).toBe(17_000)
    expect(state.lastObservedToolCalls).toBe(5)
    expect(state.lastSummarizedMessageId).toBe('m-cross')
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
      updateToolCalls: 20,
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
})
