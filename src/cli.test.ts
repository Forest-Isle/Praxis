import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { ModelProvider, ModelToolCall } from './core/runtime.js'
import type { AgentColorSelection } from './compatibility/claude/agent-color.js'
import type { ClaudePermissionMode } from './permissions/claude-permission-resolver.js'
import type { ClaudeSessionCostSnapshot } from './application/session-cost-tracker.js'
import { ClaudeSessionService } from './application/session-service.js'
import { resolveDataPlanePaths } from './persistence/data-plane.js'
import {
  createBackgroundWorkerRuntime,
  parseContextEnvironment,
  parseProviderEnvironment,
  run,
  type CliDependencies,
  type CliIO,
} from './cli.js'
import { DEFAULT_CLI_CONTROLS } from './cli/controls.js'
import type { CliControls } from './cli/protocol.js'
import type { DataPlane } from './persistence/data-plane.js'
import {
  createDefaultDependencies,
  createSessionMemoryProviderFactory,
  resolveInteractiveRuntimeSettingsLocation,
  resolveUnknownCostSidecarPath,
  resolveRuntimeModel,
} from './cli-runtime.js'
import { projectRuntimeSettings } from './cli/tui/runtime-settings.js'

const PACKAGE_VERSION = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version

function captureIO() {
  const stdout: string[] = []
  const stdoutBytes: Buffer[] = []
  const stderr: string[] = []
  const io: CliIO = {
    stdout: (message) => {
      const bytes = Buffer.from(message)
      stdoutBytes.push(bytes)
      stdout.push(bytes.toString())
    },
    stderr: (message) => stderr.push(message),
  }
  return { io, stdout, stdoutBytes, stderr }
}

function captureStreamIO(...chunks: string[]) {
  const capture = captureIO()
  capture.io.readStdinLines = () =>
    (async function* () {
      for (const chunk of chunks) yield chunk
    })()
  return capture
}

function dependencies(
  warning?: string,
  transcript = Buffer.from('{"type":"user"}\n'),
): CliDependencies {
  return {
    async createService({ eventSink }) {
      return {
        async run(prompt, _signal, sessionId) {
          if (warning) eventSink({ type: 'warning', message: warning })
          eventSink({ type: 'text-delta', delta: `answer:${prompt}` })
          return {
            sessionId: sessionId ?? '11111111-1111-4111-8111-111111111111',
            text: `answer:${prompt}`,
            usage: { inputTokens: 2, outputTokens: 3 },
          }
        },
        async resume(sessionId, prompt) {
          eventSink({ type: 'text-delta', delta: `resumed:${prompt}` })
          return {
            sessionId,
            text: `resumed:${prompt}`,
            usage: { inputTokens: 4, outputTokens: 5 },
          }
        },
        async fork(parentSessionId) {
          return {
            parentSessionId,
            sessionId: '22222222-2222-4222-8222-222222222222',
          }
        },
        async sessions() {
          return [
            {
              sessionId: '11111111-1111-4111-8111-111111111111',
              lastPrompt: 'hello',
              updatedAt: '2026-08-03T00:00:00.000Z',
              status: 'ready' as const,
              issue: null,
            },
          ]
        },
        async inspect(sessionId) {
          return {
            sessionId,
            status: 'ready' as const,
            writeMode: 'read-write' as const,
            claudeVersion: '2.1.208',
            lastPrompt: 'hello',
            updatedAt: '2026-08-03T00:00:00.000Z',
            entryCount: 3,
            byteLength: 128,
            newlineTerminated: true,
            issue: null,
          }
        },
        async export() {
          return transcript
        },
      }
    },
  }
}

interface ColorUsageCall {
  sessionId: string | undefined
  selection: AgentColorSelection
  display: string
  permissionMode: ClaudePermissionMode
  options: { createSession?: boolean } | undefined
}

function colorDependencies() {
  const calls: ColorUsageCall[] = []
  const serviceCreations: Array<{ requireProvider: boolean }> = []
  const base = dependencies()
  const colorTestDependencies: CliDependencies = {
    async createService(options) {
      serviceCreations.push({ requireProvider: options.requireProvider })
      const service = await base.createService(options)
      return {
        ...service,
        async recordColorUsage(
          sessionId: string | undefined,
          selection: AgentColorSelection,
          display: string,
          permissionMode: ClaudePermissionMode,
          options?: { createSession?: boolean },
        ) {
          calls.push({
            sessionId,
            selection,
            display,
            permissionMode,
            options,
          })
          return sessionId ?? '33333333-3333-4333-8333-333333333333'
        },
      }
    },
  }
  return {
    dependencies: colorTestDependencies,
    calls,
    serviceCreations,
  }
}

const COST_MODEL = 'claude-sonnet-4-20250514'
const ZERO_COST_SUMMARY =
  'Total cost:            $0.0000\n' +
  'Total duration (API):  0s\n' +
  'Total duration (wall): 0s\n' +
  'Total code changes:    0 lines added, 0 lines removed\n' +
  'Usage:                 0 input, 0 output, 0 cache read, 0 cache write'

function zeroCostSnapshot(sessionId: string): ClaudeSessionCostSnapshot {
  return {
    sessionId,
    totalCostUsd: 0,
    apiDurationMs: 0,
    apiDurationWithoutRetriesMs: 0,
    toolDurationMs: 0,
    wallDurationMs: 0,
    linesAdded: 0,
    linesRemoved: 0,
    modelUsage: {},
    hasUnknownModelCost: false,
  }
}

function recordModelTurn(
  snapshot: ClaudeSessionCostSnapshot,
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
    webSearchRequests: number
    costUsd: number
  },
): ClaudeSessionCostSnapshot {
  const prior = snapshot.modelUsage[COST_MODEL] ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUsd: 0,
  }
  return {
    ...snapshot,
    totalCostUsd: snapshot.totalCostUsd + usage.costUsd,
    apiDurationMs: snapshot.apiDurationMs + 500,
    wallDurationMs: snapshot.wallDurationMs + 1200,
    linesAdded: snapshot.linesAdded + 2,
    linesRemoved: snapshot.linesRemoved + 1,
    modelUsage: {
      ...snapshot.modelUsage,
      [COST_MODEL]: {
        inputTokens: prior.inputTokens + usage.inputTokens,
        outputTokens: prior.outputTokens + usage.outputTokens,
        cacheReadInputTokens:
          prior.cacheReadInputTokens + usage.cacheReadInputTokens,
        cacheCreationInputTokens:
          prior.cacheCreationInputTokens + usage.cacheCreationInputTokens,
        webSearchRequests: prior.webSearchRequests + usage.webSearchRequests,
        costUsd: prior.costUsd + usage.costUsd,
      },
    },
  }
}

interface CostDependenciesOptions {
  historic?: ClaudeSessionCostSnapshot
  regress?: boolean
}

interface CostDependenciesResult {
  dependencies: CliDependencies
  serviceCreations: Array<{ requireProvider: boolean }>
  runCalls: string[]
  resumeCalls: string[]
  costSnapshotCalls: string[]
}

function costDependencies(
  options: CostDependenciesOptions = {},
): CostDependenciesResult {
  const serviceCreations: Array<{ requireProvider: boolean }> = []
  const runCalls: string[] = []
  const resumeCalls: string[] = []
  const costSnapshotCalls: string[] = []
  const snapshots = new Map<string, ClaudeSessionCostSnapshot>()
  const snapshotCalls = new Map<string, number>()
  if (options.historic) {
    snapshots.set(options.historic.sessionId, options.historic)
  }
  const base = dependencies()
  const costTestDependencies: CliDependencies = {
    async createService(serviceOptions) {
      serviceCreations.push({ requireProvider: serviceOptions.requireProvider })
      const eventSink = serviceOptions.eventSink
      const service = await base.createService(serviceOptions)
      return {
        ...service,
        async run(prompt, _signal, sessionId) {
          runCalls.push(prompt)
          eventSink({ type: 'text-delta', delta: `answer:${prompt}` })
          const id = sessionId ?? '11111111-1111-4111-8111-111111111111'
          snapshots.set(
            id,
            recordModelTurn(snapshots.get(id) ?? zeroCostSnapshot(id), {
              inputTokens: 10,
              outputTokens: 5,
              cacheReadInputTokens: 3,
              cacheCreationInputTokens: 2,
              webSearchRequests: 1,
              costUsd: 0.001,
            }),
          )
          return {
            sessionId: id,
            text: `answer:${prompt}`,
            usage: { inputTokens: 10, outputTokens: 5 },
          }
        },
        async resume(sessionId, prompt) {
          resumeCalls.push(prompt)
          eventSink({ type: 'text-delta', delta: `resumed:${prompt}` })
          snapshots.set(
            sessionId,
            recordModelTurn(
              snapshots.get(sessionId) ?? zeroCostSnapshot(sessionId),
              {
                inputTokens: 4,
                outputTokens: 5,
                cacheReadInputTokens: 1,
                cacheCreationInputTokens: 1,
                webSearchRequests: 0,
                costUsd: 0.002,
              },
            ),
          )
          return {
            sessionId,
            text: `resumed:${prompt}`,
            usage: { inputTokens: 4, outputTokens: 5 },
          }
        },
        async costSnapshot(sessionId) {
          costSnapshotCalls.push(sessionId)
          const calls = (snapshotCalls.get(sessionId) ?? 0) + 1
          snapshotCalls.set(sessionId, calls)
          if (options.regress && calls >= 2) {
            const current =
              snapshots.get(sessionId) ?? zeroCostSnapshot(sessionId)
            return {
              ...current,
              totalCostUsd: current.totalCostUsd - 1,
              modelUsage: Object.fromEntries(
                Object.entries(current.modelUsage).map(([model, usage]) => [
                  model,
                  { ...usage, inputTokens: usage.inputTokens - 1 },
                ]),
              ),
            }
          }
          return snapshots.get(sessionId) ?? zeroCostSnapshot(sessionId)
        },
      }
    },
  }
  return {
    dependencies: costTestDependencies,
    serviceCreations,
    runCalls,
    resumeCalls,
    costSnapshotCalls,
  }
}

describe('Praxis CLI', () => {
  it('runs release notes provider-free in text, JSON, and stream JSON modes', async () => {
    let serviceCreations = 0
    const localDependencies: CliDependencies = {
      async createService() {
        serviceCreations += 1
        throw new Error('release notes must not create a model service')
      },
      async loadReleaseNotes() {
        return 'Version 2.1.208:\n· Fixture note'
      },
    }

    const text = captureIO()
    await expect(
      run(['-p', '/release-notes'], text.io, localDependencies),
    ).resolves.toBe(0)
    expect(text.stdout.join('')).toBe('Version 2.1.208:\n· Fixture note\n')

    const json = captureIO()
    await expect(
      run(
        ['-p', '--output-format', 'json', '/release-notes'],
        json.io,
        localDependencies,
      ),
    ).resolves.toBe(0)
    expect(JSON.parse(json.stdout.join(''))).toMatchObject({
      type: 'result',
      subtype: 'success',
      num_turns: 0,
      result: 'Version 2.1.208:\n· Fixture note',
      usage: { input_tokens: 0, output_tokens: 0 },
    })

    const stream = captureIO()
    await expect(
      run(
        ['-p', '--verbose', '--output-format', 'stream-json', '/release-notes'],
        stream.io,
        localDependencies,
      ),
    ).resolves.toBe(0)
    const records = stream.stdout.map((line) => JSON.parse(line))
    expect(records.map(({ type }) => type)).toEqual([
      'system',
      'assistant',
      'result',
    ])
    expect(records[1]).toMatchObject({
      type: 'assistant',
      message: { content: [{ text: 'Version 2.1.208:\n· Fixture note' }] },
    })
    expect(serviceCreations).toBe(0)

    const disabled = captureIO()
    await expect(
      run(['-p', '--disable-slash-commands', '/release-notes'], disabled.io, {
        ...dependencies(),
        loadReleaseNotes: async () => 'Version 2.1.208:\n· Fixture note',
      }),
    ).resolves.toBe(0)
    expect(disabled.stdout.join('')).toBe('answer:/release-notes\n')
  })

  it('uses the selected data plane for release notes and fallback runtime info', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-cli-data-plane-info-'))
    const praxisRoot = join(root, 'praxis')
    const claudeRoot = join(root, 'claude')
    const previousPraxisHome = process.env.PRAXIS_HOME
    const previousClaudeRoot = process.env.CLAUDE_CONFIG_DIR
    const previousDataPlane = process.env.PRAXIS_DATA_PLANE
    const previousModel = process.env.PRAXIS_MODEL
    await mkdir(praxisRoot, { recursive: true })
    await mkdir(claudeRoot, { recursive: true })
    await writeFile(
      join(praxisRoot, 'settings.json'),
      JSON.stringify({ model: 'native-settings-model' }),
    )
    await writeFile(
      join(claudeRoot, 'settings.json'),
      JSON.stringify({ model: 'claude-settings-model' }),
    )
    process.env.PRAXIS_HOME = praxisRoot
    process.env.CLAUDE_CONFIG_DIR = claudeRoot
    delete process.env.PRAXIS_DATA_PLANE
    delete process.env.PRAXIS_MODEL
    try {
      const loadedRoots: string[] = []
      const localDependencies: CliDependencies = {
        async createService() {
          throw new Error('release notes must not create a model service')
        },
        async loadReleaseNotes(configRoot) {
          loadedRoots.push(configRoot)
          return 'fixture notes'
        },
      }
      const native = captureIO()
      await expect(
        run(
          ['-p', '--output-format', 'json', '/release-notes'],
          native.io,
          localDependencies,
        ),
      ).resolves.toBe(0)
      const claude = captureIO()
      await expect(
        run(
          [
            '-p',
            '--data-plane',
            'claude',
            '--output-format',
            'json',
            '/release-notes',
          ],
          claude.io,
          localDependencies,
        ),
      ).resolves.toBe(0)

      expect(loadedRoots).toEqual([praxisRoot, claudeRoot])
      expect(
        Object.keys(JSON.parse(native.stdout.join('')).modelUsage),
      ).toEqual(['native-settings-model'])
      expect(
        Object.keys(JSON.parse(claude.stdout.join('')).modelUsage),
      ).toEqual(['claude-settings-model'])
    } finally {
      if (previousPraxisHome === undefined) delete process.env.PRAXIS_HOME
      else process.env.PRAXIS_HOME = previousPraxisHome
      if (previousClaudeRoot === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeRoot
      if (previousDataPlane === undefined) delete process.env.PRAXIS_DATA_PLANE
      else process.env.PRAXIS_DATA_PLANE = previousDataPlane
      if (previousModel === undefined) delete process.env.PRAXIS_MODEL
      else process.env.PRAXIS_MODEL = previousModel
      await rm(root, { recursive: true, force: true })
    }
  })

  it('loads auto-mode settings only from the selected data plane', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-auto-mode-plane-'))
    const praxisRoot = join(root, 'praxis')
    const claudeRoot = join(root, 'claude')
    const previousPraxisHome = process.env.PRAXIS_HOME
    const previousClaudeRoot = process.env.CLAUDE_CONFIG_DIR
    const previousDataPlane = process.env.PRAXIS_DATA_PLANE
    await mkdir(praxisRoot, { recursive: true })
    await mkdir(claudeRoot, { recursive: true })
    const settings = (label: string) =>
      JSON.stringify({
        autoMode: {
          allow: [label],
          soft_deny: [],
          hard_deny: [],
          environment: [],
        },
      })
    await writeFile(join(praxisRoot, 'settings.json'), settings('native-rule'))
    await writeFile(join(claudeRoot, 'settings.json'), settings('claude-rule'))
    process.env.PRAXIS_HOME = praxisRoot
    process.env.CLAUDE_CONFIG_DIR = claudeRoot
    delete process.env.PRAXIS_DATA_PLANE
    try {
      const unavailable: CliDependencies = {
        async createService() {
          throw new Error('service must not be created for auto-mode config')
        },
      }
      const native = captureIO()
      await expect(
        run(['auto-mode', 'config'], native.io, unavailable),
      ).resolves.toBe(0)
      const claude = captureIO()
      await expect(
        run(
          ['auto-mode', 'config', '--data-plane', 'claude'],
          claude.io,
          unavailable,
        ),
      ).resolves.toBe(0)

      expect(JSON.parse(native.stdout.join('')).allow).toEqual(['native-rule'])
      expect(JSON.parse(claude.stdout.join('')).allow).toEqual(['claude-rule'])
    } finally {
      if (previousPraxisHome === undefined) delete process.env.PRAXIS_HOME
      else process.env.PRAXIS_HOME = previousPraxisHome
      if (previousClaudeRoot === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeRoot
      if (previousDataPlane === undefined) delete process.env.PRAXIS_DATA_PLANE
      else process.env.PRAXIS_DATA_PLANE = previousDataPlane
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resets auto-mode settings only in the selected data plane', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-auto-mode-reset-'))
    const praxisRoot = join(root, 'praxis')
    const claudeRoot = join(root, 'claude')
    const previousPraxisHome = process.env.PRAXIS_HOME
    const previousClaudeRoot = process.env.CLAUDE_CONFIG_DIR
    await mkdir(praxisRoot, { recursive: true })
    await mkdir(claudeRoot, { recursive: true })
    const settings = JSON.stringify({
      theme: 'dark',
      autoMode: { allow: ['custom-rule'] },
    })
    await writeFile(join(praxisRoot, 'settings.json'), settings)
    await writeFile(join(claudeRoot, 'settings.json'), settings)
    process.env.PRAXIS_HOME = praxisRoot
    process.env.CLAUDE_CONFIG_DIR = claudeRoot
    try {
      let serviceCreations = 0
      const unavailable: CliDependencies = {
        async createService() {
          serviceCreations += 1
          throw new Error('service must not be created for auto-mode reset')
        },
      }
      const native = captureIO()
      await expect(
        run(['auto-mode', 'reset', '--yes'], native.io, unavailable),
      ).resolves.toBe(0)
      expect(
        JSON.parse(await readFile(join(praxisRoot, 'settings.json'), 'utf8')),
      ).toEqual({ theme: 'dark' })
      expect(
        JSON.parse(await readFile(join(claudeRoot, 'settings.json'), 'utf8')),
      ).toHaveProperty('autoMode')

      const claude = captureIO()
      await expect(
        run(
          ['auto-mode', 'reset', '--data-plane', 'claude', '--yes'],
          claude.io,
          unavailable,
        ),
      ).resolves.toBe(0)
      expect(
        JSON.parse(await readFile(join(claudeRoot, 'settings.json'), 'utf8')),
      ).toEqual({ theme: 'dark' })
      expect(native.stdout.join('')).toContain('autoMode section removed')
      expect(claude.stdout.join('')).toContain('autoMode section removed')
      expect(serviceCreations).toBe(0)
    } finally {
      if (previousPraxisHome === undefined) delete process.env.PRAXIS_HOME
      else process.env.PRAXIS_HOME = previousPraxisHome
      if (previousClaudeRoot === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeRoot
      await rm(root, { recursive: true, force: true })
    }
  })

  it('runs /color provider-free in text mode with a local session', async () => {
    const {
      dependencies: colorDeps,
      calls,
      serviceCreations,
    } = colorDependencies()

    const text = captureIO()
    await expect(
      run(['-p', '/color purple'], text.io, colorDeps),
    ).resolves.toBe(0)
    expect(text.stdout.join('')).toBe('Session color set to: purple\n')
    expect(text.stderr).toEqual([])
    expect(serviceCreations).toEqual([{ requireProvider: false }])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      sessionId: expect.any(String),
      selection: { kind: 'color', color: 'purple' },
      display: '/color purple',
      permissionMode: 'default',
      options: { createSession: true },
    })

    const trailing = captureIO()
    await expect(run(['-p', '/color '], trailing.io, colorDeps)).resolves.toBe(
      0,
    )
    expect(trailing.stdout.join('')).toMatch(
      /^Session color set to: (?:red|blue|green|yellow|purple|orange|pink|cyan)\n$/,
    )
    expect(calls.at(-1)).toMatchObject({
      display: '/color',
      selection: { kind: 'color' },
      options: { createSession: true },
    })
  })

  it('runs /color provider-free in JSON mode with a zero-turn envelope', async () => {
    const {
      dependencies: colorDeps,
      calls,
      serviceCreations,
    } = colorDependencies()

    const json = captureIO()
    await expect(
      run(
        ['-p', '--output-format', 'json', '/color orange'],
        json.io,
        colorDeps,
      ),
    ).resolves.toBe(0)
    expect(JSON.parse(json.stdout.join(''))).toMatchObject({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_api_ms: 0,
      num_turns: 0,
      result: 'Session color set to: orange',
      stop_reason: null,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
    })
    expect(serviceCreations).toEqual([{ requireProvider: false }])
    expect(calls).toHaveLength(1)
  })

  it('runs /color provider-free in stream-json mode across two stdin turns', async () => {
    const {
      dependencies: colorDeps,
      calls,
      serviceCreations,
    } = colorDependencies()
    const capture = captureStreamIO(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '/color red' },
      }) +
        '\n' +
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: '/color blue' },
        }) +
        '\n',
    )
    await expect(
      run(
        [
          'run',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--verbose',
        ],
        capture.io,
        colorDeps,
      ),
    ).resolves.toBe(0)
    expect(serviceCreations).toEqual([{ requireProvider: false }])
    const records = capture.stdout.map((line) => JSON.parse(line))
    expect(records.map(({ type }) => type)).toEqual([
      'system',
      'assistant',
      'result',
      'system',
      'assistant',
      'result',
    ])
    expect(records[0]).toMatchObject({
      type: 'system',
      subtype: 'init',
      session_id: records[2].session_id,
    })
    expect(records[1]).toMatchObject({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: '<synthetic>',
        content: [{ type: 'text', text: 'Session color set to: red' }],
        stop_reason: 'stop_sequence',
        stop_sequence: '',
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      parent_tool_use_id: null,
      session_id: records[2].session_id,
    })
    expect(records[2]).toMatchObject({
      type: 'result',
      subtype: 'success',
      num_turns: 0,
      duration_api_ms: 0,
      total_cost_usd: 0,
      result: 'Session color set to: red',
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
      stop_reason: null,
    })
    expect(records[3]).toMatchObject({
      type: 'system',
      subtype: 'init',
      session_id: records[2].session_id,
    })
    expect(records[4]).toMatchObject({
      type: 'assistant',
      message: { content: [{ text: 'Session color set to: blue' }] },
      session_id: records[2].session_id,
    })
    expect(records[5]).toMatchObject({
      type: 'result',
      num_turns: 0,
      result: 'Session color set to: blue',
      session_id: records[2].session_id,
    })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({
      display: '/color red',
      options: { createSession: true },
    })
    expect(calls[1]).toMatchObject({
      sessionId: records[2].session_id,
      display: '/color blue',
      options: undefined,
    })
  })

  it('creates a fresh local session at the explicit --session-id', async () => {
    const {
      dependencies: colorDeps,
      calls,
      serviceCreations,
    } = colorDependencies()
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const json = captureIO()
    await expect(
      run(
        [
          '-p',
          '--session-id',
          sessionId,
          '--output-format',
          'json',
          '/color red',
        ],
        json.io,
        colorDeps,
      ),
    ).resolves.toBe(0)
    expect(JSON.parse(json.stdout.join('')).session_id).toBe(sessionId)
    expect(serviceCreations).toEqual([{ requireProvider: false }])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      sessionId,
      display: '/color red',
      options: { createSession: true },
    })
  })

  it('routes /color through resume, continue, and fork session selectors', async () => {
    const { dependencies: colorDeps, calls } = colorDependencies()
    const resumed = captureIO()
    await expect(
      run(
        [
          '-p',
          '--resume',
          '11111111-1111-4111-8111-111111111111',
          '/color red',
        ],
        resumed.io,
        colorDeps,
      ),
    ).resolves.toBe(0)
    expect(resumed.stdout.join('')).toBe('Session color set to: red\n')
    expect(calls.at(-1)).toMatchObject({
      sessionId: '11111111-1111-4111-8111-111111111111',
      options: undefined,
    })

    const continued = captureIO()
    await expect(
      run(['-p', '--continue', '/color green'], continued.io, colorDeps),
    ).resolves.toBe(0)
    expect(continued.stdout.join('')).toBe('Session color set to: green\n')
    expect(calls.at(-1)).toMatchObject({
      sessionId: '11111111-1111-4111-8111-111111111111',
      options: undefined,
    })

    const forked = captureIO()
    await expect(
      run(
        ['-p', '--continue', '--fork-session', '/color cyan'],
        forked.io,
        colorDeps,
      ),
    ).resolves.toBe(0)
    expect(forked.stdout.join('')).toBe('Session color set to: cyan\n')
    expect(calls.at(-1)).toMatchObject({
      sessionId: '22222222-2222-4222-8222-222222222222',
      options: undefined,
    })
  })

  it('passes --no-session-persistence through to the service', async () => {
    const { dependencies: colorDeps } = colorDependencies()
    let received: unknown
    const passthrough: CliDependencies = {
      async createService(options) {
        received = options.controls
        const base = await colorDeps.createService(options)
        return base
      },
    }
    const capture = captureIO()
    await expect(
      run(
        ['-p', '--no-session-persistence', '/color purple'],
        capture.io,
        passthrough,
      ),
    ).resolves.toBe(0)
    expect(received).toMatchObject({ sessionPersistence: false })
    expect(capture.stdout.join('')).toBe('Session color set to: purple\n')
  })

  it('treats only bare /color as a local command and honors --disable-slash-commands', async () => {
    const {
      dependencies: colorDeps,
      calls,
      serviceCreations,
    } = colorDependencies()

    const lookalike = captureIO()
    await expect(
      run(['-p', '/colorblue'], lookalike.io, colorDeps),
    ).resolves.toBe(0)
    expect(lookalike.stdout.join('')).toBe('answer:/colorblue\n')
    expect(calls).toHaveLength(0)
    expect(serviceCreations).toEqual([{ requireProvider: true }])

    const disabled = captureIO()
    await expect(
      run(
        ['-p', '--disable-slash-commands', '/color purple'],
        disabled.io,
        colorDeps,
      ),
    ).resolves.toBe(0)
    expect(disabled.stdout.join('')).toBe('answer:/color purple\n')
    expect(calls).toHaveLength(0)
    expect(serviceCreations.at(-1)).toEqual({ requireProvider: true })
  })

  it('resumes the local session on a later non-local stream-json turn', async () => {
    const { dependencies: colorDeps, calls } = colorDependencies()
    const capture = captureStreamIO(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '/color yellow' },
      }) +
        '\n' +
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'what is 2+2?' },
        }) +
        '\n',
    )
    await expect(
      run(
        [
          'run',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--verbose',
        ],
        capture.io,
        colorDeps,
      ),
    ).resolves.toBe(0)
    const records = capture.stdout.map((line) => JSON.parse(line))
    expect(records.map(({ type }) => type)).toEqual([
      'system',
      'assistant',
      'result',
      'system',
      'assistant',
      'result',
    ])
    const localSessionId = records[2].session_id
    expect(records[5]).toMatchObject({
      result: 'resumed:what is 2+2?',
      session_id: localSessionId,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      display: '/color yellow',
      options: { createSession: true },
    })
  })

  it('runs /cost provider-free in text mode with an exact zero summary', async () => {
    const {
      dependencies: costDeps,
      serviceCreations,
      runCalls,
      resumeCalls,
      costSnapshotCalls,
    } = costDependencies()

    const text = captureIO()
    await expect(run(['-p', '/cost'], text.io, costDeps)).resolves.toBe(0)
    expect(text.stdout.join('')).toBe(`${ZERO_COST_SUMMARY}\n`)
    expect(text.stderr).toEqual([])
    expect(serviceCreations).toEqual([{ requireProvider: false }])
    expect(runCalls).toEqual([])
    expect(resumeCalls).toEqual([])
    expect(costSnapshotCalls).toHaveLength(2)
    expect(costSnapshotCalls[0]).toBe(costSnapshotCalls[1])
  })

  it('runs /cost provider-free in JSON mode with a zero-turn success envelope', async () => {
    const {
      dependencies: costDeps,
      serviceCreations,
      runCalls,
      resumeCalls,
    } = costDependencies()

    const json = captureIO()
    await expect(
      run(['-p', '--output-format', 'json', '/cost'], json.io, costDeps),
    ).resolves.toBe(0)
    expect(JSON.parse(json.stdout.join(''))).toMatchObject({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_api_ms: 0,
      num_turns: 0,
      result: ZERO_COST_SUMMARY,
      stop_reason: null,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      session_id: expect.any(String),
    })
    expect(serviceCreations).toEqual([{ requireProvider: false }])
    expect(runCalls).toEqual([])
    expect(resumeCalls).toEqual([])
  })

  it('runs /cost provider-free in stream-json mode with a synthetic assistant', async () => {
    const {
      dependencies: costDeps,
      serviceCreations,
      runCalls,
      resumeCalls,
    } = costDependencies()
    const capture = captureStreamIO(
      `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '/cost' },
      })}\n`,
    )
    await expect(
      run(
        [
          'run',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--verbose',
        ],
        capture.io,
        costDeps,
      ),
    ).resolves.toBe(0)
    expect(serviceCreations).toEqual([{ requireProvider: false }])
    expect(runCalls).toEqual([])
    expect(resumeCalls).toEqual([])
    const records = capture.stdout.map((line) => JSON.parse(line))
    expect(records.map(({ type }) => type)).toEqual([
      'system',
      'assistant',
      'result',
    ])
    expect(records[0]).toMatchObject({ type: 'system', subtype: 'init' })
    expect(records[1]).toMatchObject({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: '<synthetic>',
        content: [{ type: 'text', text: ZERO_COST_SUMMARY }],
        stop_reason: 'stop_sequence',
        stop_sequence: '',
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      parent_tool_use_id: null,
      session_id: records[2].session_id,
    })
    expect(records[2]).toMatchObject({
      type: 'result',
      subtype: 'success',
      num_turns: 0,
      duration_api_ms: 0,
      total_cost_usd: 0,
      result: ZERO_COST_SUMMARY,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
      stop_reason: null,
    })
  })

  it('accumulates same-process model usage into a later /cost stream turn', async () => {
    const { dependencies: costDeps, runCalls } = costDependencies()
    const capture = captureStreamIO(
      `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'hello' },
      })}\n${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '/cost' },
      })}\n`,
    )
    await expect(
      run(
        [
          'run',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--verbose',
        ],
        capture.io,
        costDeps,
      ),
    ).resolves.toBe(0)
    const records = capture.stdout.map((line) => JSON.parse(line))
    expect(records.map(({ type }) => type)).toEqual([
      'system',
      'assistant',
      'result',
      'system',
      'assistant',
      'result',
    ])
    expect(records[2]).toMatchObject({
      type: 'result',
      num_turns: 1,
      result: 'answer:hello',
    })
    expect(runCalls).toEqual(['hello'])
    expect(records[5]).toMatchObject({
      type: 'result',
      subtype: 'success',
      num_turns: 0,
      total_cost_usd: 0.001,
      session_id: records[2].session_id,
    })
    expect(records[5].result).toContain('claude-sonnet-4-0')
    expect(records[5].result).toContain('10 input, 5 output')
    expect(records[5].result).toContain('1 web search')
    expect(records[5].modelUsage).toEqual({
      [COST_MODEL]: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 2,
        webSearchRequests: 1,
        costUSD: 0.001,
        contextWindow: 0,
        maxOutputTokens: 0,
      },
    })
    expect(records[4]).toMatchObject({
      type: 'assistant',
      message: {
        model: '<synthetic>',
        content: [{ type: 'text', text: records[5].result }],
      },
      session_id: records[2].session_id,
    })
  })

  it('serializes runtimeInfo capability metadata into the JSON success result', async () => {
    const capture = captureIO()
    const capabilityDependencies: CliDependencies = {
      async createService() {
        return {
          async run(prompt, _signal, sessionId) {
            return {
              sessionId: sessionId ?? '11111111-1111-4111-8111-111111111111',
              text: `answer:${prompt}`,
              usage: { inputTokens: 2, outputTokens: 3 },
              modelUsage: {
                // No row metadata: falls back to the matching runtimeInfo
                // model's capability.
                'test-model': { inputTokens: 2, outputTokens: 3 },
                // Unknown model without metadata: serializes as 0.
                'legacy-model': { inputTokens: 1, outputTokens: 1 },
              },
            }
          },
          async resume(sessionId, prompt) {
            return {
              sessionId,
              text: `resumed:${prompt}`,
              usage: { inputTokens: 4, outputTokens: 5 },
            }
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
          async inspect() {
            throw new Error('unused')
          },
          async export() {
            throw new Error('unused')
          },
          runtimeInfo() {
            return {
              cwd: '/workspace',
              model: 'test-model',
              contextWindowTokens: 200_000,
              maxOutputTokens: 32_000,
              tools: [],
              mcpServers: [],
              permissionMode: 'default',
              slashCommands: [],
              agents: [],
              skills: [],
              claudeCodeVersion: '2.1.208',
            }
          },
        }
      },
    }
    await expect(
      run(
        ['run', '--output-format', 'json', 'hello'],
        capture.io,
        capabilityDependencies,
      ),
    ).resolves.toBe(0)
    const records = capture.stdout.map((line) => JSON.parse(line))
    expect(records[0]).toMatchObject({
      type: 'result',
      subtype: 'success',
      result: 'answer:hello',
      modelUsage: {
        'test-model': {
          inputTokens: 2,
          outputTokens: 3,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: null,
          contextWindow: 200_000,
          maxOutputTokens: 32_000,
        },
        'legacy-model': {
          inputTokens: 1,
          outputTokens: 1,
          costUSD: null,
          contextWindow: 0,
          maxOutputTokens: 0,
        },
      },
    })
  })

  it('runs a later model prompt normally after a local /cost stream turn', async () => {
    const {
      dependencies: costDeps,
      runCalls,
      resumeCalls,
      serviceCreations,
    } = costDependencies()
    const capture = captureStreamIO(
      `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '/cost' },
      })}\n${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'what is 2+2?' },
      })}\n`,
    )
    await expect(
      run(
        [
          'run',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--verbose',
        ],
        capture.io,
        costDeps,
      ),
    ).resolves.toBe(0)
    expect(serviceCreations).toEqual([{ requireProvider: false }])
    const records = capture.stdout.map((line) => JSON.parse(line))
    expect(records.map(({ type }) => type)).toEqual([
      'system',
      'assistant',
      'result',
      'system',
      'assistant',
      'result',
    ])
    const localSessionId = records[2].session_id
    expect(records[5]).toMatchObject({
      result: 'resumed:what is 2+2?',
      session_id: localSessionId,
    })
    expect(runCalls).toEqual([])
    expect(resumeCalls).toEqual(['what is 2+2?'])
  })

  it('excludes restored historic totals from a resumed process cost summary', async () => {
    const historicSessionId = '11111111-1111-4111-8111-111111111111'
    const historic: ClaudeSessionCostSnapshot = {
      sessionId: historicSessionId,
      totalCostUsd: 42,
      apiDurationMs: 30000,
      apiDurationWithoutRetriesMs: 30000,
      toolDurationMs: 0,
      wallDurationMs: 90000,
      linesAdded: 50,
      linesRemoved: 30,
      modelUsage: {
        [COST_MODEL]: {
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadInputTokens: 200,
          cacheCreationInputTokens: 100,
          webSearchRequests: 3,
          costUsd: 42,
        },
      },
      hasUnknownModelCost: false,
    }
    const { dependencies: costDeps } = costDependencies({ historic })
    const json = captureIO()
    await expect(
      run(
        [
          '-p',
          '--resume',
          historicSessionId,
          '--output-format',
          'json',
          '/cost',
        ],
        json.io,
        costDeps,
      ),
    ).resolves.toBe(0)
    expect(JSON.parse(json.stdout.join(''))).toMatchObject({
      type: 'result',
      subtype: 'success',
      num_turns: 0,
      duration_api_ms: 0,
      total_cost_usd: 0,
      result: ZERO_COST_SUMMARY,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
      session_id: historicSessionId,
    })
  })

  it('treats only trimmed exact /cost as a local command and honors --disable-slash-commands', async () => {
    const {
      dependencies: costDeps,
      runCalls,
      resumeCalls,
      serviceCreations,
    } = costDependencies()

    const lookalike = captureIO()
    await expect(run(['-p', '/costs'], lookalike.io, costDeps)).resolves.toBe(0)
    expect(lookalike.stdout.join('')).toBe('answer:/costs\n')
    expect(serviceCreations.at(-1)).toEqual({ requireProvider: true })

    const extra = captureIO()
    await expect(run(['-p', '/cost extra'], extra.io, costDeps)).resolves.toBe(
      0,
    )
    expect(extra.stdout.join('')).toBe('answer:/cost extra\n')
    expect(serviceCreations.at(-1)).toEqual({ requireProvider: true })

    const disabled = captureIO()
    await expect(
      run(['-p', '--disable-slash-commands', '/cost'], disabled.io, costDeps),
    ).resolves.toBe(0)
    expect(disabled.stdout.join('')).toBe('answer:/cost\n')
    expect(serviceCreations.at(-1)).toEqual({ requireProvider: true })

    expect(runCalls).toEqual(['/costs', '/cost extra', '/cost'])
    expect(resumeCalls).toEqual([])
  })

  it('rejects cost counter regression explicitly instead of clamping', async () => {
    const { dependencies: costDeps, costSnapshotCalls } = costDependencies({
      regress: true,
    })
    const capture = captureIO()
    await expect(run(['-p', '/cost'], capture.io, costDeps)).resolves.toBe(1)
    expect(capture.stdout).toEqual([])
    expect(capture.stderr.join('')).toContain('regression')
    expect(costSnapshotCalls).toHaveLength(2)
  })

  it('runs init-only lifecycle without constructing a provider turn', async () => {
    const capture = captureIO()
    const calls: string[] = []
    const base = dependencies()
    const lifecycleDependencies: CliDependencies = {
      async createService(options) {
        expect(options.requireProvider).toBe(false)
        expect(options.exposeToolRegistry).toBe(true)
        return {
          ...(await base.createService(options)),
          async lifecycle(trigger, lifecycleOptions) {
            calls.push(`${trigger}:${lifecycleOptions?.sessionStart === true}`)
          },
        }
      },
    }

    await expect(
      run(['--init-only', 'ignored'], capture.io, lifecycleDependencies),
    ).resolves.toBe(0)
    expect(calls).toEqual(['init:true'])
    expect(capture.stdout).toEqual([])
  })

  it('keeps init-only provider-free when invoked from a TTY', async () => {
    const capture = captureIO()
    capture.io.isTTY = true
    let interactiveStarted = false
    const calls: string[] = []
    const base = dependencies()
    const lifecycleDependencies: CliDependencies = {
      async createService(options) {
        expect(options.requireProvider).toBe(false)
        return {
          ...(await base.createService(options)),
          async lifecycle(trigger, lifecycleOptions) {
            calls.push(`${trigger}:${lifecycleOptions?.sessionStart === true}`)
          },
        }
      },
      async runInteractive() {
        interactiveStarted = true
        return 1
      },
    }

    await expect(
      run(['--init-only'], capture.io, lifecycleDependencies),
    ).resolves.toBe(0)
    expect(interactiveStarted).toBe(false)
    expect(calls).toEqual(['init:true'])
  })

  it('runs init or maintenance before continuing with provider execution', async () => {
    const capture = captureIO()
    const calls: string[] = []
    const base = dependencies()
    const lifecycleDependencies: CliDependencies = {
      async createService(options) {
        expect(options.requireProvider).toBe(true)
        return {
          ...(await base.createService(options)),
          async lifecycle(trigger) {
            calls.push(trigger)
          },
        }
      },
    }

    await expect(
      run(['--init', '-p', 'continue'], capture.io, lifecycleDependencies),
    ).resolves.toBe(0)
    expect(calls).toEqual(['init'])
    expect(capture.stdout).toEqual(['answer:continue', '\n'])
  })

  it('rewinds files as a provider-free standalone resume operation', async () => {
    const capture = captureIO()
    const calls: string[] = []
    const base = dependencies()
    const rewindDependencies: CliDependencies = {
      async createService(options) {
        expect(options.requireProvider).toBe(false)
        return {
          ...(await base.createService(options)),
          async rewindFiles(sessionId, messageId) {
            calls.push(`${sessionId}:${messageId}`)
          },
        }
      },
    }
    const sessionId = '11111111-1111-4111-8111-111111111111'
    const messageId = '22222222-2222-4222-8222-222222222222'

    await expect(
      run(
        ['-p', '--resume', sessionId, '--rewind-files', messageId],
        capture.io,
        rewindDependencies,
      ),
    ).resolves.toBe(0)
    expect(calls).toEqual([`${sessionId}:${messageId}`])
    expect(capture.stdout).toEqual([
      `Files rewound to state at message ${messageId}\n`,
    ])

    const invalid = captureIO()
    await expect(
      run(
        ['-p', '--resume', sessionId, '--rewind-files', messageId, 'prompt'],
        invalid.io,
        rewindDependencies,
      ),
    ).resolves.toBe(1)
    expect(invalid.stderr.join('')).toContain('standalone operation')
  })

  it('auto-approves interrupted recovery only for opted-in background workers', async () => {
    const approvals: Array<boolean | undefined> = []
    const base = dependencies()
    const createService: CliDependencies['createService'] = async (options) => {
      approvals.push(
        await options.approveRecovery?.({
          id: 'interrupted',
          name: 'Bash',
          input: { command: 'npm test' },
        }),
      )
      return base.createService(options)
    }

    await createBackgroundWorkerRuntime(
      () => undefined,
      {
        argv: ['--from-pr=42', '--retry-interrupted-tools', '--', 'continue'],
      },
      createService,
    )
    await createBackgroundWorkerRuntime(
      () => undefined,
      { argv: ['--from-pr=42', '--', 'continue'] },
      createService,
    )

    expect(approvals).toEqual([true, undefined])
  })

  it('routes install, update, and upgrade without constructing a session', async () => {
    const requested: unknown[] = []
    const cliDependencies = dependencies()
    cliDependencies.selfUpdate = async (options) => {
      requested.push(options)
      return {
        type: 'self-update',
        operation: options.operation,
        package: 'praxis-agent',
        target: options.target ?? 'latest',
        force: options.force === true,
        command: ['npm'],
        output: 'fixture complete',
      }
    }

    const installed = captureIO()
    await expect(
      run(
        ['install', '--force', '1.2.3', '--json'],
        installed.io,
        cliDependencies,
      ),
    ).resolves.toBe(0)
    expect(JSON.parse(installed.stdout.join(''))).toMatchObject({
      type: 'self-update',
      operation: 'install',
      target: '1.2.3',
      force: true,
    })

    const updated = captureIO()
    await expect(
      run(
        ['--debug', '--data-plane', 'native', 'update'],
        updated.io,
        cliDependencies,
      ),
    ).resolves.toBe(0)
    expect(updated.stdout.join('')).toContain('Praxis update completed')
    const upgraded = captureIO()
    await expect(
      run(['upgrade', '--json'], upgraded.io, cliDependencies),
    ).resolves.toBe(0)
    expect(requested).toEqual([
      { operation: 'install', force: true, target: '1.2.3' },
      { operation: 'update' },
      { operation: 'update' },
    ])
  })

  it('loads self-update channel settings from the selected data plane', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-update-plane-'))
    const praxisRoot = join(root, 'praxis')
    const claudeRoot = join(root, 'claude')
    const previousPraxisHome = process.env.PRAXIS_HOME
    const previousClaudeRoot = process.env.CLAUDE_CONFIG_DIR
    const previousDataPlane = process.env.PRAXIS_DATA_PLANE
    await mkdir(praxisRoot, { recursive: true })
    await mkdir(claudeRoot, { recursive: true })
    await writeFile(
      join(praxisRoot, 'settings.json'),
      JSON.stringify({ autoUpdatesChannel: 'stable' }),
    )
    await writeFile(
      join(claudeRoot, 'settings.json'),
      JSON.stringify({ autoUpdatesChannel: 'latest' }),
    )
    process.env.PRAXIS_HOME = praxisRoot
    process.env.CLAUDE_CONFIG_DIR = claudeRoot
    delete process.env.PRAXIS_DATA_PLANE
    try {
      const requested: unknown[] = []
      const cliDependencies = dependencies()
      cliDependencies.selfUpdate = async (options) => {
        requested.push(options)
        return {
          type: 'self-update',
          operation: options.operation,
          package: 'praxis-agent',
          target: options.target ?? 'latest',
          force: false,
          command: ['npm'],
          output: 'fixture complete',
        }
      }

      await expect(
        run(['update'], captureIO().io, cliDependencies),
      ).resolves.toBe(0)
      await expect(
        run(
          ['update', '--data-plane', 'claude'],
          captureIO().io,
          cliDependencies,
        ),
      ).resolves.toBe(0)
      expect(requested).toEqual([
        { operation: 'update', target: 'stable' },
        { operation: 'update' },
      ])
    } finally {
      if (previousPraxisHome === undefined) delete process.env.PRAXIS_HOME
      else process.env.PRAXIS_HOME = previousPraxisHome
      if (previousClaudeRoot === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeRoot
      if (previousDataPlane === undefined) delete process.env.PRAXIS_DATA_PLANE
      else process.env.PRAXIS_DATA_PLANE = previousDataPlane
      await rm(root, { recursive: true, force: true })
    }
  })

  it('validates self-update operands and exposes command help', async () => {
    const cliDependencies = dependencies()
    const invalid = captureIO()
    await expect(
      run(['install', 'latest', 'stable'], invalid.io, cliDependencies),
    ).resolves.toBe(1)
    expect(invalid.stderr.join('')).toContain(
      'install accepts at most one target',
    )

    const help = captureIO()
    await expect(
      run(['install', '--help'], help.io, cliDependencies),
    ).resolves.toBe(0)
    expect(help.stdout.join('')).toContain(
      'Usage: praxis install [options] [target]',
    )
  })

  it('selects provider-specific environment defaults', () => {
    expect(parseProviderEnvironment({})).toEqual({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
    })
    expect(
      parseProviderEnvironment({
        PRAXIS_PROVIDER: 'anthropic',
        PRAXIS_MAX_OUTPUT_TOKENS: '4096',
        PRAXIS_ANTHROPIC_VERSION: '2023-06-01',
        PRAXIS_ANTHROPIC_WEB_SEARCH: 'true',
      }),
    ).toEqual({
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      maxOutputTokens: 4096,
      anthropicVersion: '2023-06-01',
      webSearch: true,
    })
    expect(() =>
      parseProviderEnvironment({ PRAXIS_PROVIDER: 'unknown' }),
    ).toThrow('openai or anthropic')
    expect(() =>
      parseProviderEnvironment({ PRAXIS_MAX_OUTPUT_TOKENS: '4096' }),
    ).toThrow('requires PRAXIS_PROVIDER=anthropic')
    expect(() =>
      parseProviderEnvironment({
        PRAXIS_PROVIDER: 'anthropic',
        PRAXIS_ANTHROPIC_WEB_SEARCH: 'sometimes',
      }),
    ).toThrow('must be true or false')
    expect(() =>
      parseProviderEnvironment({ PRAXIS_ANTHROPIC_WEB_SEARCH: 'true' }),
    ).toThrow('requires PRAXIS_PROVIDER=anthropic')
    expect(() =>
      parseProviderEnvironment({
        PRAXIS_ANTHROPIC_PROMPT_CACHING: 'true',
      }),
    ).toThrow('requires PRAXIS_PROVIDER=anthropic')
    expect(() =>
      parseProviderEnvironment({
        PRAXIS_ANTHROPIC_PROMPT_CACHE_TTL: '1h',
      }),
    ).toThrow('requires PRAXIS_PROVIDER=anthropic')
    expect(() =>
      parseProviderEnvironment({
        PRAXIS_PROVIDER: 'anthropic',
        PRAXIS_ANTHROPIC_PROMPT_CACHING: 'sometimes',
      }),
    ).toThrow('must be true or false')
    expect(() =>
      parseProviderEnvironment({
        PRAXIS_PROVIDER: 'anthropic',
        PRAXIS_ANTHROPIC_PROMPT_CACHE_TTL: 'forever',
      }),
    ).toThrow('must be 5m or 1h')
    expect(() =>
      parseProviderEnvironment({
        PRAXIS_PROVIDER: 'anthropic',
        PRAXIS_ANTHROPIC_PROMPT_CACHING: 'false',
        PRAXIS_ANTHROPIC_PROMPT_CACHE_TTL: '1h',
      }),
    ).toThrow('cannot be set when prompt caching is false')
  })

  it('validates explicit context budget environment', () => {
    expect(
      parseContextEnvironment({
        PRAXIS_CONTEXT_WINDOW_TOKENS: '200000',
        PRAXIS_CONTEXT_RESERVE_TOKENS: '8192',
      }),
    ).toEqual({ contextWindowTokens: 200_000, contextReserveTokens: 8192 })
    expect(() =>
      parseContextEnvironment({ PRAXIS_CONTEXT_WINDOW_TOKENS: 'unknown' }),
    ).toThrow('positive integer')
    expect(() =>
      parseContextEnvironment({ PRAXIS_CONTEXT_RESERVE_TOKENS: '8192' }),
    ).toThrow('requires PRAXIS_CONTEXT_WINDOW_TOKENS')
  })

  it('prints help and version without creating runtime dependencies', async () => {
    const capture = captureIO()
    const unavailable: CliDependencies = {
      async createService() {
        throw new Error('must not run')
      },
    }

    await expect(run([], capture.io, unavailable)).resolves.toBe(0)
    await expect(run(['--version'], capture.io, unavailable)).resolves.toBe(0)
    expect(capture.stdout.join('')).toContain('Praxis')
    expect(capture.stdout.join('')).toContain('--prefill <text>')
    expect(capture.stdout.join('')).toContain('--thinking <mode>')
    expect(capture.stdout.join('')).toContain('--max-thinking-tokens <tokens>')
    expect(capture.stdout.join('')).toContain('-d, --debug [filter]')
    expect(capture.stdout.join('')).toContain('--prompt-suggestions [value]')
    expect(capture.stdout.join('')).toContain('--autocompact <auto|tokens>')
    expect(capture.stdout.join('')).toContain(
      '--cloud [description|session_id|url]',
    )
    expect(capture.stdout.join('')).toContain('--environment <environment_id>')
    expect(capture.stdout.join('')).toContain('--forward-subagent-text')
    expect(capture.stdout.join('')).toContain('--teleport [session]')
    expect(capture.stdout.join('')).toContain(
      'PRAXIS_ANTHROPIC_PROMPT_CACHING=true|false',
    )
    expect(capture.stdout.join('')).toContain(
      'PRAXIS_ANTHROPIC_PROMPT_CACHE_TTL=5m|1h',
    )
    expect(capture.stdout).toContain(`${PACKAGE_VERSION}\n`)
    expect(capture.stderr).toEqual([])
  })

  it('serves --version from the facade fast path and delegates other argv to supplied dependencies', async () => {
    const versionCapture = captureIO()
    let versionServiceCreations = 0
    const counting: CliDependencies = {
      async createService() {
        versionServiceCreations += 1
        throw new Error('--version must not construct a service')
      },
    }

    await expect(run(['--version'], versionCapture.io, counting)).resolves.toBe(
      0,
    )
    expect(versionCapture.stdout).toEqual([`${PACKAGE_VERSION}\n`])
    expect(versionCapture.stderr).toEqual([])
    expect(versionServiceCreations).toBe(0)

    const delegatedCapture = captureIO()
    const base = dependencies()
    let delegatedServiceCreations = 0
    const delegated: CliDependencies = {
      async createService(options) {
        delegatedServiceCreations += 1
        return base.createService(options)
      },
    }
    await expect(
      run(['run', 'hello'], delegatedCapture.io, delegated),
    ).resolves.toBe(0)
    expect(delegatedCapture.stdout.join('')).toBe('answer:hello\n')
    expect(delegatedServiceCreations).toBe(1)
  })

  it('prefers top-level help over the version fast path when both flags are present', async () => {
    const capture = captureIO()
    let serviceCreations = 0
    const unavailable: CliDependencies = {
      async createService() {
        serviceCreations += 1
        throw new Error('--help --version must not construct a service')
      },
    }

    await expect(
      run(['--help', '--version'], capture.io, unavailable),
    ).resolves.toBe(0)
    expect(capture.stdout.join('')).toContain('Praxis')
    expect(capture.stdout.join('')).toContain('--prefill <text>')
    expect(capture.stdout.join('')).toContain('--thinking <mode>')
    expect(capture.stdout).not.toEqual([`${PACKAGE_VERSION}\n`])
    expect(capture.stderr).toEqual([])
    expect(serviceCreations).toBe(0)

    const shortHelpCapture = captureIO()
    await expect(
      run(['-h', '-v'], shortHelpCapture.io, unavailable),
    ).resolves.toBe(0)
    expect(shortHelpCapture.stdout.join('')).toContain('--prefill <text>')
    expect(shortHelpCapture.stdout).not.toEqual([`${PACKAGE_VERSION}\n`])
    expect(shortHelpCapture.stderr).toEqual([])
    expect(serviceCreations).toBe(0)
  })

  it('routes command-specific help without constructing services or providers', async () => {
    let constructions = 0
    const unavailable: CliDependencies = {
      async createService() {
        constructions += 1
        throw new Error('service must not be created for help')
      },
      async createAutoModeCritic() {
        constructions += 1
        throw new Error('provider must not be created for help')
      },
    }
    const routes: Array<[string[], string]> = [
      [['agents', '--help'], 'Usage: praxis agents'],
      [['mcp', '--help'], 'Usage: praxis mcp'],
      [['mcp', 'list', '--help'], 'Usage: praxis mcp list'],
      [['mcp', 'get', '--help'], 'Usage: praxis mcp get'],
      [['mcp', '--scope', 'local', 'add', '--help'], 'Usage: praxis mcp add'],
      [
        ['mcp', '--transport', 'http', 'add', '--help'],
        'Usage: praxis mcp add',
      ],
      [['mcp', 'help', 'add'], 'Usage: praxis mcp add'],
      [['mcp', 'add-json', '--help'], 'Usage: praxis mcp add-json'],
      [['mcp', 'remove', '--help'], 'Usage: praxis mcp remove'],
      [
        ['mcp', 'reset-project-choices', '--help'],
        'Usage: praxis mcp reset-project-choices',
      ],
      [['mcp', 'login', '--help'], 'Usage: praxis mcp login'],
      [['mcp', 'logout', '--help'], 'Usage: praxis mcp logout'],
      [['mcp', 'serve', '--help'], 'Usage: praxis mcp serve'],
      [['plugin', '--help'], 'Usage: praxis plugin'],
      [['plugins', '--help'], 'Usage: praxis plugin|plugins'],
      [['plugin', 'list', '--help'], 'Usage: praxis plugin list'],
      [['plugin', 'details', '--help'], 'Usage: praxis plugin details'],
      [['plugin', 'help', 'details'], 'Usage: praxis plugin details'],
      [['plugin', 'help', 'install'], 'Usage: praxis plugin install'],
      [['plugins', 'help', 'list'], 'Usage: praxis plugin list'],
      [['plugin', 'install', '--help'], 'Usage: praxis plugin install'],
      [['plugin', 'i', '--help'], 'Usage: praxis plugin install'],
      [['plugin', 'uninstall', '--help'], 'Usage: praxis plugin uninstall'],
      [['plugin', 'remove', '--help'], 'Usage: praxis plugin uninstall'],
      [['plugin', 'enable', '--help'], 'Usage: praxis plugin enable'],
      [['plugin', 'disable', '--help'], 'Usage: praxis plugin disable'],
      [['plugin', 'update', '--help'], 'Usage: praxis plugin update'],
      [['plugin', 'init', '--help'], 'Usage: praxis plugin init'],
      [['plugin', 'new', '--help'], 'Usage: praxis plugin init'],
      [['plugin', 'prune', '--help'], 'Usage: praxis plugin prune'],
      [['plugin', 'autoremove', '--help'], 'Usage: praxis plugin prune'],
      [['plugin', 'tag', '--help'], 'Usage: praxis plugin tag'],
      [['plugin', 'validate', '--help'], 'Usage: praxis plugin validate'],
      [['plugin', 'marketplace', '--help'], 'Usage: praxis plugin marketplace'],
      [
        ['plugin', 'marketplace', 'list', '--help'],
        'Usage: praxis plugin marketplace list',
      ],
      [
        ['plugin', 'marketplace', 'add', '--help'],
        'Usage: praxis plugin marketplace add',
      ],
      [
        ['plugin', 'marketplace', 'help', 'add'],
        'Usage: praxis plugin marketplace add',
      ],
      [
        ['plugin', 'marketplace', 'remove', '--help'],
        'Usage: praxis plugin marketplace remove',
      ],
      [
        ['plugin', 'marketplace', 'rm', '--help'],
        'Usage: praxis plugin marketplace remove',
      ],
      [
        ['plugin', 'marketplace', 'update', '--help'],
        'Usage: praxis plugin marketplace update',
      ],
      [['auto-mode', '--help'], 'Usage: praxis auto-mode'],
      [['auto-mode', 'config', '--help'], 'Usage: praxis auto-mode config'],
      [['auto-mode', 'defaults', '--help'], 'Usage: praxis auto-mode defaults'],
      [
        ['auto-mode', 'critique', '--model', 'fixture', '--help'],
        'Usage: praxis auto-mode critique',
      ],
      [['auto-mode', 'help', 'critique'], 'Usage: praxis auto-mode critique'],
      [['auto-mode', 'reset', '--help'], 'Usage: praxis auto-mode reset'],
      [['auto-mode', 'help', 'reset'], 'Usage: praxis auto-mode reset'],
      [['project', '--help'], 'Usage: praxis project'],
      [['project', 'purge', '--help'], 'Usage: praxis project purge'],
      [['project', 'help', 'purge'], 'Usage: praxis project purge'],
      [['import', '--help'], 'Usage: praxis import'],
    ]

    for (const [argv, usage] of routes) {
      const capture = captureIO()
      await expect(run(argv, capture.io, unavailable)).resolves.toBe(0)
      expect(capture.stdout.join('')).toContain(usage)
      expect(capture.stderr).toEqual([])
    }
    const detailedRoutes: Array<[string[], string]> = [
      [['agents', '--help'], '--cwd <path>'],
      [['mcp', 'help', 'add'], '--transport <transport>'],
      [['mcp', 'login', '--help'], '--no-browser'],
      [['plugin', 'help', 'install'], 'plugin@marketplace'],
      [['plugin', 'marketplace', 'help', 'add'], '--sparse <paths...>'],
      [['plugin', 'disable', '--help'], '-a, --all'],
      [['mcp', 'add-json', '--help'], '--client-secret'],
      [['auto-mode', 'defaults', '--help'], '--label <prefix>'],
      [['auto-mode', 'help', 'critique'], 'default: PRAXIS_MODEL'],
      [['auto-mode', 'reset', '--help'], '-y, --yes'],
      [['project', 'purge', '--help'], '--json'],
      [['import', '--help'], '--dry-run'],
    ]
    for (const [argv, detail] of detailedRoutes) {
      const capture = captureIO()
      await expect(run(argv, capture.io, unavailable)).resolves.toBe(0)
      expect(capture.stdout.join('')).toContain('Options:')
      expect(capture.stdout.join('')).toContain(detail)
    }
    expect(constructions).toBe(0)
  })

  it('rejects import without constructing providers or changing files', async () => {
    const capture = captureIO()
    let constructions = 0
    const unavailable: CliDependencies = {
      async createService() {
        constructions += 1
        throw new Error('import must not construct a service')
      },
    }

    await expect(
      run(['import', 'codex', '--dry-run'], capture.io, unavailable),
    ).resolves.toBe(1)
    expect(capture.stderr.join('')).toContain(
      'Praxis import does not yet support Codex or Gemini configuration',
    )
    expect(constructions).toBe(0)
  })

  it('dispatches migrate as a known command from a TTY', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-migrate-cli-'))
    const source = join(root, 'claude')
    const destination = join(root, 'praxis')
    const previousClaudeRoot = process.env.CLAUDE_CONFIG_DIR
    const previousPraxisRoot = process.env.PRAXIS_HOME
    await mkdir(join(source, 'projects', 'project'), { recursive: true })
    await writeFile(join(source, 'projects', 'project', 'session.jsonl'), '{}')
    process.env.CLAUDE_CONFIG_DIR = source
    process.env.PRAXIS_HOME = destination
    try {
      const capture = captureIO()
      capture.io.isTTY = true
      let interactiveCalls = 0
      const unavailable: CliDependencies = {
        async createService() {
          throw new Error('migrate must not construct a service')
        },
        async runInteractive() {
          interactiveCalls += 1
          return 0
        },
      }

      await expect(
        run(['migrate', 'from-claude'], capture.io, unavailable),
      ).resolves.toBe(0)
      await expect(
        readFile(
          join(destination, 'sessions', 'project', 'session.jsonl'),
          'utf8',
        ),
      ).resolves.toBe('{}')
      expect(interactiveCalls).toBe(0)
    } finally {
      if (previousClaudeRoot === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeRoot
      if (previousPraxisRoot === undefined) delete process.env.PRAXIS_HOME
      else process.env.PRAXIS_HOME = previousPraxisRoot
      await rm(root, { recursive: true, force: true })
    }
  })

  it('routes plugins alias through existing plugin commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-plugins-alias-'))
    const configRoot = join(root, 'config')
    const previousConfigRoot = process.env.PRAXIS_HOME
    await mkdir(configRoot, { recursive: true })
    await writeFile(
      join(configRoot, 'settings.json'),
      JSON.stringify({
        autoMode: {
          allow: [],
          soft_deny: [],
          hard_deny: [],
          environment: [],
        },
      }),
    )
    process.env.PRAXIS_HOME = configRoot
    try {
      const capture = captureIO()
      const unavailable: CliDependencies = {
        async createService() {
          throw new Error('service must not be created for plugins alias')
        },
      }
      await expect(
        run(['plugins', 'list'], capture.io, unavailable),
      ).resolves.toBe(0)
      expect(JSON.parse(capture.stdout.join(''))).toEqual([])
      expect(capture.stderr).toEqual([])
    } finally {
      if (previousConfigRoot === undefined) delete process.env.PRAXIS_HOME
      else process.env.PRAXIS_HOME = previousConfigRoot
      await rm(root, { recursive: true, force: true })
    }
  })

  it('guides critique users without custom rules before constructing a provider', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-auto-mode-cli-'))
    const configRoot = join(root, 'config')
    const previousConfigRoot = process.env.CLAUDE_CONFIG_DIR
    await mkdir(configRoot, { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = configRoot
    try {
      let criticCalls = 0
      const capture = captureIO()
      const unavailable: CliDependencies = {
        async createService() {
          throw new Error('service must not be created for critique')
        },
        async createAutoModeCritic() {
          criticCalls += 1
          throw new Error('provider must not be created without custom rules')
        },
      }

      await expect(
        run(['auto-mode', 'critique'], capture.io, unavailable),
      ).resolves.toBe(0)
      expect(capture.stdout.join('')).toContain(
        'No custom auto mode rules found.',
      )
      expect(capture.stdout.join('')).toContain('praxis auto-mode defaults')
      expect(capture.stderr).toEqual([])
      expect(criticCalls).toBe(0)
    } finally {
      if (previousConfigRoot === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfigRoot
      await rm(root, { recursive: true, force: true })
    }
  })

  it('filters default auto-mode rules by case-insensitive label prefix', async () => {
    const capture = captureIO()
    const unavailable: CliDependencies = {
      async createService() {
        throw new Error('service must not be created for defaults')
      },
    }

    await expect(
      run(
        ['auto-mode', 'defaults', '--label', 'read-ONLY'],
        capture.io,
        unavailable,
      ),
    ).resolves.toBe(0)
    expect(JSON.parse(capture.stdout.join(''))).toEqual({
      allow: ['Read-only project inspection and local development operations'],
      soft_deny: [],
      hard_deny: [],
      environment: [],
      classifyAllShell: false,
    })

    const invalid = captureIO()
    await expect(
      run(['auto-mode', 'config', '--label', 'read'], invalid.io, unavailable),
    ).resolves.toBe(1)
    expect(invalid.stderr.join('')).toContain(
      '--label is only valid with auto-mode defaults',
    )
  })

  it('streams provider-backed auto-mode critiques and propagates --model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-auto-mode-cli-'))
    const configRoot = join(root, 'config')
    const previousConfigRoot = process.env.CLAUDE_CONFIG_DIR
    await mkdir(configRoot, { recursive: true })
    await writeFile(
      join(configRoot, 'settings.json'),
      JSON.stringify({
        autoMode: {
          allow: ['Use npm test for local validation'],
          soft_deny: ['Push commits to remotes'],
          hard_deny: ['Read or expose credentials'],
          environment: ['Fixture repository only'],
        },
      }),
    )
    process.env.CLAUDE_CONFIG_DIR = configRoot
    try {
      const models: Array<string | undefined> = []
      const requests: Parameters<ModelProvider['complete']>[0][] = []
      const critic: ModelProvider = {
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete(request) {
          requests.push(request)
          yield { type: 'text-delta', delta: '## Fixture critique\n' }
          yield { type: 'text-delta', delta: 'Clarify remote-push approval.' }
        },
      }
      const capture = captureIO()
      const dependencies: CliDependencies = {
        async createService() {
          throw new Error('service must not be created for critique')
        },
        async createAutoModeCritic({ model }) {
          models.push(model)
          return critic
        },
      }

      await expect(
        run(
          [
            'auto-mode',
            'critique',
            '--model',
            'fixture-haiku',
            '--data-plane',
            'claude',
          ],
          capture.io,
          dependencies,
        ),
      ).resolves.toBe(0)
      expect(models).toEqual(['fixture-haiku'])
      expect(requests).toHaveLength(1)
      expect(requests[0]?.thinking).toEqual({ mode: 'disabled' })
      expect(JSON.stringify(requests[0])).toContain('Praxis auto-mode critique')
      expect(JSON.stringify(requests[0])).toContain('Fixture repository only')
      expect(capture.stdout.join('')).toContain(
        'Analyzing your auto mode rules…',
      )
      expect(capture.stdout.join('')).toContain('## Fixture critique')
      expect(capture.stdout.join('')).toContain('Clarify remote-push approval.')
      expect(capture.stderr).toEqual([])
    } finally {
      if (previousConfigRoot === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfigRoot
      await rm(root, { recursive: true, force: true })
    }
  })

  it('starts the interactive UI only for an empty TTY invocation', async () => {
    const capture = captureIO()
    capture.io.isTTY = true
    let started = false
    const interactive: CliDependencies = {
      ...dependencies(),
      async runInteractive() {
        started = true
        return 0
      },
    }

    await expect(run([], capture.io, interactive)).resolves.toBe(0)

    expect(started).toBe(true)
    expect(capture.stdout).toEqual([])
  })

  it('forwards option-only TTY invocations to the interactive runtime', async () => {
    const capture = captureIO()
    capture.io.isTTY = true
    let controls:
      Parameters<NonNullable<CliDependencies['runInteractive']>>[0] | undefined
    const interactive: CliDependencies = {
      ...dependencies(),
      async runInteractive(options) {
        controls = options
        return 0
      },
    }

    await expect(
      run(
        [
          '--permission-mode',
          'manual',
          '--agent',
          'reviewer',
          '--exclude-dynamic-system-prompt-sections',
        ],
        capture.io,
        interactive,
      ),
    ).resolves.toBe(0)

    expect(controls).toMatchObject({
      agent: 'reviewer',
      controls: {
        permissionMode: 'manual',
        excludeDynamicSystemPromptSections: true,
      },
    })

    await expect(
      run(
        [
          '--from-pr',
          '--fork-session',
          '--session-id',
          '33333333-3333-4333-8333-333333333333',
          '--retry-interrupted-tools',
        ],
        capture.io,
        interactive,
      ),
    ).resolves.toBe(0)
    expect(controls).toMatchObject({
      resume: {
        fromPr: true,
        forkSession: true,
        forkSessionId: '33333333-3333-4333-8333-333333333333',
        retryInterruptedTools: true,
      },
      controls: { fromPr: true },
    })

    await expect(
      run(
        [
          '--resume',
          '11111111-1111-4111-8111-111111111111',
          '--resume-session-at',
          'user-message-uuid',
        ],
        capture.io,
        interactive,
      ),
    ).resolves.toBe(0)
    expect(controls).toMatchObject({
      resume: {
        sessionId: '11111111-1111-4111-8111-111111111111',
        sessionSelector: '11111111-1111-4111-8111-111111111111',
        requireSession: true,
      },
      controls: { resumeSessionAt: 'user-message-uuid' },
    })

    await expect(run(['--resume'], capture.io, interactive)).resolves.toBe(0)
    expect(controls).toMatchObject({
      resume: { requireSession: true },
      controls: { resumeSelector: true },
    })
  })

  it('starts interactive TTY prompts with the positional prompt exactly once', async () => {
    const capture = captureIO()
    capture.io.isTTY = true
    const starts: Parameters<
      NonNullable<CliDependencies['runInteractive']>
    >[0][] = []
    const interactive: CliDependencies = {
      ...dependencies(),
      async runInteractive(options) {
        starts.push(options)
        return 0
      },
    }

    await expect(
      run(['review', 'this', 'change'], capture.io, interactive),
    ).resolves.toBe(0)
    await expect(
      run(
        ['--resume=11111111-1111-4111-8111-111111111111', 'continue', 'review'],
        capture.io,
        interactive,
      ),
    ).resolves.toBe(0)

    expect(starts).toHaveLength(2)
    expect(starts[0]).toMatchObject({ initialPrompt: 'review this change' })
    expect(starts[1]).toMatchObject({
      initialPrompt: 'continue review',
      resume: {
        sessionId: '11111111-1111-4111-8111-111111111111',
      },
    })
  })

  it('keeps management commands out of positional TTY prompt routing', async () => {
    let interactiveStarts = 0
    const cliDependencies: CliDependencies = {
      ...dependencies(),
      async runInteractive() {
        interactiveStarts += 1
        return 0
      },
      async selfUpdate(options) {
        return {
          type: 'self-update',
          operation: options.operation,
          package: 'praxis-agent',
          target: options.target ?? 'latest',
          force: false,
          command: ['npm'],
          output: 'fixture complete',
        }
      },
    }
    for (const command of ['install', 'update', 'upgrade']) {
      const capture = captureIO()
      capture.io.isTTY = true
      await expect(
        run([command, '--json'], capture.io, cliDependencies),
      ).resolves.toBe(0)
    }
    const project = captureIO()
    project.io.isTTY = true
    await expect(
      run(['project', 'unknown'], project.io, cliDependencies),
    ).resolves.toBe(0)
    expect(interactiveStarts).toBe(0)
  })

  it('keeps printed TTY prompts headless', async () => {
    const capture = captureIO()
    capture.io.isTTY = true
    let interactiveStarts = 0
    const headless: CliDependencies = {
      ...dependencies(),
      async runInteractive() {
        interactiveStarts += 1
        return 0
      },
    }

    await expect(
      run(['--print', 'headless prompt'], capture.io, headless),
    ).resolves.toBe(0)

    expect(interactiveStarts).toBe(0)
  })

  it('launches tmux worktree sessions before creating a provider', async () => {
    const capture = captureIO()
    let launched:
      Parameters<NonNullable<CliDependencies['launchTmux']>>[0] | undefined
    const isolated: CliDependencies = {
      async createService() {
        throw new Error('provider must not be created')
      },
      async launchTmux(options) {
        launched = options
        return {
          kind: 'tmux',
          sessionName: 'praxis-review',
          worktreeName: 'review',
        }
      },
    }
    await expect(
      run(
        ['--worktree=review', '--tmux', '--', 'inspect'],
        capture.io,
        isolated,
      ),
    ).resolves.toBe(0)
    expect(launched).toMatchObject({
      worktreeName: 'review',
      mode: 'native',
      attach: false,
    })
    expect(capture.stdout).toEqual(['Started tmux session praxis-review\n'])
  })

  it('runs a prompt in plain output mode', async () => {
    const capture = captureIO()

    await expect(
      run(['run', 'hello', 'world'], capture.io, dependencies()),
    ).resolves.toBe(0)
    expect(capture.stdout.join('')).toBe('answer:hello world\n')
  })

  it('prints only the recovered attempt in append-only text output', async () => {
    const capture = captureIO()
    const base = dependencies()
    const recovered: CliDependencies = {
      async createService(options) {
        const service = await base.createService(options)
        const { eventSink } = options
        return {
          ...service,
          async run() {
            eventSink({ type: 'state', state: 'awaiting-model' })
            eventSink({ type: 'text-delta', delta: 'discarded partial' })
            eventSink({ type: 'terminal', reason: 'prompt_too_long' })
            eventSink({
              type: 'model-attempt-discarded',
              reason: 'prompt_too_long',
            })
            eventSink({ type: 'state', state: 'compacting' })
            eventSink({ type: 'state', state: 'awaiting-model' })
            eventSink({ type: 'text-delta', delta: 'recovered answer' })
            eventSink({ type: 'terminal', reason: 'end_turn' })
            eventSink({ type: 'state', state: 'completed' })
            return {
              sessionId: '11111111-1111-4111-8111-111111111111',
              text: 'recovered answer',
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
        }
      },
    }

    await expect(run(['run', 'recover'], capture.io, recovered)).resolves.toBe(
      0,
    )
    expect(capture.stdout.join('')).toBe('recovered answer\n')
  })

  it('accepts prefill without changing prompt or runtime output', async () => {
    const capture = captureIO()
    const base = dependencies()
    let prefill: string | undefined
    const compatible: CliDependencies = {
      async createService(options) {
        prefill = options.controls?.prefill
        return base.createService(options)
      },
    }

    await expect(
      run(['--prefill', 'ignored-prefix', 'hello'], capture.io, compatible),
    ).resolves.toBe(0)
    expect(prefill).toBe('ignored-prefix')
    expect(capture.stdout.join('')).toBe('answer:hello\n')
  })

  it('launches and controls top-level background agents without creating a provider', async () => {
    const calls: string[] = []
    const managed: CliDependencies = {
      async createService() {
        throw new Error('provider must not be created')
      },
      topLevelAgents: {
        async launch(options) {
          calls.push(`launch:${options.prompt}:${options.argv.join('|')}`)
          return {
            id: 'abcd1234',
            sessionId: 'abcd1234-1111-4111-8111-111111111111',
          }
        },
        async list(options) {
          calls.push(`list:${options.all}:${options.cwd ?? ''}`)
          return [
            {
              pid: 42,
              id: 'abcd1234',
              cwd: '/workspace',
              kind: 'background',
              startedAt: 1,
              sessionId: 'abcd1234-1111-4111-8111-111111111111',
              name: 'finish task',
              status: 'idle',
              state: 'working',
            },
          ]
        },
        async logs(id) {
          calls.push(`logs:${id}`)
          return 'RESULT\n'
        },
        async stop(id) {
          calls.push(`stop:${id}`)
        },
        async attach(id, input, output) {
          calls.push(`attach:${id}`)
          for await (const chunk of input) output(String(chunk))
        },
      },
    }
    const launched = captureIO()
    await expect(
      run(
        [
          '--bg',
          '--bare',
          '--exclude-dynamic-system-prompt-sections',
          '--prefill',
          'ignored-prefix',
          '--permission-prompt-tool',
          'mcp__permission__approve',
          '--session-id',
          '11111111-1111-4111-8111-111111111111',
          'finish task',
        ],
        launched.io,
        managed,
      ),
    ).resolves.toBe(0)
    expect(launched.stdout.join('')).toContain('backgrounded · abcd1234')
    expect(launched.stderr).toEqual([
      'warning: --bg manages the session id; ignoring --session-id (use --resume <id> to continue an existing session)\n',
    ])
    expect(calls[0]).toBe(
      'launch:finish task:--bare|--exclude-dynamic-system-prompt-sections|--prefill|ignored-prefix|--permission-prompt-tool|mcp__permission__approve|finish task',
    )

    const listed = captureIO()
    await expect(
      run(
        ['agents', '--json', '--all', '--cwd', '/workspace'],
        listed.io,
        managed,
      ),
    ).resolves.toBe(0)
    expect(JSON.parse(listed.stdout.join(''))).toEqual([
      expect.objectContaining({ id: 'abcd1234', status: 'idle' }),
    ])

    const logs = captureIO()
    await expect(run(['logs', 'abcd1234'], logs.io, managed)).resolves.toBe(0)
    expect(logs.stdout.join('')).toBe('RESULT\n')

    const stopped = captureIO()
    await expect(run(['stop', 'abcd1234'], stopped.io, managed)).resolves.toBe(
      0,
    )
    expect(stopped.stdout.join('')).toBe('stopped abcd1234\n')

    const attached = captureStreamIO('continue\n')
    await expect(
      run(['attach', 'abcd1234'], attached.io, managed),
    ).resolves.toBe(0)
    expect(attached.stdout.join('')).toBe('continue\n')
    expect(calls).toContain('attach:abcd1234')
  })

  it('selects top-level agent storage from the invocation over the environment', async () => {
    const selected: DataPlane[] = []
    const previousDataPlane = process.env.PRAXIS_DATA_PLANE
    process.env.PRAXIS_DATA_PLANE = 'native'
    const managed: CliDependencies = {
      async createService() {
        throw new Error('provider must not be created')
      },
      createTopLevelAgents(dataPlane) {
        selected.push(dataPlane)
        return {
          async launch() {
            return {
              id: 'abcd1234',
              sessionId: 'abcd1234-1111-4111-8111-111111111111',
            }
          },
          async list() {
            return []
          },
          async logs() {
            return ''
          },
          async stop() {},
          async attach() {},
        }
      },
    }

    try {
      await expect(
        run(
          ['agents', '--json', '--data-plane', 'claude'],
          captureIO().io,
          managed,
        ),
      ).resolves.toBe(0)
      await expect(
        run(
          ['--data-plane', 'claude', '--bg', 'finish task'],
          captureIO().io,
          managed,
        ),
      ).resolves.toBe(0)
      expect(selected).toEqual(['claude', 'claude'])
    } finally {
      if (previousDataPlane === undefined) delete process.env.PRAXIS_DATA_PLANE
      else process.env.PRAXIS_DATA_PLANE = previousDataPlane
    }
  })

  it('requires a TTY for the agents dashboard unless JSON was requested', async () => {
    const capture = captureIO()

    await expect(run(['agents'], capture.io, dependencies())).resolves.toBe(1)
    expect(capture.stderr.join('')).toBe(
      "'praxis agents' requires an interactive terminal (stdout is not a TTY) — use 'praxis agents --json' for a machine-readable listing.\n",
    )
  })

  it('rejects operands and unsupported options for agents', async () => {
    for (const argv of [
      ['agents', 'unexpected'],
      ['agents', '--thinking', 'adaptive'],
    ]) {
      const capture = captureIO()
      await expect(run(argv, capture.io, dependencies())).resolves.toBe(1)
      expect(capture.stderr.join('')).toMatch(/not valid|Unexpected operand/u)
    }
  })

  it('passes agents dashboard defaults into new background workers', async () => {
    const capture = captureIO()
    capture.io.isTTY = true
    let dashboard:
      | Parameters<NonNullable<CliDependencies['runAgentsDashboard']>>[0]
      | undefined
    const manager: NonNullable<CliDependencies['topLevelAgents']> = {
      async launch() {
        throw new Error('unused')
      },
      async list() {
        return []
      },
      async logs() {
        throw new Error('unused')
      },
      async stop() {
        throw new Error('unused')
      },
      async attach() {
        throw new Error('unused')
      },
    }
    const managed: CliDependencies = {
      async createService() {
        throw new Error('provider must not be created')
      },
      topLevelAgents: manager,
      async runAgentsDashboard(options) {
        dashboard = options
        return 0
      },
    }

    await expect(
      run(
        [
          'agents',
          '--model',
          'fixture-model',
          '--effort',
          'xhigh',
          '--permission-mode',
          'plan',
          '--dangerously-skip-permissions',
          '--allow-dangerously-skip-permissions',
          '--agent',
          'reviewer',
          '--add-dir',
          '/workspace/one',
          '--add-dir',
          '/workspace/two',
          '--mcp-config',
          '{"mcpServers":{}}',
          '--mcp-config',
          'config.json',
          '--strict-mcp-config',
          '--settings',
          '{}',
          '--setting-sources',
          'user,project',
          '--plugin-dir',
          '/plugins/one',
          '--plugin-dir',
          '/plugins/two',
          '--cwd',
          '/workspace',
        ],
        capture.io,
        managed,
      ),
    ).resolves.toBe(0)

    expect(dashboard).toMatchObject({
      manager,
      defaults: {
        cwd: '/workspace',
        argv: [
          '--model',
          'fixture-model',
          '--effort',
          'xhigh',
          '--permission-mode',
          'plan',
          '--dangerously-skip-permissions',
          '--allow-dangerously-skip-permissions',
          '--agent',
          'reviewer',
          '--add-dir',
          '/workspace/one',
          '--add-dir',
          '/workspace/two',
          '--mcp-config',
          '{"mcpServers":{}}',
          '--mcp-config',
          'config.json',
          '--strict-mcp-config',
          '--settings',
          '{}',
          '--setting-sources',
          'user,project',
          '--plugin-dir',
          '/plugins/one',
          '--plugin-dir',
          '/plugins/two',
        ],
      },
    })
    expect(capture.stdout).toEqual([])

    if (!dashboard) throw new Error('agents dashboard did not start')
    let worker: Parameters<CliDependencies['createService']>[0] | undefined
    const workerBase = dependencies()
    await createBackgroundWorkerRuntime(
      () => undefined,
      { argv: [...dashboard.defaults.argv, '--', 'background task'] },
      async (options) => {
        worker = options
        return workerBase.createService(options)
      },
    )
    expect(worker).toMatchObject({
      agent: 'reviewer',
      sessionKind: 'bg',
      controls: {
        model: 'fixture-model',
        effort: 'xhigh',
        permissionMode: 'plan',
        dangerouslySkipPermissions: true,
        allowDangerouslySkipPermissions: true,
        addDirectories: ['/workspace/one', '/workspace/two'],
        mcpConfigs: ['{"mcpServers":{}}', 'config.json'],
        strictMcpConfig: true,
        settings: '{}',
        settingSources: ['user', 'project'],
        pluginDirectories: ['/plugins/one', '/plugins/two'],
      },
    })
  })

  it('rejects print-mode background sessions with Claude-compatible guidance', async () => {
    const capture = captureIO()
    await expect(
      run(['--bg', '--print', 'finish task'], capture.io, dependencies()),
    ).resolves.toBe(1)
    expect(capture.stderr.join('')).toContain('--bg and --print conflict')
  })

  it('resolves runtime model precedence as --model > PRAXIS_MODEL > settings > default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-model-precedence-'))
    const configRoot = join(root, 'config')
    await mkdir(configRoot, { recursive: true })
    await writeFile(
      join(configRoot, 'settings.json'),
      JSON.stringify({ model: 'settings-model' }),
    )
    await writeFile(join(configRoot, '.claude.json'), JSON.stringify({}))
    try {
      const settings = projectRuntimeSettings({
        settings: { model: 'settings-model' },
        state: {},
      })
      const defaults = projectRuntimeSettings({ settings: {}, state: {} })

      // The shared resolution path covers all four precedence levels.
      expect(resolveRuntimeModel(undefined, {}, defaults)).toBeUndefined()
      expect(resolveRuntimeModel(undefined, {}, settings)).toBe(
        'settings-model',
      )
      expect(
        resolveRuntimeModel(undefined, { PRAXIS_MODEL: 'env-model' }, settings),
      ).toBe('env-model')
      expect(
        resolveRuntimeModel(
          'cli-model',
          { PRAXIS_MODEL: 'env-model' },
          settings,
        ),
      ).toBe('cli-model')
      expect(
        resolveRuntimeModel(undefined, { PRAXIS_MODEL: '' }, settings),
      ).toBe('settings-model')

      // Provider construction and status display report the same resolved
      // model for every source that can supply one.
      const baseEnvironment = {
        CLAUDE_CONFIG_DIR: configRoot,
        PRAXIS_API_KEY: 'test-key',
        PRAXIS_PROVIDER: 'anthropic',
      }
      const createService = async (
        environment: Record<string, string>,
        controls: CliControls = DEFAULT_CLI_CONTROLS,
      ) => {
        const service = await createDefaultDependencies().createService({
          eventSink: () => undefined,
          requireProvider: true,
          cwd: root,
          configRoot,
          providerEnvironment: { ...baseEnvironment, ...environment },
          controls,
        })
        return service
      }

      const settingsOnly = await createService({})
      try {
        expect(settingsOnly.runtimeInfo?.().model).toBe('settings-model')
      } finally {
        await settingsOnly.close?.()
      }

      const envWins = await createService({ PRAXIS_MODEL: 'env-model' })
      try {
        expect(envWins.runtimeInfo?.().model).toBe('env-model')
      } finally {
        await envWins.close?.()
      }

      const cliWins = await createService(
        { PRAXIS_MODEL: 'env-model' },
        { ...DEFAULT_CLI_CONTROLS, model: 'cli-model' },
      )
      try {
        expect(cliWins.runtimeInfo?.().model).toBe('cli-model')
      } finally {
        await cliWins.close?.()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('builds distinct default providers for Session memory isolation', () => {
    const selectedModels: string[] = []
    const selectProvider = (model: string): ModelProvider => {
      selectedModels.push(model)
      return {
        model,
        capabilities: { streaming: true, usage: true, tools: false },
        async *complete() {
          yield { type: 'text-delta', delta: 'unused' }
        },
      }
    }
    const factory = createSessionMemoryProviderFactory(
      selectProvider,
      'fixture-model',
    )

    expect(factory).toBeDefined()
    const first = factory?.()
    const second = factory?.()
    expect(first).not.toBe(second)
    expect(selectedModels).toEqual(['fixture-model', 'fixture-model'])
    expect(
      createSessionMemoryProviderFactory(undefined, 'fixture-model'),
    ).toBeUndefined()
  })

  it('uses native interactive settings state by default and preserves Claude state in compat mode', () => {
    expect(
      resolveInteractiveRuntimeSettingsLocation('native', {
        PRAXIS_HOME: '/tmp/praxis-home',
        CLAUDE_CONFIG_DIR: '/tmp/claude-config',
      }),
    ).toEqual({
      configRoot: '/tmp/praxis-home',
      statePath: '/tmp/praxis-home/state.json',
    })
    expect(
      resolveInteractiveRuntimeSettingsLocation('claude', {
        PRAXIS_HOME: '/tmp/praxis-home',
        CLAUDE_CONFIG_DIR: '/tmp/claude-config',
      }),
    ).toEqual({
      configRoot: '/tmp/claude-config',
      statePath: '/tmp/claude-config/.claude.json',
    })
    expect(resolveUnknownCostSidecarPath('native', '/tmp/praxis-home')).toBe(
      '/tmp/praxis-home/state/unknown-cost-sidecar.json',
    )
    expect(resolveUnknownCostSidecarPath('claude', '/tmp/claude-config')).toBe(
      '/tmp/claude-config/praxis/unknown-cost-sidecar.json',
    )
  })

  it('derives simple mode from CLAUDE_CODE_SIMPLE truthy values like --bare', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-simple-mode-'))
    const configRoot = join(root, '.claude')
    await mkdir(configRoot, { recursive: true })
    await writeFile(join(configRoot, '.claude.json'), JSON.stringify({}))
    try {
      const toolNames = async (
        providerEnvironment: Record<string, string>,
      ): Promise<string[]> => {
        const service = await createDefaultDependencies().createService({
          eventSink: () => undefined,
          requireProvider: false,
          exposeToolRegistry: true,
          cwd: root,
          configRoot,
          providerEnvironment,
        })
        try {
          const registry = service.toolRegistry
          if (!registry) throw new Error('tool registry unavailable')
          return registry.definitions().map((definition) => definition.name)
        } finally {
          await service.close?.()
        }
      }

      for (const value of ['1', 'true', 'yes', 'on', 'TRUE', ' On ']) {
        const names = (await toolNames({ CLAUDE_CODE_SIMPLE: value })).sort()
        expect(names).toEqual(['Bash', 'Edit', 'Read'])
      }

      for (const value of ['0', 'false', 'off', 'sometimes', '']) {
        expect(await toolNames({ CLAUDE_CODE_SIMPLE: value })).toContain(
          'Write',
        )
      }
      expect(await toolNames({})).toContain('Write')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('projects native hooks normally while safe and bare modes keep only explicit settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-native-hooks-'))
    const configRoot = join(root, 'config')
    await mkdir(configRoot, { recursive: true })
    const hookSettings = (command: string) => ({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command }] }],
      },
    })
    await writeFile(
      join(configRoot, 'settings.json'),
      JSON.stringify(hookSettings('native-hook')),
    )
    try {
      const hookConfiguration = async (controls: CliControls) => {
        const service = await createDefaultDependencies().createService({
          eventSink: () => undefined,
          requireProvider: false,
          hooksOnly: true,
          cwd: root,
          configRoot,
          providerEnvironment: {},
          controls,
        })
        return service.hookConfiguration?.()
      }

      await expect(
        hookConfiguration({ ...DEFAULT_CLI_CONTROLS, dataPlane: 'native' }),
      ).resolves.toMatchObject({ hookCount: 1 })
      for (const mode of ['safeMode', 'bare'] as const) {
        await expect(
          hookConfiguration({
            ...DEFAULT_CLI_CONTROLS,
            dataPlane: 'native',
            [mode]: true,
          }),
        ).resolves.toMatchObject({ hookCount: 0 })
        const explicit = await hookConfiguration({
          ...DEFAULT_CLI_CONTROLS,
          dataPlane: 'native',
          [mode]: true,
          settings: JSON.stringify(hookSettings('explicit-hook')),
        })
        expect(explicit).toMatchObject({ hookCount: 1 })
        expect(
          explicit?.events.flatMap((event) =>
            event.matchers.flatMap((matcher) =>
              matcher.hooks.map((hook) => hook.label),
            ),
          ),
        ).toEqual(['explicit-hook'])
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not load native shared resources in safe or bare mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-native-isolation-'))
    const configRoot = join(root, 'config')
    await mkdir(join(configRoot, 'commands'), { recursive: true })
    await mkdir(join(configRoot, 'agents'), { recursive: true })
    await mkdir(join(configRoot, 'skills', 'poison'), { recursive: true })
    await writeFile(join(configRoot, 'settings.json'), '{not-json')
    await writeFile(join(configRoot, 'mcp.json'), '{not-json')
    await writeFile(join(configRoot, 'commands', 'poison.md'), 'POISON')
    await writeFile(join(configRoot, 'agents', 'poison.md'), 'POISON')
    await writeFile(join(configRoot, 'skills', 'poison', 'SKILL.md'), 'POISON')
    try {
      for (const mode of ['safeMode', 'bare'] as const) {
        const service = await createDefaultDependencies().createService({
          eventSink: () => undefined,
          requireProvider: false,
          exposeToolRegistry: true,
          cwd: root,
          configRoot,
          providerEnvironment: {},
          controls: {
            ...DEFAULT_CLI_CONTROLS,
            dataPlane: 'native',
            [mode]: true,
            agentDefinitions: JSON.stringify({
              explicit: { description: 'Explicit agent', prompt: 'EXPLICIT' },
            }),
          },
        })
        try {
          expect(
            service.slashCommands?.().map(({ name }) => name),
          ).not.toContain('poison')
          expect(service.agentDefinitions?.()).toContainEqual({
            name: 'explicit',
            description: 'Explicit agent',
          })
          expect(
            service.agentDefinitions?.().map(({ name }) => name),
          ).not.toContain('poison')
        } finally {
          await service.close?.()
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('executes each Claude compatibility hook setting once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-compat-hooks-'))
    const configRoot = join(root, 'config')
    await mkdir(configRoot, { recursive: true })
    await writeFile(
      join(configRoot, 'settings.json'),
      JSON.stringify({
        hooks: {
          Setup: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'printf blocked >&2; exit 2',
                },
              ],
            },
          ],
        },
      }),
    )
    const hookEvents: Array<{ type: string }> = []
    try {
      const service = await createDefaultDependencies().createService({
        eventSink: (event) => {
          if (event.type === 'hook') hookEvents.push(event.event)
        },
        requireProvider: false,
        exposeToolRegistry: true,
        cwd: root,
        configRoot,
        providerEnvironment: {},
        controls: { ...DEFAULT_CLI_CONTROLS, dataPlane: 'claude' },
      })
      try {
        await expect(service.lifecycle?.('init')).rejects.toThrow(
          'Setup hook error: blocked',
        )
        expect(
          hookEvents.filter((event) => event.type === 'started'),
        ).toHaveLength(1)
      } finally {
        await service.close?.()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('sends native hooks the Praxis transcript path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-native-hook-path-'))
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const hookScript = join(root, 'echo-hook.mjs')
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    await mkdir(configRoot, { recursive: true })
    await mkdir(cwd, { recursive: true })
    await writeFile(hookScript, 'process.stdin.pipe(process.stdout)\n')
    await writeFile(
      join(configRoot, 'settings.json'),
      JSON.stringify({
        hooks: {
          Setup: [
            {
              hooks: [
                {
                  type: 'command',
                  command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hookScript)}`,
                },
              ],
            },
          ],
        },
      }),
    )
    const hookOutputs: string[] = []
    try {
      const service = await createDefaultDependencies().createService({
        eventSink: (event) => {
          if (event.type === 'hook' && event.event.type === 'response') {
            hookOutputs.push(event.event.stdout ?? '')
          }
        },
        requireProvider: false,
        exposeToolRegistry: true,
        cwd,
        configRoot,
        providerEnvironment: {},
        controls: { ...DEFAULT_CLI_CONTROLS, dataPlane: 'native' },
      })
      try {
        await service.lifecycle?.('init', { sessionId })
      } finally {
        await service.close?.()
      }
      expect(hookOutputs).toHaveLength(1)
      const hookInput = JSON.parse(hookOutputs[0] as string) as {
        transcript_path: string
      }
      expect(hookInput.transcript_path).toBe(
        resolveDataPlanePaths({
          dataPlane: 'native',
          root: configRoot,
          cwd,
          sessionId,
        }).sessionFile,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('continues and forks the latest directory session while forwarding controls', async () => {
    const capture = captureIO()
    const calls: string[] = []
    let controls: Parameters<CliDependencies['createService']>[0]['controls']
    const base = dependencies()
    const controlled: CliDependencies = {
      async createService(options) {
        controls = options.controls
        const service = await base.createService(options)
        return {
          ...service,
          async fork(sessionId, targetSessionId) {
            calls.push(`fork:${sessionId}:${targetSessionId ?? ''}`)
            return {
              sessionId:
                targetSessionId ?? (await service.fork(sessionId)).sessionId,
              parentSessionId: sessionId,
            }
          },
          async resume(sessionId, prompt, signal) {
            calls.push(`resume:${sessionId}:${prompt}`)
            return service.resume(sessionId, prompt, signal)
          },
        }
      },
    }

    await expect(
      run(
        [
          '--continue',
          '--fork-session',
          '--session-id',
          '33333333-3333-4333-8333-333333333333',
          '--permission-mode',
          'dontAsk',
          '--tools=Read',
          '--',
          'hello',
        ],
        capture.io,
        controlled,
      ),
    ).resolves.toBe(0)

    expect(calls).toEqual([
      'fork:11111111-1111-4111-8111-111111111111:33333333-3333-4333-8333-333333333333',
      'resume:33333333-3333-4333-8333-333333333333:hello',
    ])
    expect(controls).toMatchObject({
      continueSession: true,
      forkSession: true,
      permissionMode: 'dontAsk',
      tools: ['Read'],
    })
  })

  it('resolves print resume selectors by ID or case-insensitive exact title', async () => {
    const firstId = '11111111-1111-4111-8111-111111111111'
    const secondId = '22222222-2222-4222-8222-222222222222'
    const calls: string[] = []
    const base = dependencies()
    const titled: CliDependencies = {
      async createService(options) {
        const service = await base.createService(options)
        return {
          ...service,
          async sessions() {
            return [
              {
                sessionId: firstId,
                name: 'Release Review',
                lastPrompt: 'first prompt',
                updatedAt: '2026-08-08T02:00:00.000Z',
                status: 'ready' as const,
                issue: null,
              },
              {
                sessionId: secondId,
                name: firstId,
                lastPrompt: 'second prompt',
                updatedAt: '2026-08-08T01:00:00.000Z',
                status: 'ready' as const,
                issue: null,
              },
            ]
          },
          async resume(sessionId, prompt, signal) {
            calls.push(`${sessionId}:${prompt}`)
            return service.resume(sessionId, prompt, signal)
          },
        }
      },
    }

    for (const argv of [
      ['-p', '--resume=RELEASE REVIEW', '--', 'by title'],
      ['-p', `-r${firstId.toUpperCase()}`, '--', 'by id'],
    ]) {
      const capture = captureIO()
      await expect(run(argv, capture.io, titled)).resolves.toBe(0)
    }
    expect(calls).toEqual([`${firstId}:by title`, `${firstId}:by id`])

    const missing = captureIO()
    await expect(
      run(['-p', '--resume=release', '--', 'no substring'], missing.io, titled),
    ).resolves.toBe(1)
    expect(missing.stderr.join('')).toContain(
      'Provided value "release" is not a UUID and does not match any session title',
    )
  })

  it('rejects ambiguous titles and missing non-interactive selectors', async () => {
    const base = dependencies()
    const duplicateTitles: CliDependencies = {
      async createService(options) {
        return {
          ...(await base.createService(options)),
          async sessions() {
            return [
              {
                sessionId: '11111111-1111-4111-8111-111111111111',
                name: 'Duplicate',
                lastPrompt: 'newer',
                updatedAt: '2026-08-08T02:00:00.000Z',
                status: 'ready' as const,
                issue: null,
              },
              {
                sessionId: '22222222-2222-4222-8222-222222222222',
                name: 'duplicate',
                lastPrompt: 'older',
                updatedAt: '2026-08-08T01:00:00.000Z',
                status: 'ready' as const,
                issue: null,
              },
            ]
          },
        }
      },
    }
    const ambiguous = captureIO()
    await expect(
      run(
        ['-p', '--resume=duplicate', '--', 'continue'],
        ambiguous.io,
        duplicateTitles,
      ),
    ).resolves.toBe(1)
    expect(ambiguous.stderr.join('')).toContain(
      '--resume "duplicate" matches 2 sessions',
    )
    expect(ambiguous.stderr.join('')).toMatch(/11111111[\s\S]*22222222/)

    for (const argv of [
      ['-p', '--resume'],
      ['--resume'],
      ['--background', '--resume'],
    ]) {
      const capture = captureIO()
      await expect(run(argv, capture.io, dependencies())).resolves.toBe(1)
      expect(capture.stderr.join('')).toContain(
        '--resume requires a valid session ID or session title',
      )
    }
  })

  it('resolves a background title selector to its session ID', async () => {
    const sourceId = '11111111-1111-4111-8111-111111111111'
    let launched:
      | Parameters<NonNullable<CliDependencies['topLevelAgents']>['launch']>[0]
      | undefined
    const base = dependencies()
    const managed: CliDependencies = {
      async createService(options) {
        return {
          ...(await base.createService(options)),
          async sessions() {
            return [
              {
                sessionId: sourceId,
                name: 'Release Review',
                lastPrompt: 'inspect release',
                updatedAt: '2026-08-08T00:00:00.000Z',
                status: 'ready' as const,
                issue: null,
              },
            ]
          },
        }
      },
      topLevelAgents: {
        async launch(options) {
          launched = options
          return { id: 'abcd1234', sessionId: options.resumeSessionId ?? '' }
        },
        async list() {
          return []
        },
        async logs() {
          return ''
        },
        async stop() {},
        async attach() {},
      },
    }

    await expect(
      run(
        ['--background', '--resume=release review', '--', 'continue'],
        captureIO().io,
        managed,
      ),
    ).resolves.toBe(0)
    expect(launched?.resumeSessionId).toBe(sourceId)
  })

  it('resumes a uniquely PR-linked session and rejects ambiguous matches', async () => {
    const calls: string[] = []
    const base = dependencies()
    const linked: CliDependencies = {
      async createService(options) {
        const service = await base.createService(options)
        return {
          ...service,
          async sessions() {
            return [
              {
                sessionId: '11111111-1111-4111-8111-111111111111',
                lastPrompt: 'first',
                updatedAt: '2026-08-08T01:00:00.000Z',
                status: 'ready' as const,
                issue: null,
                prNumber: 42,
                prUrl: 'https://github.com/owner/repo/pull/42',
                prRepository: 'owner/repo',
              },
              {
                sessionId: '22222222-2222-4222-8222-222222222222',
                lastPrompt: 'second',
                updatedAt: '2026-08-08T00:00:00.000Z',
                status: 'ready' as const,
                issue: null,
                prNumber: 42,
                prUrl: 'https://github.com/other/repo/pull/42',
                prRepository: 'other/repo',
              },
            ]
          },
          async resume(sessionId, prompt, signal) {
            calls.push(`${sessionId}:${prompt}`)
            return service.resume(sessionId, prompt, signal)
          },
        }
      },
    }

    const selected = captureIO()
    await expect(
      run(
        ['-p', '--from-pr=owner/repo#42', '--', 'continue'],
        selected.io,
        linked,
      ),
    ).resolves.toBe(0)
    expect(calls).toEqual(['11111111-1111-4111-8111-111111111111:continue'])

    const ambiguous = captureIO()
    await expect(
      run(['-p', '--from-pr=42', '--', 'continue'], ambiguous.io, linked),
    ).resolves.toBe(1)
    expect(ambiguous.stderr.join('')).toContain(
      'Multiple conversations are linked to PR 42',
    )

    const missing = captureIO()
    await expect(
      run(
        ['-p', '--from-pr=missing/repo#42', '--', 'continue'],
        missing.io,
        linked,
      ),
    ).resolves.toBe(1)
    expect(missing.stderr.join('')).toContain(
      'No conversation linked to PR missing/repo#42',
    )
  })

  it('selects and forks a PR-linked background session before launch', async () => {
    const sourceId = '11111111-1111-4111-8111-111111111111'
    const forkId = '33333333-3333-4333-8333-333333333333'
    const calls: string[] = []
    let launched:
      | Parameters<NonNullable<CliDependencies['topLevelAgents']>['launch']>[0]
      | undefined
    const base = dependencies()
    const managed: CliDependencies = {
      async createService(options) {
        const service = await base.createService(options)
        return {
          ...service,
          async sessions() {
            return [
              {
                sessionId: sourceId,
                lastPrompt: 'linked',
                updatedAt: '2026-08-08T00:00:00.000Z',
                status: 'ready' as const,
                issue: null,
                prNumber: 42,
                prUrl: 'https://github.com/owner/repo/pull/42',
                prRepository: 'owner/repo',
              },
            ]
          },
          async fork(sessionId, targetSessionId) {
            calls.push(`fork:${sessionId}:${targetSessionId ?? ''}`)
            return {
              parentSessionId: sessionId,
              sessionId: targetSessionId ?? 'generated-fork',
            }
          },
        }
      },
      topLevelAgents: {
        async launch(options) {
          launched = options
          return { id: 'abcd1234', sessionId: options.resumeSessionId ?? '' }
        },
        async list() {
          return []
        },
        async logs() {
          return ''
        },
        async stop() {},
        async attach() {},
      },
    }
    const capture = captureIO()

    await expect(
      run(
        [
          '--bg',
          '--from-pr=owner/repo#42',
          '--fork-session',
          '--session-id',
          forkId,
          '--',
          'continue',
        ],
        capture.io,
        managed,
      ),
    ).resolves.toBe(0)

    expect(calls).toEqual([`fork:${sourceId}:${forkId}`])
    expect(launched).toMatchObject({
      prompt: 'continue',
      resumeSessionId: forkId,
      argv: ['--from-pr=owner/repo#42', '--fork-session', '--', 'continue'],
    })
  })

  it('prints non-terminal runtime warnings to stderr', async () => {
    const capture = captureIO()

    await expect(
      run(['run', 'hello'], capture.io, dependencies('hook failed')),
    ).resolves.toBe(0)
    expect(capture.stdout.join('')).toBe('answer:hello\n')
    expect(capture.stderr).toEqual(['Warning: hook failed\n'])
  })

  it('keeps legacy JSON output parseable when MCP startup fails and warns on stderr', async () => {
    const capture = captureIO()
    const base = dependencies()
    const mcpStartupFailure: CliDependencies = {
      async createService(options) {
        options.eventSink({
          type: 'warning',
          message: 'MCP server broken unavailable: connection refused',
        })
        return base.createService(options)
      },
    }

    await expect(
      run(['run', '--json', 'hello'], capture.io, mcpStartupFailure),
    ).resolves.toBe(0)
    expect(capture.stdout.map((line) => JSON.parse(line))).toEqual([
      { type: 'text-delta', delta: 'answer:hello' },
      expect.objectContaining({ type: 'result', text: 'answer:hello' }),
    ])
    expect(capture.stderr).toEqual([
      'Warning: MCP server broken unavailable: connection refused\n',
    ])
  })

  it('redacts ambient credentials from warnings and structured failures', async () => {
    const secret = 'cli-diagnostic-secret-canary'
    const variable = 'PRAXIS_TEST_API_KEY'
    const previous = process.env[variable]
    process.env[variable] = secret
    const warning = captureIO()
    const failure = captureIO()
    const failed: CliDependencies = {
      async createService({ eventSink }) {
        return {
          async run() {
            eventSink({
              type: 'failed',
              message: `runtime echoed ${secret}`,
              retryable: false,
            })
            throw new Error(`provider echoed ${secret}`)
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
          async inspect() {
            throw new Error('unused')
          },
          async export() {
            throw new Error('unused')
          },
        }
      },
    }

    try {
      await expect(
        run(
          ['run', 'hello'],
          warning.io,
          dependencies(`hook echoed ${secret}`),
        ),
      ).resolves.toBe(0)
      await expect(
        run(['run', '--json', 'hello'], failure.io, failed),
      ).resolves.toBe(1)
      expect(warning.stderr).toEqual(['Warning: hook echoed [REDACTED]\n'])
      expect(failure.stdout.map((line) => JSON.parse(line))).toEqual([
        {
          type: 'failed',
          message: 'runtime echoed [REDACTED]',
          retryable: false,
        },
        { type: 'error', message: 'provider echoed [REDACTED]' },
      ])
      expect(failure.stdout.join('')).not.toContain(secret)
    } finally {
      if (previous === undefined) delete process.env[variable]
      else process.env[variable] = previous
    }
  })

  it('normalizes startup aborts to cancellation', async () => {
    const capture = captureIO()
    const controller = new AbortController()
    controller.abort()
    const aborted: CliDependencies = {
      async createService() {
        throw new DOMException('aborted', 'AbortError')
      },
    }

    await expect(
      run(['run', 'hello'], capture.io, aborted, controller.signal),
    ).resolves.toBe(130)
    expect(capture.stderr).toEqual(['Praxis run cancelled.\n'])
  })

  it('constructs the default service without an installed Claude binary', async () => {
    const capture = captureIO()
    const configDir = await mkdtemp(join(tmpdir(), 'praxis-cli-sessions-'))
    const missingBinary = join(configDir, 'missing-claude')
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const previousPraxisHome = process.env.PRAXIS_HOME
    const previousBinary = process.env.PRAXIS_CLAUDE_BINARY
    process.env.CLAUDE_CONFIG_DIR = configDir
    process.env.PRAXIS_HOME = configDir
    process.env.PRAXIS_CLAUDE_BINARY = missingBinary
    try {
      await expect(run(['sessions'], capture.io)).resolves.toBe(0)
      expect(capture.stdout.join('')).toBe('')
      expect(capture.stderr.join('')).not.toContain(missingBinary)
      expect(capture.stderr.join('')).not.toContain('--version')
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      if (previousPraxisHome === undefined) delete process.env.PRAXIS_HOME
      else process.env.PRAXIS_HOME = previousPraxisHome
      if (previousBinary === undefined) delete process.env.PRAXIS_CLAUDE_BINARY
      else process.env.PRAXIS_CLAUDE_BINARY = previousBinary
      await rm(configDir, { recursive: true, force: true })
    }
  })

  it('resumes with NDJSON runtime events and a result record', async () => {
    const capture = captureIO()
    const sessionId = '11111111-1111-4111-8111-111111111111'

    await expect(
      run(
        ['resume', '--json', sessionId, 'continue'],
        capture.io,
        dependencies(),
      ),
    ).resolves.toBe(0)
    const output = capture.stdout.map((line) => JSON.parse(line))
    expect(output).toEqual([
      { type: 'text-delta', delta: 'resumed:continue' },
      {
        type: 'result',
        sessionId,
        text: 'resumed:continue',
        usage: { inputTokens: 4, outputTokens: 5 },
      },
    ])
  })

  it('supports Claude-style output format names while retaining legacy --json', async () => {
    const text = captureIO()
    await expect(
      run(['run', '--output-format', 'text', 'hello'], text.io, dependencies()),
    ).resolves.toBe(0)
    expect(text.stdout.join('')).toBe('answer:hello\n')

    const json = captureIO()
    await expect(
      run(['run', '--output-format', 'json', 'hello'], json.io, dependencies()),
    ).resolves.toBe(0)
    expect(json.stdout.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'answer:hello',
        session_id: expect.any(String),
        num_turns: 1,
        usage: { input_tokens: 2, output_tokens: 3 },
      }),
    ])

    const stream = captureIO()
    await expect(
      run(
        ['run', '--output-format', 'stream-json', '--verbose', 'hello'],
        stream.io,
        dependencies(),
      ),
    ).resolves.toBe(0)
    const streamed = stream.stdout.map((line) => JSON.parse(line))
    expect(streamed.map((record) => record.type)).toEqual([
      'system',
      'assistant',
      'result',
    ])
    expect(streamed[0]).toEqual(
      expect.objectContaining({ type: 'system', subtype: 'init' }),
    )
    expect(streamed[1]).toEqual(
      expect.objectContaining({
        type: 'assistant',
        message: expect.objectContaining({
          role: 'assistant',
          content: [{ type: 'text', text: 'answer:hello' }],
        }),
      }),
    )
    expect(streamed[2]).toEqual(
      expect.objectContaining({
        type: 'result',
        subtype: 'success',
        result: 'answer:hello',
      }),
    )

    const legacy = captureIO()
    await expect(
      run(['run', '--json', 'hello'], legacy.io, dependencies()),
    ).resolves.toBe(0)
    expect(legacy.stdout.map((line) => JSON.parse(line))).toEqual([
      { type: 'text-delta', delta: 'answer:hello' },
      expect.objectContaining({ type: 'result', text: 'answer:hello' }),
    ])
  })

  it('emits one typed JSON result at the explicit print model turn limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-cli-turn-limit-'))
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    let providerCalls = 0
    const capture = captureIO()
    const bounded: CliDependencies = {
      async createService(options) {
        return new ClaudeSessionService({
          configRoot,
          dataPlane: 'native',
          cwd,
          claudeVersion: '2.1.208',
          eventSink: options.eventSink,
          ...(options.controls?.maxTurns === undefined
            ? {}
            : { maxModelTurns: options.controls.maxTurns }),
          provider: {
            capabilities: { streaming: true, usage: true, tools: true },
            async *complete() {
              providerCalls += 1
              yield {
                type: 'tool-call',
                call: {
                  id: `read_${providerCalls}`,
                  name: 'Read',
                  input: {},
                },
              }
            },
          },
          tools: {
            definitions: () => [
              {
                name: 'Read',
                description: 'Read',
                inputSchema: { type: 'object' },
              },
            ],
            prepare: async (call) => call,
            execute: async () => ({ content: 'READ', isError: false }),
          },
          permissions: { resolve: () => ({ behavior: 'allow' }) },
        })
      },
    }

    try {
      await expect(
        run(
          ['-p', '--max-turns', '2', '--output-format', 'json', 'continue'],
          capture.io,
          bounded,
        ),
      ).resolves.toBe(1)
      expect(providerCalls).toBe(2)
      expect(capture.stdout).toHaveLength(1)
      expect(JSON.parse(capture.stdout[0] as string)).toMatchObject({
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        num_turns: 2,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('emits prompt suggestions after stream-json result', async () => {
    const capture = captureIO()
    const base = dependencies()
    const calls: string[] = []
    const suggestionDeps: CliDependencies = {
      ...base,
      async createService(options) {
        const service = await base.createService(options)
        return {
          ...service,
          async promptSuggestion(sessionId) {
            calls.push(sessionId)
            return 'continue the implementation'
          },
        }
      },
    }
    await expect(
      run(
        [
          '-p',
          '--output-format=stream-json',
          '--verbose',
          '--prompt-suggestions',
          '--',
          'hello',
        ],
        capture.io,
        suggestionDeps,
      ),
    ).resolves.toBe(0)
    const records = capture.stdout.map((line) => JSON.parse(line))
    expect(records.map((record) => record.type)).toEqual([
      'system',
      'assistant',
      'result',
      'prompt_suggestion',
    ])
    expect(calls).toEqual([expect.any(String)])
  })

  it('consumes text user messages from stream-json stdin for run and resume', async () => {
    const sessionId = '11111111-1111-4111-8111-111111111111'
    const input =
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'from stdin' }],
        },
      }) + '\n'
    const runCapture = captureStreamIO(input)
    await expect(
      run(
        [
          'run',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--verbose',
        ],
        runCapture.io,
        dependencies(),
      ),
    ).resolves.toBe(0)
    expect(runCapture.stdout.map((line) => JSON.parse(line)).at(-1)).toEqual(
      expect.objectContaining({ result: 'answer:from stdin' }),
    )

    const resumeCapture = captureStreamIO(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'continue from stdin' },
      }) + '\n',
    )
    await expect(
      run(
        [
          'resume',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--verbose',
          sessionId,
        ],
        resumeCapture.io,
        dependencies(),
      ),
    ).resolves.toBe(0)
    expect(resumeCapture.stdout.map((line) => JSON.parse(line)).at(-1)).toEqual(
      expect.objectContaining({ result: 'resumed:continue from stdin' }),
    )
  })

  it('keeps one service and session across multiple realtime stdin turns', async () => {
    const fixedSessionId = '33333333-3333-4333-8333-333333333333'
    const calls: string[] = []
    let created = 0
    let closed = 0
    const realtime: CliDependencies = {
      async createService({ eventSink }) {
        created += 1
        const complete = (text: string) => {
          eventSink({ type: 'state', state: 'awaiting-model' })
          eventSink({ type: 'text-delta', delta: text })
          eventSink({
            type: 'usage',
            usage: { inputTokens: 1, outputTokens: 1 },
          })
          eventSink({ type: 'state', state: 'completed' })
        }
        return {
          async run(prompt, _signal, sessionId) {
            calls.push(`run:${sessionId}:${prompt}`)
            complete(`answer:${prompt}`)
            return {
              sessionId: sessionId ?? fixedSessionId,
              text: `answer:${prompt}`,
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume(sessionId, prompt) {
            calls.push(`resume:${sessionId}:${prompt}`)
            complete(`answer:${prompt}`)
            return {
              sessionId,
              text: `answer:${prompt}`,
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
          async inspect() {
            throw new Error('unused')
          },
          async export() {
            throw new Error('unused')
          },
          async close() {
            closed += 1
          },
          runtimeInfo() {
            return {
              cwd: '/workspace',
              model: 'test-model',
              tools: [],
              mcpServers: [],
              permissionMode: 'default',
              slashCommands: [],
              agents: [],
              skills: [],
              claudeCodeVersion: '2.1.208',
            }
          },
        }
      },
    }
    const first = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'first' },
    })
    const second = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'second' },
    })
    const capture = captureStreamIO(
      first.slice(0, 17),
      `${first.slice(17)}\n${second}\n`,
    )

    await expect(
      run(
        [
          '-p',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--verbose',
          '--replay-user-messages',
          '--session-id',
          fixedSessionId,
        ],
        capture.io,
        realtime,
      ),
    ).resolves.toBe(0)

    expect(calls).toEqual([
      `run:${fixedSessionId}:first`,
      `resume:${fixedSessionId}:second`,
    ])
    expect(created).toBe(1)
    expect(closed).toBe(1)
    const records = capture.stdout.map((line) => JSON.parse(line))
    expect(records.filter((record) => record.subtype === 'init')).toHaveLength(
      2,
    )
    expect(records.filter((record) => record.type === 'result')).toHaveLength(2)
    expect(
      records
        .filter((record) => record.type === 'user')
        .map((record) => record.message.content),
    ).toEqual(['first', 'second'])
    expect(new Set(records.map((record) => record.session_id))).toEqual(
      new Set([fixedSessionId]),
    )
  })

  it('round-trips SDK permission control records over stream-json', async () => {
    const capture = captureIO()
    const user = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'run protected tool' },
    })
    capture.io.readStdinLines = () =>
      (async function* () {
        yield `${user}\n`
        while (
          !capture.stdout.some((line) => line.includes('control_request'))
        ) {
          await new Promise((resolve) => setTimeout(resolve, 1))
        }
        const request = capture.stdout
          .map((line) => {
            try {
              return JSON.parse(line)
            } catch {
              return null
            }
          })
          .find((record) => record?.type === 'control_request')
        yield `${JSON.stringify({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: request.request_id,
            response: { behavior: 'allow', updatedInput: {} },
          },
        })}\n`
      })()
    const controlled: CliDependencies = {
      async createService({ eventSink, approveTool }) {
        return {
          async run(prompt, _signal, sessionId) {
            const allowed = await approveTool?.({
              id: 'tool-call-1',
              name: 'Bash',
              input: { command: 'echo ok' },
            })
            eventSink({
              type: 'text-delta',
              delta: allowed ? 'allowed' : 'denied',
            })
            return {
              sessionId: sessionId ?? '44444444-4444-4444-8444-444444444444',
              text: `${prompt}:${allowed ? 'allowed' : 'denied'}`,
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
          async inspect() {
            throw new Error('unused')
          },
          async export() {
            throw new Error('unused')
          },
          runtimeInfo() {
            return {
              cwd: '/workspace',
              model: 'test-model',
              tools: ['Bash'],
              mcpServers: [],
              permissionMode: 'default',
              slashCommands: [],
              agents: [],
              skills: [],
              claudeCodeVersion: '2.1.208',
            }
          },
        }
      },
    }
    await expect(
      run(
        [
          '-p',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--verbose',
        ],
        capture.io,
        controlled,
      ),
    ).resolves.toBe(0)
    const records = capture.stdout.map((line) => JSON.parse(line))
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'control_request',
          request: expect.objectContaining({ subtype: 'can_use_tool' }),
        }),
        expect.objectContaining({ type: 'result', subtype: 'success' }),
      ]),
    )
  })

  it('round-trips MCP elicitation control records over stream-json', async () => {
    let response: unknown
    const cliDependencies: CliDependencies = {
      async createService({ eventSink, onElicitation }) {
        return {
          async run(prompt, _signal, sessionId) {
            response = await onElicitation?.({
              serverName: 'fixture',
              message: 'Provide code',
              mode: 'form',
              requestedSchema: {
                type: 'object',
                properties: { code: { type: 'string' } },
              },
            })
            eventSink({
              type: 'elicitation-complete',
              mcpServerName: 'fixture',
              elicitationId: 'elicit-1',
            })
            return {
              sessionId: sessionId ?? '11111111-1111-4111-8111-111111111111',
              text: `answer:${prompt}`,
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
          async inspect() {
            throw new Error('unused')
          },
          async export() {
            return Buffer.from('')
          },
        }
      },
    }
    const capture = captureIO()
    capture.io.readStdinLines = () =>
      (async function* () {
        yield `${JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'elicit' },
        })}\n`
        while (
          !capture.stdout.some((line) =>
            line.includes('"subtype":"elicitation"'),
          )
        ) {
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
        const controlRequest = capture.stdout
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .find((record) => record.type === 'control_request')
        const requestId = controlRequest?.request_id
        if (typeof requestId !== 'string') {
          throw new Error('elicitation control request missing request_id')
        }
        yield `${JSON.stringify({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: requestId,
            response: { action: 'accept', content: { code: 'ok' } },
          },
        })}\n`
      })()
    await expect(
      run(
        [
          '-p',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--verbose',
        ],
        capture.io,
        cliDependencies,
      ),
    ).resolves.toBe(0)
    expect(response).toEqual({ action: 'accept', content: { code: 'ok' } })
    const records = capture.stdout.map((line) => JSON.parse(line))
    expect(records).toContainEqual(
      expect.objectContaining({
        type: 'control_request',
        request: expect.objectContaining({
          subtype: 'elicitation',
          mcp_server_name: 'fixture',
          requested_schema: expect.any(Object),
        }),
      }),
    )
    expect(records).toContainEqual(
      expect.objectContaining({
        type: 'system',
        subtype: 'elicitation_complete',
        elicitation_id: 'elicit-1',
      }),
    )
  })

  it('returns redacted terminal result envelopes for structured execution failures', async () => {
    const variable = 'PRAXIS_PROTOCOL_TEST_API_KEY'
    const secret = 'protocol-failure-secret'
    const previous = process.env[variable]
    process.env[variable] = secret
    let closed = 0
    const failing: CliDependencies = {
      async createService({ eventSink }) {
        return {
          async run() {
            eventSink({ type: 'state', state: 'awaiting-model' })
            eventSink({
              type: 'failed',
              message: `provider ${secret}`,
              retryable: false,
            })
            throw new Error(`provider ${secret}`)
          },
          async resume() {
            throw new Error('unused')
          },
          async fork() {
            throw new Error('unused')
          },
          async sessions() {
            return []
          },
          async inspect() {
            throw new Error('unused')
          },
          async export() {
            throw new Error('unused')
          },
          async close() {
            closed += 1
          },
        }
      },
    }

    try {
      for (const format of ['json', 'stream-json'] as const) {
        const capture = captureIO()
        const args = [
          '-p',
          '--output-format',
          format,
          ...(format === 'stream-json' ? ['--verbose'] : []),
          'fail',
        ]
        await expect(run(args, capture.io, failing)).resolves.toBe(1)
        const records = capture.stdout.map((line) => JSON.parse(line))
        expect(records.at(-1)).toEqual(
          expect.objectContaining({
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            errors: ['provider [REDACTED]'],
          }),
        )
        expect(capture.stdout.join('')).not.toContain(secret)
        expect(capture.stderr).toEqual([])
      }
      expect(closed).toBe(2)
    } finally {
      if (previous === undefined) delete process.env[variable]
      else process.env[variable] = previous
    }
  })

  it('keeps a structured result terminal when service teardown fails', async () => {
    const capture = captureIO()
    const base = dependencies()
    const teardownFailure: CliDependencies = {
      async createService(options) {
        const service = await base.createService(options)
        return {
          ...service,
          async close() {
            throw new Error('teardown failed')
          },
        }
      },
    }

    await expect(
      run(
        ['-p', '--output-format', 'stream-json', '--verbose', 'hello'],
        capture.io,
        teardownFailure,
      ),
    ).resolves.toBe(0)

    const records = capture.stdout.map((line) => JSON.parse(line))
    expect(records.at(-1)).toMatchObject({
      type: 'result',
      subtype: 'success',
      is_error: false,
    })
    expect(capture.stderr).toEqual(['Warning: teardown failed\n'])
  })

  it('accepts empty stream-json input as a no-op', async () => {
    const capture = captureStreamIO('')
    const base = dependencies()
    const lifecycleCalls: string[] = []
    const emptyInputDependencies: CliDependencies = {
      async createService(options) {
        expect(options.requireProvider).toBe(false)
        return {
          ...(await base.createService(options)),
          async lifecycle(trigger) {
            lifecycleCalls.push(trigger)
          },
        }
      },
    }

    await expect(
      run(
        [
          'run',
          '--init',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--verbose',
        ],
        capture.io,
        emptyInputDependencies,
      ),
    ).resolves.toBe(0)
    expect(lifecycleCalls).toEqual(['init'])
    expect(capture.stdout).toEqual([])
    expect(capture.stderr).toEqual([])
  })

  it('rejects malformed stream-json input', async () => {
    for (const input of [
      '{bad}\n',
      JSON.stringify({ type: 'assistant', content: 'no user' }) + '\n',
    ]) {
      const capture = captureStreamIO(input)
      await expect(
        run(
          [
            'run',
            '--input-format',
            'stream-json',
            '--output-format',
            'stream-json',
            '--verbose',
          ],
          capture.io,
          dependencies(),
        ),
      ).resolves.toBe(1)
      expect(capture.stderr.join('')).toMatch(/stream-json/)
    }
  })

  it('validates format options and incompatible legacy flags', async () => {
    for (const argv of [
      ['run', '--output-format', 'yaml', 'hello'],
      ['run', '--input-format', 'yaml', 'hello'],
      ['run', '--json', '--output-format', 'json', 'hello'],
    ]) {
      const capture = captureIO()
      await expect(run(argv, capture.io, dependencies())).resolves.toBe(1)
      expect(`${capture.stderr.join('')}${capture.stdout.join('')}`).toMatch(
        /format|combined/,
      )
    }
  })

  it('passes explicit interrupted-tool recovery only for resume', async () => {
    const capture = captureIO()
    let approveRecovery:
      ((call: ModelToolCall) => boolean | Promise<boolean>) | undefined
    const base = dependencies()
    const recovering: CliDependencies = {
      async createService(options) {
        approveRecovery = options.approveRecovery
        return base.createService(options)
      },
    }

    await expect(
      run(
        [
          'resume',
          '--retry-interrupted-tools',
          '11111111-1111-4111-8111-111111111111',
          'continue',
        ],
        capture.io,
        recovering,
      ),
    ).resolves.toBe(0)
    expect(
      await approveRecovery?.({ id: 'interrupted', name: 'Bash', input: {} }),
    ).toBe(true)

    const prCapture = captureIO()
    const prRecovering: CliDependencies = {
      async createService(options) {
        approveRecovery = options.approveRecovery
        const service = await base.createService(options)
        return {
          ...service,
          async sessions() {
            return [
              {
                sessionId: '11111111-1111-4111-8111-111111111111',
                lastPrompt: 'linked',
                updatedAt: '2026-08-08T00:00:00.000Z',
                status: 'ready' as const,
                issue: null,
                prNumber: 42,
                prUrl: 'https://github.com/owner/repo/pull/42',
                prRepository: 'owner/repo',
              },
            ]
          },
        }
      },
    }
    await expect(
      run(
        ['--from-pr=42', '--retry-interrupted-tools', '--', 'continue'],
        prCapture.io,
        prRecovering,
      ),
    ).resolves.toBe(0)
    expect(
      await approveRecovery?.({
        id: 'interrupted-pr',
        name: 'Bash',
        input: {},
      }),
    ).toBe(true)
  })

  it('passes an explicit agent without including the option in the prompt', async () => {
    const capture = captureIO()
    let selectedAgent: string | undefined
    const base = dependencies()
    const withAgent: CliDependencies = {
      async createService(options) {
        selectedAgent = options.agent
        return base.createService(options)
      },
    }

    await expect(
      run(
        ['run', '--agent', 'reviewer', 'inspect', 'this'],
        capture.io,
        withAgent,
      ),
    ).resolves.toBe(0)
    expect(selectedAgent).toBe('reviewer')
    expect(capture.stdout.join('')).toBe('answer:inspect this\n')
  })

  it('lists and forks sessions without a provider', async () => {
    const listed = captureIO()
    const forked = captureIO()

    await expect(run(['sessions'], listed.io, dependencies())).resolves.toBe(0)
    await expect(
      run(
        ['fork', '11111111-1111-4111-8111-111111111111'],
        forked.io,
        dependencies(),
      ),
    ).resolves.toBe(0)
    expect(listed.stdout.join('')).toContain('\thello\tready\t\n')
    expect(forked.stdout).toEqual(['22222222-2222-4222-8222-222222222222\n'])
  })

  it('inspects and exports sessions without a provider', async () => {
    const inspected = captureIO()
    const inspectedText = captureIO()
    const exported = captureIO()
    const sessionId = '11111111-1111-4111-8111-111111111111'

    await expect(
      run(['inspect', '--json', sessionId], inspected.io, dependencies()),
    ).resolves.toBe(0)
    await expect(
      run(['export', sessionId], exported.io, dependencies()),
    ).resolves.toBe(0)
    await expect(
      run(['inspect', sessionId], inspectedText.io, dependencies()),
    ).resolves.toBe(0)

    expect(inspected.stdout.map((line) => JSON.parse(line))).toEqual([
      {
        type: 'session',
        session: expect.objectContaining({ sessionId, status: 'ready' }),
      },
    ])
    expect(inspectedText.stdout.join('')).toContain(
      `${sessionId}\tready\tread-write\t2026-08-03T00:00:00.000Z\t3\t128\ttrue\thello\t\n`,
    )
    expect(exported.stdout).toEqual(['{"type":"user"}\n'])
  })

  it('exports invalid UTF-8 losslessly in plain and JSON modes', async () => {
    const source = Buffer.from([0xff, 0x0a])
    const plain = captureIO()
    const json = captureIO()
    const sessionId = '11111111-1111-4111-8111-111111111111'

    await expect(
      run(['export', sessionId], plain.io, dependencies(undefined, source)),
    ).resolves.toBe(0)
    await expect(
      run(
        ['export', '--json', sessionId],
        json.io,
        dependencies(undefined, source),
      ),
    ).resolves.toBe(0)

    expect(Buffer.concat(plain.stdoutBytes)).toEqual(source)
    expect(JSON.parse(json.stdout.join(''))).toEqual({
      type: 'session-export',
      sessionId,
      encoding: 'base64',
      transcript: source.toString('base64'),
    })
  })

  it('reports invalid commands without throwing', async () => {
    const capture = captureIO()

    await expect(run(['resume'], capture.io, dependencies())).resolves.toBe(1)
    expect(capture.stderr).toEqual(['Session ID is required\n'])
  })

  it('rejects extra operands for provider-free session commands', async () => {
    for (const argv of [
      ['sessions', 'extra'],
      ['inspect', '11111111-1111-4111-8111-111111111111', 'extra'],
      ['export', '11111111-1111-4111-8111-111111111111', 'extra'],
    ]) {
      const capture = captureIO()
      await expect(run(argv, capture.io, dependencies())).resolves.toBe(1)
      expect(capture.stderr.join('')).toContain('Unexpected operand')
    }
  })
})
