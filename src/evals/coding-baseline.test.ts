import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'
import { ClaudeSessionService } from '../application/session-service.js'
import type {
  ModelProvider,
  ModelRequest,
  PermissionResolver,
} from '../core/runtime.js'
import { FilteredToolRegistry } from '../tools/filtered-tool-registry.js'
import { LocalToolRegistry } from '../tools/local-tools.js'
import type {
  EvalRuntimeFactory,
  EvalRuntimeFactoryOptions,
} from './eval-contract.js'
import { executeProjectEvalCommand } from './project-eval.js'
import { malformedModelToolCall } from '../core/runtime.js'

const FIXTURE_ROOT = join(process.cwd(), 'test/fixtures/project-evals')
const FIXTURE_FILES = [
  'evals/active-turn-steering/fixture/README.md',
  'evals/bug-fix/fixture/math.cjs',
  'evals/denied-permission-recovery/fixture/protected.txt',
  'evals/long-context-resume/fixture/notes.txt',
  'evals/malformed-tool-input-recovery/fixture/target.txt',
  'evals/refactor/fixture/user.cjs',
  'evals/repository-navigation/fixture/README.md',
  'evals/repository-navigation/fixture/src/config.js',
  'evals/small-feature/fixture/greeting.cjs',
] as const
const roots: string[] = []

interface Deferred<T> {
  promise: Promise<T>
  resolve(value?: T | PromiseLike<T>): void
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value?: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = (value) => resolvePromise(value as T)
  })
  return { promise, resolve }
}

interface ScriptedHandshake {
  started: Deferred<void>
  release: Deferred<void>
  requests: ModelRequest[]
}

function scriptedProvider(
  options: EvalRuntimeFactoryOptions,
  variant: 'baseline' | 'candidate',
): { provider: ModelProvider; handshake: ScriptedHandshake } {
  const scenario = options.env.EVAL_SCENARIO
  let turn = 0
  const started = deferred()
  const release = deferred()
  const requests: ModelRequest[] = []
  const provider: ModelProvider = {
    model: options.model ?? 'coding-baseline-model',
    capabilities: {
      streaming: true,
      usage: true,
      tools: true,
      terminalReasons: true,
    },
    async *complete(request) {
      requests.push(request)
      turn += 1
      const usage = { inputTokens: 4, outputTokens: 3 }
      if (scenario === 'active-turn-steering' && turn === 1) {
        started.resolve()
        await release.promise
        yield { type: 'text-delta', delta: 'waiting' }
        yield { type: 'usage', usage }
        yield { type: 'terminal', reason: 'end_turn' }
        return
      }
      if (scenario === 'active-turn-steering' && turn > 1) {
        yield { type: 'text-delta', delta: 'STEERED_OK' }
      } else if (scenario === 'long-context-resume') {
        if (turn === 1) {
          yield {
            type: 'tool-call',
            call: {
              id: 'seed-read',
              name: 'Read',
              input: { file_path: join(options.cwd, 'notes.txt') },
            },
          }
          yield { type: 'usage', usage }
          yield { type: 'terminal', reason: 'tool_use' }
          return
        }
        yield {
          type: 'text-delta',
          delta:
            turn === 2
              ? `${'deterministic context seed '.repeat(1_000)}SEED_RECORDED`
              : 'RESUME_OK',
        }
        yield { type: 'usage', usage }
        yield { type: 'terminal', reason: 'end_turn' }
        return
      }
      if (scenario === 'bug-fix') {
        if (variant === 'baseline') {
          yield { type: 'text-delta', delta: 'Unable to make the fix.' }
        } else if (turn === 1) {
          yield {
            type: 'tool-call',
            call: {
              id: 'math-read',
              name: 'Read',
              input: { file_path: join(options.cwd, 'math.cjs') },
            },
          }
          yield { type: 'usage', usage }
          yield { type: 'terminal', reason: 'tool_use' }
          return
        } else if (turn === 2) {
          yield {
            type: 'tool-call',
            call: {
              id: 'math-edit',
              name: 'Edit',
              input: {
                file_path: join(options.cwd, 'math.cjs'),
                old_string: 'a - b',
                new_string: 'a + b',
              },
            },
          }
          yield { type: 'usage', usage }
          yield { type: 'terminal', reason: 'tool_use' }
          return
        }
        yield { type: 'text-delta', delta: 'Fixed.' }
      } else if (scenario === 'small-feature' && turn === 1) {
        yield {
          type: 'tool-call',
          call: {
            id: 'greeting-write',
            name: 'Write',
            input: {
              file_path: join(options.cwd, 'greeting.txt'),
              content: 'hello\n',
            },
          },
        }
        yield { type: 'usage', usage }
        yield { type: 'terminal', reason: 'tool_use' }
        return
      } else if (scenario === 'refactor') {
        if (turn === 1) {
          yield {
            type: 'tool-call',
            call: {
              id: 'user-read',
              name: 'Read',
              input: { file_path: join(options.cwd, 'user.cjs') },
            },
          }
          yield { type: 'usage', usage }
          yield { type: 'terminal', reason: 'tool_use' }
          return
        }
        if (turn === 2) {
          yield {
            type: 'tool-call',
            call: {
              id: 'user-edit',
              name: 'Edit',
              input: {
                file_path: join(options.cwd, 'user.cjs'),
                old_string: "name: 'Ada'",
                new_string: "name: 'Ada Lovelace'",
              },
            },
          }
          yield { type: 'usage', usage }
          yield { type: 'terminal', reason: 'tool_use' }
          return
        }
        yield { type: 'text-delta', delta: 'Refactor complete.' }
      } else if (scenario === 'repository-navigation') {
        if (turn === 1) {
          yield {
            type: 'tool-call',
            call: {
              id: 'config-glob',
              name: 'Glob',
              input: { pattern: '**/*.js' },
            },
          }
          yield { type: 'usage', usage }
          yield { type: 'terminal', reason: 'tool_use' }
          return
        }
        if (turn === 2) {
          yield {
            type: 'tool-call',
            call: {
              id: 'config-grep',
              name: 'Grep',
              input: { pattern: 'api.example.test', path: '.' },
            },
          }
          yield { type: 'usage', usage }
          yield { type: 'terminal', reason: 'tool_use' }
          return
        }
        yield {
          type: 'text-delta',
          delta: 'The endpoint is https://api.example.test.',
        }
      } else if (scenario === 'denied-permission-recovery') {
        if (turn === 1) {
          yield {
            type: 'tool-call',
            call: {
              id: 'protected-read',
              name: 'Read',
              input: { file_path: join(options.cwd, 'protected.txt') },
            },
          }
          yield { type: 'usage', usage }
          yield { type: 'terminal', reason: 'tool_use' }
          return
        }
        if (turn === 2) {
          yield {
            type: 'tool-call',
            call: {
              id: 'protected-write',
              name: 'Write',
              input: {
                file_path: join(options.cwd, 'protected.txt'),
                content: 'must not change',
              },
            },
          }
          yield { type: 'usage', usage }
          yield { type: 'terminal', reason: 'tool_use' }
          return
        }
        yield {
          type: 'text-delta',
          delta: 'Recovered after permission denial.',
        }
      } else if (scenario === 'malformed-tool-input-recovery') {
        if (turn === 1) {
          yield {
            type: 'tool-call',
            call: {
              id: 'target-read',
              name: 'Read',
              input: { file_path: join(options.cwd, 'target.txt') },
            },
          }
          yield { type: 'usage', usage }
          yield { type: 'terminal', reason: 'tool_use' }
          return
        }
        if (turn === 2) {
          yield {
            type: 'tool-call',
            call: malformedModelToolCall('bad-edit', 'Edit'),
          }
          yield { type: 'usage', usage }
          yield { type: 'terminal', reason: 'tool_use' }
          return
        }
        if (turn === 3) {
          yield {
            type: 'tool-call',
            call: {
              id: 'good-edit',
              name: 'Edit',
              input: {
                file_path: join(options.cwd, 'target.txt'),
                old_string: 'broken',
                new_string: 'repaired',
              },
            },
          }
          yield { type: 'usage', usage }
          yield { type: 'terminal', reason: 'tool_use' }
          return
        }
        yield { type: 'text-delta', delta: 'Corrected.' }
      } else {
        yield { type: 'text-delta', delta: 'done' }
      }
      yield { type: 'usage', usage }
      yield { type: 'terminal', reason: 'end_turn' }
    },
  }
  return { provider, handshake: { started, release, requests } }
}

function createFactory(variant: 'baseline' | 'candidate'): EvalRuntimeFactory {
  return {
    create: async (options) => {
      const scripted = scriptedProvider(options, variant)
      const { provider, handshake } = scripted
      const permissions: PermissionResolver = {
        resolve: (call) =>
          options.env.EVAL_SCENARIO === 'denied-permission-recovery' &&
          call.name === 'Write'
            ? { behavior: 'deny', reason: 'fixture write is protected' }
            : { behavior: 'allow' },
      }
      const base = new LocalToolRegistry({
        cwd: options.cwd,
        dataPlane: 'native',
        homeDirectory: options.home,
        configRoot: options.configRoot,
      })
      const tools = new FilteredToolRegistry(base, {
        tools: options.allowedTools,
      })
      const service = new ClaudeSessionService({
        configRoot: options.configRoot,
        dataPlane: 'native',
        cwd: options.cwd,
        claudeVersion: '2.1.208',
        provider,
        tools,
        permissions,
        maxModelTurns: options.maxTurns,
        sessionPersistence: true,
        eventSink: options.eventSink,
      })
      return {
        run: async (prompt, signal) => {
          const sessionId = randomUUID()
          const running = service.run(prompt, signal, sessionId)
          if (
            options.env.EVAL_SCENARIO === 'active-turn-steering' &&
            handshake
          ) {
            await handshake.started.promise
            service.steer(
              sessionId,
              'Please finish with the steering instruction.',
            )
            handshake.release.resolve()
          }
          const first = await running
          if (options.env.EVAL_SCENARIO === 'long-context-resume') {
            const resumed = await service.resume(
              sessionId,
              'Continue and report RESUME_OK.',
              signal,
            )
            const result = {
              text: resumed.text,
              turns: Math.max(1, handshake.requests.length),
              usage: resumed.usage,
            }
            return resumed.costUsd === undefined
              ? result
              : { ...result, costUsd: resumed.costUsd }
          }
          const result = {
            text: first.text,
            usage: first.usage,
            turns: Math.max(1, handshake.requests.length),
          }
          return first.costUsd === undefined
            ? result
            : { ...result, costUsd: first.costUsd }
        },
        close: () => service.close(),
      }
    },
  }
}

async function runEval(variant: 'baseline' | 'candidate', outputDir: string) {
  const output: string[] = []
  const code = await executeProjectEvalCommand(
    [
      FIXTURE_ROOT,
      '--allow-tools',
      'Write,Edit',
      '--run-verification',
      '--output-dir',
      outputDir,
      '--json',
    ],
    { stdout: (message) => output.push(message), stderr: () => undefined },
    {
      configRoot: join(outputDir, 'config'),
      runtimeFactory: createFactory(variant),
      version: 'baseline-test',
    },
  )
  return {
    code,
    aggregate: JSON.parse(output.at(-1) ?? '{}') as {
      passed: number
      run_count: number
      output_dir: string
      safety_passed: number
      safety_failed: number
      permission_decisions: { allow: number; ask: number; deny: number }
      tool_errors: number
    },
  }
}

describe('coding baseline suite', () => {
  afterAll(async () => {
    await Promise.all(
      roots.map((root) => rm(root, { recursive: true, force: true })),
    )
  })

  it('runs all eight cases through native SessionService and compares candidate to baseline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-coding-baseline-'))
    roots.push(root)
    const baselineDir = join(root, 'baseline')
    const candidateDir = join(root, 'candidate')
    await mkdir(baselineDir, { recursive: true })
    await mkdir(candidateDir, { recursive: true })
    const before = await Promise.all(
      FIXTURE_FILES.map((path) => readFile(join(FIXTURE_ROOT, path), 'utf8')),
    )
    const baseline = await runEval('baseline', baselineDir)
    const candidate = await runEval('candidate', candidateDir)
    expect(baseline.code).toBe(1)
    expect(baseline.aggregate).toMatchObject({
      run_count: 8,
      passed: 7,
      safety_passed: 8,
      safety_failed: 0,
      permission_decisions: { allow: 9, ask: 0, deny: 1 },
    })
    expect(candidate.code).toBe(0)
    expect(candidate.aggregate).toMatchObject({
      run_count: 8,
      passed: 8,
      safety_passed: 8,
      safety_failed: 0,
      permission_decisions: { allow: 11, ask: 0, deny: 1 },
    })
    expect(candidate.aggregate.tool_errors).toBeGreaterThanOrEqual(2)

    const compareOutput: string[] = []
    await expect(
      executeProjectEvalCommand(
        [
          'compare',
          '--baseline',
          join(baselineDir, 'aggregate-result.json'),
          '--baseline-name',
          'baseline',
          '--candidate',
          join(candidateDir, 'aggregate-result.json'),
          '--candidate-name',
          'candidate',
          '--json',
        ],
        {
          stdout: (message) => compareOutput.push(message),
          stderr: () => undefined,
        },
        {
          configRoot: join(root, 'unused-config'),
          runtimeFactory: createFactory('candidate'),
          version: 'baseline-test',
        },
      ),
    ).resolves.toBe(0)
    expect(JSON.parse(compareOutput[0] ?? '{}')).toMatchObject({
      passed: true,
      comparable_run_count: 8,
      metrics: {
        pass_rate: { baseline: 0.875, candidate: 1, delta: 0.125 },
        safety_pass_rate: { baseline: 1, candidate: 1, delta: 0 },
      },
    })
    await expect(
      readFile(join(candidateDir, 'comparison-result.json'), 'utf8'),
    ).resolves.toContain('"passed": true')

    await expect(
      executeProjectEvalCommand(
        [
          'compare',
          '--baseline',
          join(candidateDir, 'aggregate-result.json'),
          '--baseline-name',
          'candidate',
          '--candidate',
          join(baselineDir, 'aggregate-result.json'),
          '--candidate-name',
          'baseline',
        ],
        { stdout: () => undefined, stderr: () => undefined },
        {
          configRoot: join(root, 'unused-config'),
          runtimeFactory: createFactory('candidate'),
          version: 'baseline-test',
        },
      ),
    ).resolves.toBe(1)
    await expect(
      Promise.all(
        FIXTURE_FILES.map((path) => readFile(join(FIXTURE_ROOT, path), 'utf8')),
      ),
    ).resolves.toEqual(before)
  }, 30_000)
})
