import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  ClaudeCostStateStore,
  type ClaudeSessionCostState,
} from './claude-cost-state-store.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

const PROJECT = 'proj-a'
const OTHER = 'proj-b'
const SESSION_ID = '20202020-2020-4020-8020-202020202020'

function baseState(): ClaudeSessionCostState {
  return {
    sessionId: SESSION_ID,
    totalCostUsd: 1.7345,
    apiDurationMs: 1234,
    apiDurationWithoutRetriesMs: 1100,
    toolDurationMs: 400,
    wallDurationMs: 2000,
    linesAdded: 30,
    linesRemoved: 12,
    modelUsage: {
      'claude-3-5-sonnet-20241022': {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 25,
        cacheCreationInputTokens: 10,
        webSearchRequests: 3,
        costUsd: 1.2345,
      },
      'gpt-4o': {
        inputTokens: 200,
        outputTokens: 100,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 5,
        webSearchRequests: 0,
        costUsd: 0.5,
      },
    },
    hasUnknownModelCost: false,
  }
}

function withModelUsage(value: unknown): ClaudeSessionCostState {
  return {
    ...baseState(),
    modelUsage: value as unknown as ClaudeSessionCostState['modelUsage'],
  }
}

const VALID_USAGE = {
  inputTokens: 1,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  webSearchRequests: 0,
  costUsd: 0,
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'praxis-claude-cost-store-'))
  roots.push(root)
  const statePath = join(
    root,
    'work',
    '.claude',
    'costs',
    'claude-cost-state.json',
  )
  const lockFile = join(root, 'config', 'praxis', 'locks', 'praxis-state.lock')
  await mkdir(dirname(statePath), { recursive: true })
  await mkdir(dirname(lockFile), { recursive: true })
  const store = new ClaudeCostStateStore({
    statePath,
    projectIdentity: PROJECT,
    lockFile,
  })
  return { root, statePath, lockFile, store }
}

async function writeRaw(statePath: string, content: string): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true })
  await writeFile(statePath, content)
}

async function writeState(statePath: string, value: unknown): Promise<void> {
  await writeRaw(statePath, JSON.stringify(value))
}

async function readState(statePath: string): Promise<unknown> {
  return JSON.parse(await readFile(statePath, 'utf8'))
}

const NATIVE_PROJECT = {
  lastModelUsage: {
    'claude-3-5-sonnet-20241022': {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 25,
      cacheCreationInputTokens: 10,
      webSearchRequests: 3,
      costUSD: 1.2345,
    },
    'gpt-4o': {
      inputTokens: 200,
      outputTokens: 100,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 5,
      webSearchRequests: 0,
      costUSD: 0.5,
    },
  },
  lastCost: 1.7345,
  lastAPIDuration: 1234,
  lastAPIDurationWithoutRetries: 1100,
  lastToolDuration: 400,
  lastDuration: 2000,
  lastLinesAdded: 30,
  lastLinesRemoved: 12,
  lastTotalInputTokens: 300,
  lastTotalOutputTokens: 150,
  lastTotalCacheCreationInputTokens: 15,
  lastTotalCacheReadInputTokens: 25,
  lastTotalWebSearchRequests: 3,
  lastSessionId: SESSION_ID,
}

const OWNED_PROJECT_KEYS = [
  'lastAPIDuration',
  'lastAPIDurationWithoutRetries',
  'lastCost',
  'lastDuration',
  'lastLinesAdded',
  'lastLinesRemoved',
  'lastModelUsage',
  'lastSessionId',
  'lastTotalCacheCreationInputTokens',
  'lastTotalCacheReadInputTokens',
  'lastTotalInputTokens',
  'lastTotalOutputTokens',
  'lastTotalWebSearchRequests',
  'lastToolDuration',
]

describe('ClaudeCostStateStore load', () => {
  it('returns null for a missing file, absent project, and mismatched session', async () => {
    const { statePath, store } = await fixture()

    await expect(store.load(SESSION_ID)).resolves.toBeNull()

    await writeState(statePath, { projects: {} })
    await expect(store.load(SESSION_ID)).resolves.toBeNull()

    await writeState(statePath, {
      projects: { [PROJECT]: { lastSessionId: 'other' } },
    })
    await expect(store.load(SESSION_ID)).resolves.toBeNull()
  })

  it('restores every field from an exact native fixture without aliasing', async () => {
    const { statePath, store } = await fixture()
    const fixtureObject = {
      version: 2,
      projects: { [PROJECT]: NATIVE_PROJECT },
    }
    await writeState(statePath, fixtureObject)

    const loaded = await store.load(SESSION_ID)
    expect(loaded).toEqual(baseState())
    expect(loaded).not.toBeNull()
    if (loaded === null) {
      throw new Error('expected seeded native fixture to load a non-null state')
    }
    expect(Object.keys(loaded.modelUsage).sort()).toEqual([
      'claude-3-5-sonnet-20241022',
      'gpt-4o',
    ])

    // Mutating returned records must not corrupt the parsed fixture or future loads.
    const records = loaded.modelUsage as unknown as Record<
      string,
      {
        inputTokens: number
        outputTokens: number
        cacheReadInputTokens: number
        cacheCreationInputTokens: number
        webSearchRequests: number
        costUsd: number
      }
    >
    const claudeRecord = records['claude-3-5-sonnet-20241022']
    const gptRecord = records['gpt-4o']
    if (claudeRecord === undefined || gptRecord === undefined) {
      throw new Error('expected seeded model usage records to be present')
    }
    claudeRecord.inputTokens = 999
    gptRecord.outputTokens = 777

    expect(await store.load(SESSION_ID)).toEqual(baseState())
    expect(fixtureObject).toEqual({
      version: 2,
      projects: { [PROJECT]: NATIVE_PROJECT },
    })
  })

  it('restores zeros and an empty model map from a legacy fixture', async () => {
    const { statePath, store } = await fixture()
    await writeState(statePath, {
      projects: { [PROJECT]: { lastSessionId: SESSION_ID } },
    })

    expect(await store.load(SESSION_ID)).toEqual({
      sessionId: SESSION_ID,
      totalCostUsd: 0,
      apiDurationMs: 0,
      apiDurationWithoutRetriesMs: 0,
      toolDurationMs: 0,
      wallDurationMs: 0,
      linesAdded: 0,
      linesRemoved: 0,
      modelUsage: {},
      hasUnknownModelCost: false,
    })
  })
})

describe('ClaudeCostStateStore save', () => {
  it('writes the exact owned shape, derived totals, and round-trips', async () => {
    const { statePath, store } = await fixture()
    const state = baseState()

    await store.save(state)

    const content = await readFile(statePath, 'utf8')
    expect(content.endsWith('\n')).toBe(true)
    expect(content).toContain('\n  "projects":')
    const parsed = JSON.parse(content) as {
      projects: Record<string, Record<string, unknown>>
    }
    expect(content).toBe(`${JSON.stringify(parsed, null, 2)}\n`)

    const project = parsed.projects[PROJECT]
    if (project === undefined) {
      throw new Error(`expected parsed state to contain project ${PROJECT}`)
    }
    expect(Object.keys(project).sort()).toEqual([...OWNED_PROJECT_KEYS].sort())
    expect(project.lastTotalInputTokens).toBe(300)
    expect(project.lastTotalOutputTokens).toBe(150)
    expect(project.lastTotalCacheCreationInputTokens).toBe(15)
    expect(project.lastTotalCacheReadInputTokens).toBe(25)
    expect(project.lastTotalWebSearchRequests).toBe(3)
    expect(project.lastModelUsage).toEqual({
      'claude-3-5-sonnet-20241022': {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 25,
        cacheCreationInputTokens: 10,
        webSearchRequests: 3,
        costUSD: 1.2345,
      },
      'gpt-4o': {
        inputTokens: 200,
        outputTokens: 100,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 5,
        webSearchRequests: 0,
        costUSD: 0.5,
      },
    })

    expect(await store.load(SESSION_ID)).toEqual(state)

    const info = await stat(statePath)
    expect(info.mode & 0o077).toBe(0)
    expect(info.mode & 0o200).not.toBe(0)
  })

  it('preserves foreign root/sibling/project/model fields and drops stale models', async () => {
    const { statePath, store } = await fixture()
    await writeState(statePath, {
      version: 9,
      projects: {
        [OTHER]: { keep: true },
        [PROJECT]: {
          displayName: 'My Project',
          lastModelUsage: {
            'claude-3-5-sonnet-20241022': {
              legacyFlag: true,
              inputTokens: 999,
              costUSD: 9.99,
            },
            'stale-model': { inputTokens: 1, costUSD: 0.01 },
          },
          lastSessionId: 'old-session',
        },
      },
    })

    await store.save(baseState())

    const parsed = (await readState(statePath)) as {
      version: number
      projects: Record<string, Record<string, unknown>>
    }
    expect(parsed.version).toBe(9)
    expect(parsed.projects[OTHER]).toEqual({ keep: true })
    const project = parsed.projects[PROJECT]
    if (project === undefined) {
      throw new Error(`expected parsed state to contain project ${PROJECT}`)
    }
    expect(project.displayName).toBe('My Project')
    expect(project.lastModelUsage).toMatchObject({
      'claude-3-5-sonnet-20241022': {
        legacyFlag: true,
        inputTokens: 100,
        costUSD: 1.2345,
      },
    })
    expect(project.lastModelUsage).not.toHaveProperty('stale-model')
  })
})

describe('ClaudeCostStateStore failure safety', () => {
  it('fails closed on corrupt read shapes without replacing the file', async () => {
    const { statePath, store } = await fixture()
    const json = (value: unknown): string => JSON.stringify(value)
    const cases: Array<{ name: string; content: string; error: string }> = [
      {
        name: 'malformed JSON',
        content: '{bad',
        error: `Invalid JSON: ${statePath}`,
      },
      {
        name: 'non-object root',
        content: json([]),
        error: `JSON root must be an object: ${statePath}`,
      },
      {
        name: 'non-object projects',
        content: json({ projects: 'x' }),
        error: 'Invalid value for projects: expected an object',
      },
      {
        name: 'non-object selected project',
        content: json({ projects: { [PROJECT]: 42 } }),
        error: `Invalid value for projects.${PROJECT}: expected an object`,
      },
      {
        name: 'non-object model map',
        content: json({
          projects: {
            [PROJECT]: { lastSessionId: SESSION_ID, lastModelUsage: 'x' },
          },
        }),
        error: 'Invalid value for lastModelUsage: expected an object',
      },
      {
        name: 'non-object model entry',
        content: json({
          projects: {
            [PROJECT]: {
              lastSessionId: SESSION_ID,
              lastModelUsage: { 'claude-3-5-sonnet-20241022': 42 },
            },
          },
        }),
        error:
          'Invalid value for lastModelUsage.claude-3-5-sonnet-20241022: expected an object',
      },
      {
        name: 'invalid present metric',
        content: json({
          projects: { [PROJECT]: { lastSessionId: SESSION_ID, lastCost: -5 } },
        }),
        error:
          'Invalid value for lastCost: expected a finite non-negative number',
      },
      {
        name: 'fractional counter',
        content: json({
          projects: {
            [PROJECT]: { lastSessionId: SESSION_ID, lastLinesAdded: 1.5 },
          },
        }),
        error: 'Invalid value for lastLinesAdded: expected an integer',
      },
    ]

    for (const testCase of cases) {
      await writeRaw(statePath, testCase.content)
      const original = await readFile(statePath, 'utf8')
      await expect(store.load(SESSION_ID)).rejects.toThrow(testCase.error)
      expect(await readFile(statePath, 'utf8')).toBe(original)
    }
  })

  it('fails closed on corrupt merge inputs and unsafe derived totals', async () => {
    const { statePath, store } = await fixture()
    const json = (value: unknown): string => JSON.stringify(value)
    const mergeCases: Array<{ content: string; error: string }> = [
      {
        content: '{bad',
        error: `Invalid JSON: ${statePath}`,
      },
      {
        content: json({ projects: 'x' }),
        error: 'Invalid value for projects: expected an object',
      },
      {
        content: json({ projects: { [PROJECT]: 42 } }),
        error: `Invalid value for projects.${PROJECT}: expected an object`,
      },
      {
        content: json({ projects: { [PROJECT]: { lastModelUsage: 'x' } } }),
        error: 'Invalid value for lastModelUsage: expected an object',
      },
    ]
    for (const testCase of mergeCases) {
      await writeRaw(statePath, testCase.content)
      const original = await readFile(statePath, 'utf8')
      await expect(store.save(baseState())).rejects.toThrow(testCase.error)
      expect(await readFile(statePath, 'utf8')).toBe(original)
    }

    await writeState(statePath, { version: 1 })
    const original = await readFile(statePath, 'utf8')
    const unsafe = withModelUsage({
      a: { ...VALID_USAGE, inputTokens: Number.MAX_SAFE_INTEGER },
      b: { ...VALID_USAGE, inputTokens: 1 },
    })
    await expect(store.save(unsafe)).rejects.toThrow(
      'Invalid value for lastTotalInputTokens: expected a safe integer',
    )
    expect(await readFile(statePath, 'utf8')).toBe(original)
  })

  it('rejects load/save through a symlinked state path without touching the target', async () => {
    const { root, statePath, store } = await fixture()
    const targetPath = join(root, 'target.json')
    const targetContent = JSON.stringify({
      projects: { [PROJECT]: { lastSessionId: SESSION_ID, lastCost: 5 } },
    })
    await writeRaw(targetPath, targetContent)
    await symlink(targetPath, statePath)

    await expect(store.load(SESSION_ID)).rejects.toThrow(
      `Claude state path must be a regular file: ${statePath}`,
    )
    await expect(store.save(baseState())).rejects.toThrow(
      `Claude state path must be a regular file: ${statePath}`,
    )
    expect(await readFile(targetPath, 'utf8')).toBe(targetContent)
  })

  it('rejects invalid constructor/session IDs and in-memory state before mutation', async () => {
    expect(
      () =>
        new ClaudeCostStateStore({ statePath: '  ', projectIdentity: PROJECT }),
    ).toThrow('statePath must not be blank')
    expect(
      () =>
        new ClaudeCostStateStore({
          statePath: '/tmp/x.json',
          projectIdentity: '  ',
        }),
    ).toThrow('projectIdentity must not be blank')

    const { statePath, store } = await fixture()
    await expect(store.load(' ')).rejects.toThrow('sessionId must not be blank')

    await writeState(statePath, { version: 5, projects: {} })
    const original = await readFile(statePath, 'utf8')

    const invalidStates: Array<{
      state: ClaudeSessionCostState
      error: RegExp
    }> = [
      {
        state: { ...baseState(), totalCostUsd: -1 },
        error: /Invalid value for totalCostUsd/,
      },
      {
        state: { ...baseState(), wallDurationMs: -1 },
        error: /Invalid value for wallDurationMs/,
      },
      {
        state: { ...baseState(), linesAdded: 1.5 },
        error: /Invalid value for linesAdded/,
      },
      {
        state: { ...baseState(), linesRemoved: -2 },
        error: /Invalid value for linesRemoved/,
      },
      {
        state: withModelUsage('x'),
        error: /Invalid value for modelUsage: expected an object/,
      },
      {
        state: withModelUsage({ ' ': VALID_USAGE }),
        error: /must not be blank/,
      },
      {
        state: withModelUsage({ m: 'x' }),
        error: /Invalid value for modelUsage.m: expected an object/,
      },
      {
        state: withModelUsage({ m: { ...VALID_USAGE, inputTokens: 0.5 } }),
        error: /modelUsage.m.inputTokens: expected an integer/,
      },
      {
        state: withModelUsage({ m: { ...VALID_USAGE, costUsd: -1 } }),
        error: /modelUsage.m.costUsd: expected a finite non-negative number/,
      },
    ]
    for (const { state, error } of invalidStates) {
      await expect(store.save(state)).rejects.toThrow(error)
    }
    expect(await readFile(statePath, 'utf8')).toBe(original)

    await store.save(baseState())
    expect(await store.load(SESSION_ID)).toEqual(baseState())
  })

  it('rejects invalid in-memory state without creating a missing state file', async () => {
    const { statePath, store } = await fixture()
    await expect(
      store.save({ ...baseState(), totalCostUsd: -1 }),
    ).rejects.toThrow('Invalid value for totalCostUsd')
    await expect(readFile(statePath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

describe('ClaudeCostStateStore concurrency', () => {
  it('saves two projects through a shared lock without losing data', async () => {
    const { statePath, lockFile } = await fixture()
    await writeState(statePath, {
      version: 7,
      projects: { 'proj-c': { keep: 1 } },
    })

    const storeA = new ClaudeCostStateStore({
      statePath,
      projectIdentity: PROJECT,
      lockFile,
    })
    const storeB = new ClaudeCostStateStore({
      statePath,
      projectIdentity: OTHER,
      lockFile,
    })
    await Promise.all([
      storeA.save(baseState()),
      storeB.save({
        ...baseState(),
        sessionId: 'session-b',
        totalCostUsd: 9.9,
      }),
    ])

    const parsed = (await readState(statePath)) as {
      version: number
      projects: Record<string, Record<string, unknown>>
    }
    expect(parsed.version).toBe(7)
    expect(parsed.projects['proj-c']).toEqual({ keep: 1 })
    expect(parsed.projects[PROJECT]).toMatchObject({
      lastSessionId: SESSION_ID,
      lastCost: 1.7345,
    })
    expect(parsed.projects[OTHER]).toMatchObject({
      lastSessionId: 'session-b',
      lastCost: 9.9,
    })
    expect(await storeA.load(SESSION_ID)).toEqual(baseState())
  })

  it('retries and preserves a foreign edit injected by afterValidation', async () => {
    const { statePath, store } = await fixture()
    await writeState(statePath, { version: 3, projects: {} })
    let injected = false
    const hooks = {
      afterValidation: async (): Promise<void> => {
        if (!injected) {
          injected = true
          const current = (await readState(statePath)) as Record<
            string,
            unknown
          >
          await writeRaw(
            statePath,
            JSON.stringify({ ...current, foreignEdit: 'yes' }),
          )
        }
      },
    }

    await store.save(baseState(), hooks)

    expect(injected).toBe(true)
    const parsed = (await readState(statePath)) as Record<string, unknown>
    expect(parsed.foreignEdit).toBe('yes')
    expect(parsed.version).toBe(3)
    expect(await store.load(SESSION_ID)).toEqual(baseState())
  })

  it('throws the concurrent-change error when the file changes on every attempt', async () => {
    const { statePath, store } = await fixture()
    await writeState(statePath, { version: 1 })
    let calls = 0
    const hooks = {
      afterValidation: async (): Promise<void> => {
        calls += 1
        await writeRaw(statePath, JSON.stringify({ external: calls }))
      },
    }

    await expect(store.save(baseState(), hooks)).rejects.toThrow(
      `Claude state changed concurrently: ${statePath}`,
    )
    expect(calls).toBe(3)
    expect(await readState(statePath)).toEqual({ external: 3 })
  })
})

describe('ClaudeCostStateStore unknown-cost sidecar', () => {
  it('persists the unknown-model flag in a private sidecar while keeping native fields Praxis-free', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-claude-cost-sidecar-'))
    roots.push(root)
    const statePath = join(root, 'work', '.claude', 'claude-cost-state.json')
    const sidecarPath = join(
      root,
      'config',
      'praxis',
      'unknown-cost-sidecar.json',
    )
    const lockFile = join(
      root,
      'config',
      'praxis',
      'locks',
      'praxis-state.lock',
    )
    const sidecarLockFile = join(
      root,
      'config',
      'praxis',
      'locks',
      'unknown-cost-sidecar.lock',
    )
    await mkdir(dirname(statePath), { recursive: true })
    await mkdir(dirname(sidecarPath), { recursive: true })
    await mkdir(dirname(lockFile), { recursive: true })
    const store = new ClaudeCostStateStore({
      statePath,
      projectIdentity: PROJECT,
      lockFile,
      sidecarPath,
      sidecarLockFile,
    })

    const state = { ...baseState(), hasUnknownModelCost: true }
    await store.save(state)

    const parsed = (await readState(statePath)) as {
      projects: Record<string, Record<string, unknown>>
    }
    const project = parsed.projects[PROJECT]
    if (project === undefined) {
      throw new Error(`expected parsed state to contain project ${PROJECT}`)
    }
    expect(Object.keys(project).sort()).toEqual([...OWNED_PROJECT_KEYS].sort())
    expect(project).not.toHaveProperty('hasUnknownModelCost')

    const restored = await store.load(SESSION_ID)
    expect(restored).toEqual(state)

    // A malformed sidecar fails closed without blocking the native cost load.
    await writeRaw(sidecarPath, '{bad')
    const recovered = await store.load(SESSION_ID)
    expect(recovered).not.toBeNull()
    expect(recovered?.hasUnknownModelCost).toBe(false)
    expect(recovered?.totalCostUsd).toBe(state.totalCostUsd)
  })

  it('loads the unknown-model flag as false when no sidecar path is configured', async () => {
    const { store } = await fixture()
    await store.save(baseState())

    const restored = await store.load(SESSION_ID)
    expect(restored?.hasUnknownModelCost).toBe(false)
  })
})
