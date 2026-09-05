import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'
import { ClaudeSessionService } from '../application/session-service.js'
import type {
  ModelProvider,
  ModelRequest,
  ModelToolCall,
  PermissionResolver,
} from '../core/runtime.js'
import { FilteredToolRegistry } from '../tools/filtered-tool-registry.js'
import { LocalToolRegistry } from '../tools/local-tools.js'
import type { ApplyPatchEdit } from '../tools/apply-patch.js'
import type {
  IdentifiedEvalRuntimeFactory,
  EvalRuntimeFactoryOptions,
} from './eval-contract.js'
import { executeProjectEvalCommand } from './project-eval.js'

const APPLY_PATCH_ADMISSION_ROOT = join(
  process.cwd(),
  'test/fixtures/native/evals/apply-patch-admission',
)
const roots: string[] = []
const keptWorkspaceRoots: string[] = []
const externalEscapeFiles: string[] = []
const TEST_BUILD_IDENTITY = {
  schema_version: '1.0' as const,
  source_revision: `git:${'a'.repeat(40)}` as `git:${string}`,
  source_dirty: false,
  artifact_sha256: `sha256:${'b'.repeat(64)}` as `sha256:${string}`,
}
const loadTestBuildIdentity = async () => TEST_BUILD_IDENTITY

interface RequestCapture {
  requests: ModelRequest[]
}

function scriptedProvider(
  options: EvalRuntimeFactoryOptions,
  variant: 'baseline' | 'candidate',
): { provider: ModelProvider; capture: RequestCapture } {
  const scenario = options.env.EVAL_SCENARIO
  let turn = 0
  const requests: ModelRequest[] = []
  const provider: ModelProvider = {
    model: options.model ?? 'apply-patch-admission-model',
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
      const read = (id: string, filePath: string) => ({
        type: 'tool-call' as const,
        call: { id, name: 'Read', input: { file_path: filePath } },
      })
      const edit = (
        id: string,
        filePath: string,
        oldString: string,
        newString: string,
      ) => ({
        type: 'tool-call' as const,
        call: {
          id,
          name: 'Edit',
          input: {
            file_path: filePath,
            old_string: oldString,
            new_string: newString,
          },
        },
      })
      const applyPatch = (id: string, edits: ApplyPatchEdit[]) => ({
        type: 'tool-call' as const,
        call: { id, name: 'ApplyPatch', input: { edits } },
      })
      const finishTool = async function* (event: {
        type: 'tool-call'
        call: ModelToolCall
      }) {
        yield event
        yield { type: 'usage' as const, usage }
        yield { type: 'terminal' as const, reason: 'tool_use' as const }
      }
      const finish = async function* () {
        yield { type: 'text-delta' as const, delta: 'completed' }
        yield { type: 'usage' as const, usage }
        yield { type: 'terminal' as const, reason: 'end_turn' as const }
      }
      const cwd = options.cwd
      if (scenario === 'multi-hunk') {
        const path = join(cwd, 'settings.cjs')
        if (turn === 1) yield* finishTool(read('settings-read', path))
        else if (variant === 'baseline' && turn === 2)
          yield* finishTool(
            edit('settings-theme', path, "theme: 'light'", "theme: 'dark'"),
          )
        else if (variant === 'baseline' && turn === 3)
          yield* finishTool(
            edit('settings-retries', path, 'retries: 2', 'retries: 3'),
          )
        else if (variant === 'candidate' && turn === 2)
          yield* finishTool(
            applyPatch('settings-patch', [
              {
                file_path: path,
                old_string: "theme: 'light'",
                new_string: "theme: 'dark'",
              },
              {
                file_path: path,
                old_string: 'retries: 2',
                new_string: 'retries: 3',
              },
            ]),
          )
        else yield* finish()
        return
      }
      if (scenario === 'multi-file') {
        const alpha = join(cwd, 'alpha.txt')
        const beta = join(cwd, 'beta.txt')
        if (turn === 1) yield* finishTool(read('alpha-read', alpha))
        else if (turn === 2) yield* finishTool(read('beta-read', beta))
        else if (variant === 'baseline' && turn === 3)
          yield* finishTool(edit('alpha-edit', alpha, 'alpha=one', 'alpha=two'))
        else if (variant === 'baseline' && turn === 4)
          yield* finishTool(edit('beta-edit', beta, 'beta=one', 'beta=two'))
        else if (variant === 'candidate' && turn === 3)
          yield* finishTool(
            applyPatch('files-patch', [
              {
                file_path: alpha,
                old_string: 'alpha=one',
                new_string: 'alpha=two',
              },
              {
                file_path: beta,
                old_string: 'beta=one',
                new_string: 'beta=two',
              },
            ]),
          )
        else yield* finish()
        return
      }
      if (scenario === 'stale-context') {
        const first = join(cwd, 'first.txt')
        const second = join(cwd, 'second.txt')
        if (turn === 1) yield* finishTool(read('first-read', first))
        else if (turn === 2) yield* finishTool(read('second-read', second))
        else if (variant === 'baseline' && turn === 3)
          yield* finishTool(
            edit('first-edit', first, 'first=original', 'first=changed'),
          )
        else if (variant === 'baseline' && turn === 4)
          yield* finishTool(
            edit('stale-edit', second, 'second=stale', 'second=changed'),
          )
        else if (variant === 'baseline' && turn === 5)
          yield* finishTool(
            edit('first-rollback', first, 'first=changed', 'first=original'),
          )
        else if (variant === 'candidate' && turn === 3)
          yield* finishTool(
            applyPatch('stale-patch', [
              {
                file_path: first,
                old_string: 'first=original',
                new_string: 'first=changed',
              },
              {
                file_path: second,
                old_string: 'second=stale',
                new_string: 'second=changed',
              },
            ]),
          )
        else yield* finish()
        return
      }
      if (scenario === 'path-escape') {
        const inside = join(cwd, 'inside.txt')
        const outside = join(dirname(cwd), 'escape.txt')
        if (turn === 1) yield* finishTool(read('inside-read', inside))
        else if (variant === 'baseline' && turn === 2)
          yield* finishTool(
            edit('escape-edit', outside, 'escape=original', 'escape=changed'),
          )
        else if (variant === 'candidate' && turn === 2)
          yield* finishTool(
            applyPatch('escape-patch', [
              {
                file_path: outside,
                old_string: 'escape=original',
                new_string: 'escape=changed',
              },
            ]),
          )
        else yield* finish()
        return
      }
      yield* finish()
    },
  }
  return { provider, capture: { requests } }
}

function createFactory(
  variant: 'baseline' | 'candidate',
): IdentifiedEvalRuntimeFactory {
  return {
    identify: async (options) => ({
      providerId: 'test-provider',
      profileId: 'default',
      protocol: 'openai-compatible',
      endpoint: 'https://eval.test/v1',
      modelId: options.model ?? 'apply-patch-admission-model',
    }),
    create: async (options) => {
      const scripted = scriptedProvider(options, variant)
      if (options.env.EVAL_SCENARIO === 'path-escape') {
        const external = join(dirname(options.cwd), 'escape.txt')
        await writeFile(external, 'escape=original\n', 'utf8')
        externalEscapeFiles.push(external)
      }
      const basePermissions: PermissionResolver = {
        resolve: () => ({ behavior: 'allow' }),
      }
      const permissions: PermissionResolver = basePermissions
      const base = new LocalToolRegistry({
        cwd: options.cwd,
        dataPlane: 'native',
        homeDirectory: options.home,
        configRoot: options.configRoot,
      })
      expect(
        base
          .definitions()
          .filter((definition) => definition.name === 'ApplyPatch'),
      ).toHaveLength(1)
      const registry = base
      const selectedTools = options.allowedTools.filter(
        (name) => variant === 'candidate' || name !== 'ApplyPatch',
      )
      const tools = new FilteredToolRegistry(registry, { tools: selectedTools })
      const service = new ClaudeSessionService({
        configRoot: options.configRoot,
        dataPlane: 'native',
        cwd: options.cwd,
        claudeVersion: '2.1.208',
        provider: scripted.provider,
        tools,
        permissions,
        maxModelTurns: options.maxTurns,
        sessionPersistence: true,
        eventSink: options.eventSink,
      })
      return {
        run: async (prompt, signal) => {
          const result = await service.run(prompt, signal)
          return {
            text: result.text,
            usage: result.usage,
            turns: Math.max(1, scripted.capture.requests.length),
            ...(result.costUsd === undefined
              ? {}
              : { costUsd: result.costUsd }),
          }
        },
        close: () => service.close(),
      }
    },
  }
}

interface EvalAggregate {
  schema_version: '1.2'
  run_count: number
  passed: number
  safety_passed: number
  safety_failed: number
  retries: number
  tool_errors: number
  permission_decisions: { allow: number; ask: number; deny: number }
  terminations: { completed: number; timeout: number; interrupted: number }
  verification_totals: {
    declared: number
    passed: number
    failed: number
    not_run: number
    satisfied_runs: number
    unsatisfied_runs: number
  }
  risk_tiers: Record<string, { runs: number; passed: number; failed: number }>
  output_dir: string
  runs: { case: string; run: number; artifact_dir: string }[]
}

async function runEval(variant: 'baseline' | 'candidate', outputDir: string) {
  const output: string[] = []
  const code = await executeProjectEvalCommand(
    [
      APPLY_PATCH_ADMISSION_ROOT,
      '--allow-tools',
      'Edit,ApplyPatch',
      '--run-verification',
      '--keep-temp',
      '--output-dir',
      outputDir,
      '--json',
    ],
    { stdout: (message) => output.push(message), stderr: () => undefined },
    {
      configRoot: join(outputDir, 'config'),
      loadBuildIdentity: loadTestBuildIdentity,
      runtimeFactory: createFactory(variant),
      version: 'apply-patch-admission-test',
    },
  )
  return {
    code,
    aggregate: JSON.parse(output.at(-1) ?? '{}') as EvalAggregate,
  }
}

async function inspectAggregate(
  aggregate: EvalAggregate,
  variant: 'baseline' | 'candidate',
) {
  expect(aggregate).toMatchObject({
    run_count: 4,
    passed: 4,
    safety_passed: 4,
    safety_failed: 0,
    retries: 0,
    tool_errors: 2,
    permission_decisions: { ask: 0, deny: 0 },
    terminations: { completed: 4, timeout: 0, interrupted: 0 },
    verification_totals: {
      declared: 4,
      passed: 4,
      failed: 0,
      not_run: 0,
      satisfied_runs: 4,
      unsatisfied_runs: 0,
    },
    risk_tiers: {
      medium: { runs: 1, passed: 1, failed: 0 },
      high: { runs: 3, passed: 3, failed: 0 },
    },
  })
  for (const run of aggregate.runs) {
    const artifactDir = join(aggregate.output_dir, run.artifact_dir)
    const trace = (await readFile(join(artifactDir, 'trace.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string
            tool?: string
            isError?: boolean
          },
      )
    const result = JSON.parse(
      await readFile(join(artifactDir, 'result.json'), 'utf8'),
    ) as {
      temp_root: string | null
      passed: boolean
      safety_passed: boolean
      tool_errors: number
      retries: number
    }
    expect(result).toMatchObject({
      passed: true,
      safety_passed: true,
      tool_errors:
        run.case === 'path-escape' || run.case === 'stale-context' ? 1 : 0,
      retries: 0,
    })
    expect(result.temp_root).toBeTruthy()
    if (result.temp_root) keptWorkspaceRoots.push(result.temp_root)
    await expect(
      readFile(join(artifactDir, 'workspace-diff.json'), 'utf8'),
    ).resolves.toContain('schema_version')
    await expect(
      readFile(join(artifactDir, 'verification.json'), 'utf8'),
    ).resolves.toContain('schema_version')
    await expect(
      readFile(join(artifactDir, 'result.json'), 'utf8'),
    ).resolves.toContain('schema_version')
    const toolCalls = trace
      .filter((event) => event.type === 'tool-call')
      .map((event) => event.tool)
    const errors = trace.filter(
      (event) => event.type === 'tool-result' && event.isError === true,
    )
    if (run.case === 'multi-hunk')
      expect(toolCalls).toEqual(
        variant === 'baseline'
          ? ['Read', 'Edit', 'Edit']
          : ['Read', 'ApplyPatch'],
      )
    if (run.case === 'multi-file')
      expect(toolCalls).toEqual(
        variant === 'baseline'
          ? ['Read', 'Read', 'Edit', 'Edit']
          : ['Read', 'Read', 'ApplyPatch'],
      )
    if (run.case === 'stale-context') {
      expect(toolCalls).toEqual(
        variant === 'baseline'
          ? ['Read', 'Read', 'Edit', 'Edit', 'Edit']
          : ['Read', 'Read', 'ApplyPatch'],
      )
      expect(errors).toHaveLength(1)
    }
    if (run.case === 'path-escape') {
      expect(toolCalls).toEqual(
        variant === 'baseline' ? ['Read', 'Edit'] : ['Read', 'ApplyPatch'],
      )
      expect(errors).toHaveLength(1)
      await expect(
        readFile(join(result.temp_root ?? '', 'cwd', 'inside.txt'), 'utf8'),
      ).resolves.toBe('inside=original\n')
    }
    const diff = JSON.parse(
      await readFile(join(artifactDir, 'workspace-diff.json'), 'utf8'),
    ) as { changed: string[] }
    const workspace = join(result.temp_root ?? '', 'cwd')
    if (run.case === 'multi-hunk') {
      expect(diff.changed).toEqual(['settings.cjs'])
      await expect(
        readFile(join(workspace, 'settings.cjs'), 'utf8'),
      ).resolves.toBe(
        "/* global module */\nmodule.exports = { theme: 'dark', retries: 3 }\n",
      )
    } else if (run.case === 'multi-file') {
      expect(diff.changed).toEqual(['alpha.txt', 'beta.txt'])
      await expect(
        readFile(join(workspace, 'alpha.txt'), 'utf8'),
      ).resolves.toBe('alpha=two\n')
      await expect(readFile(join(workspace, 'beta.txt'), 'utf8')).resolves.toBe(
        'beta=two\n',
      )
    } else if (run.case === 'stale-context') {
      expect(diff.changed).toEqual([])
      await expect(
        readFile(join(workspace, 'first.txt'), 'utf8'),
      ).resolves.toBe('first=original\n')
      await expect(
        readFile(join(workspace, 'second.txt'), 'utf8'),
      ).resolves.toBe('second=original\n')
    } else {
      expect(diff.changed).toEqual([])
    }
  }
}

describe('ApplyPatch admission eval', () => {
  afterAll(async () => {
    await Promise.all(
      [...new Set([...roots, ...keptWorkspaceRoots])].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    )
  })

  it('validates the bounded production tool and its safety boundaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-apply-patch-unit-'))
    roots.push(root)
    const base = new LocalToolRegistry({
      cwd: root,
      dataPlane: 'native',
      homeDirectory: join(root, 'home'),
      configRoot: join(root, 'config'),
    })
    expect(
      base
        .definitions()
        .filter((definition) => definition.name === 'ApplyPatch'),
    ).toHaveLength(1)
    const definition = base
      .definitions()
      .find((item) => item.name === 'ApplyPatch')
    expect(definition?.inputSchema).toMatchObject({
      additionalProperties: false,
      properties: { edits: { items: { additionalProperties: false } } },
    })
    expect(
      base.schedulingPolicy({
        id: 'policy',
        name: 'ApplyPatch',
        input: {},
      }),
    ).toEqual({ concurrency: 'exclusive', cancelOnInterrupt: true })
    const context = { cwd: root }
    await expect(
      base.prepare(
        { id: 'empty', name: 'ApplyPatch', input: { edits: [] } },
        context,
      ),
    ).rejects.toThrow()
    await expect(
      base.prepare(
        {
          id: 'too-many',
          name: 'ApplyPatch',
          input: {
            edits: Array.from({ length: 33 }, () => ({
              file_path: 'a',
              old_string: 'x',
              new_string: 'y',
            })),
          },
        },
        context,
      ),
    ).rejects.toThrow()
    await expect(
      base.prepare(
        {
          id: 'large',
          name: 'ApplyPatch',
          input: {
            edits: [
              {
                file_path: 'a',
                old_string: 'x',
                new_string: 'y'.repeat(256 * 1024),
              },
            ],
          },
        },
        context,
      ),
    ).rejects.toThrow('256 KiB')
    await expect(
      base.prepare(
        {
          id: 'empty-old',
          name: 'ApplyPatch',
          input: {
            edits: [{ file_path: 'a', old_string: '', new_string: 'y' }],
          },
        },
        context,
      ),
    ).rejects.toThrow('old_string')
    await expect(
      base.prepare(
        {
          id: 'equal',
          name: 'ApplyPatch',
          input: {
            edits: [{ file_path: 'a', old_string: 'same', new_string: 'same' }],
          },
        },
        context,
      ),
    ).rejects.toThrow('differ')
    const nonUniquePath = join(root, 'non-unique.txt')
    await writeFile(nonUniquePath, 'duplicate duplicate\n', 'utf8')
    const nonUniqueCall: ModelToolCall = {
      id: 'non-unique',
      name: 'ApplyPatch',
      input: {
        edits: [
          {
            file_path: nonUniquePath,
            old_string: 'duplicate',
            new_string: 'changed',
          },
        ],
      },
    }
    const nonUniqueContext = {
      cwd: root,
      messages: [
        {
          role: 'assistant' as const,
          content: '',
          toolCalls: [
            {
              id: 'non-unique-read',
              name: 'Read' as const,
              input: { file_path: nonUniquePath },
            },
          ],
        },
        {
          role: 'tool' as const,
          toolCallId: 'non-unique-read',
          content: 'duplicate duplicate',
          isError: false,
        },
      ],
    }
    const nonUniquePrepared = await base.prepare(
      nonUniqueCall,
      nonUniqueContext,
    )
    await expect(
      base.execute(nonUniquePrepared, nonUniqueContext),
    ).rejects.toThrow('exactly once')
    await expect(readFile(nonUniquePath, 'utf8')).resolves.toBe(
      'duplicate duplicate\n',
    )

    const protectedPath = join(root, 'config', 'protected.txt')
    await mkdir(dirname(protectedPath), { recursive: true })
    await writeFile(protectedPath, 'protected=original\n', 'utf8')
    await expect(
      base.prepare(
        {
          id: 'protected',
          name: 'ApplyPatch',
          input: {
            edits: [
              {
                file_path: protectedPath,
                old_string: 'protected=original',
                new_string: 'protected=changed',
              },
            ],
          },
        },
        context,
      ),
    ).rejects.toThrow()
    const unreadPath = join(root, 'unread.txt')
    await writeFile(unreadPath, 'unread=original\n', 'utf8')
    await expect(
      base.prepare(
        {
          id: 'unread',
          name: 'ApplyPatch',
          input: {
            edits: [
              {
                file_path: unreadPath,
                old_string: 'unread=original',
                new_string: 'unread=changed',
              },
            ],
          },
        },
        context,
      ),
    ).rejects.toThrow('not been read')
  })

  it('compares Edit baseline and ApplyPatch candidate across four project eval cases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-apply-patch-admission-'))
    roots.push(root)
    const baselineDir = join(root, 'baseline')
    const candidateDir = join(root, 'candidate')
    await mkdir(baselineDir, { recursive: true })
    await mkdir(candidateDir, { recursive: true })
    const baseline = await runEval('baseline', baselineDir)
    const candidate = await runEval('candidate', candidateDir)
    expect(baseline.code).toBe(0)
    expect(candidate.code).toBe(0)
    await inspectAggregate(baseline.aggregate, 'baseline')
    await inspectAggregate(candidate.aggregate, 'candidate')
    expect(candidate.aggregate.permission_decisions.allow).toBeLessThanOrEqual(
      baseline.aggregate.permission_decisions.allow,
    )
    expect(candidate.aggregate.permission_decisions.ask).toBeLessThanOrEqual(
      baseline.aggregate.permission_decisions.ask,
    )
    expect(candidate.aggregate.permission_decisions.deny).toBeLessThanOrEqual(
      baseline.aggregate.permission_decisions.deny,
    )
    for (const external of externalEscapeFiles)
      await expect(readFile(external, 'utf8')).resolves.toBe(
        'escape=original\n',
      )
    const comparisonOutput: string[] = []
    const compareCode = await executeProjectEvalCommand(
      [
        'compare',
        '--baseline',
        join(baselineDir, 'aggregate-result.json'),
        '--baseline-name',
        'edit',
        '--candidate',
        join(candidateDir, 'aggregate-result.json'),
        '--candidate-name',
        'apply-patch',
        '--json',
      ],
      {
        stdout: (message) => comparisonOutput.push(message),
        stderr: () => undefined,
      },
      {
        configRoot: join(root, 'unused-config'),
        loadBuildIdentity: loadTestBuildIdentity,
        runtimeFactory: createFactory('candidate'),
        version: 'apply-patch-admission-test',
      },
    )
    expect(compareCode).toBe(0)
    const comparison = JSON.parse(comparisonOutput.at(-1) ?? '{}') as {
      schema_version: string
      passed: boolean
      regressions: unknown[]
      metrics: {
        pass_rate: { delta: number }
        safety_pass_rate: { delta: number }
        average_turns: { delta: number }
        tool_errors: { delta: number }
        retries: { delta: number }
        terminations: { completed: { delta: number } }
        average_duration_ms: { baseline: number; candidate: number }
      }
    }
    expect(comparison).toMatchObject({
      schema_version: '1.2',
      passed: true,
      regressions: [],
      metrics: {
        pass_rate: { delta: 0 },
        safety_pass_rate: { delta: 0 },
        tool_errors: { delta: 0 },
        retries: { delta: 0 },
        terminations: { completed: { delta: 0 } },
      },
    })
    expect(comparison.metrics.average_turns.delta).toBeLessThan(0)
    expect(
      Number.isFinite(comparison.metrics.average_duration_ms.baseline),
    ).toBe(true)
    expect(
      Number.isFinite(comparison.metrics.average_duration_ms.candidate),
    ).toBe(true)
    expect(
      comparison.metrics.average_duration_ms.baseline,
    ).toBeGreaterThanOrEqual(0)
    expect(
      comparison.metrics.average_duration_ms.candidate,
    ).toBeGreaterThanOrEqual(0)
    await expect(
      readFile(join(baselineDir, 'aggregate-result.json'), 'utf8'),
    ).resolves.toContain('schema_version')
    await expect(
      readFile(join(candidateDir, 'aggregate-result.json'), 'utf8'),
    ).resolves.toContain('schema_version')
    await expect(
      readFile(join(candidateDir, 'comparison-result.json'), 'utf8'),
    ).resolves.toContain('"passed": true')
  }, 30_000)
})
