import {
  lstat,
  opendir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
  mkdir,
  rename,
  symlink,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'
import { minimatch } from 'minimatch'
import { ClaudeSessionService } from '../application/session-service.js'
import type {
  ModelProvider,
  ModelRequest,
  ModelToolCall,
  PermissionResolver,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from '../core/runtime.js'
import { FilteredToolRegistry } from '../tools/filtered-tool-registry.js'
import { LocalToolRegistry } from '../tools/local-tools.js'
import {
  BoundedProcessRunner,
  type ProcessResult,
} from '../platform/bounded-process-runner.js'
import {
  RipgrepGlobSearch,
  type GlobSearch,
  type GlobSearchRequest,
  type GlobSearchResult,
  type RipgrepGlobSearchOptions,
} from '../tools/glob.js'
import type { LocalToolRegistryOptions } from '../tools/local-tools.js'
import type {
  IdentifiedEvalRuntimeFactory,
  EvalRuntimeFactoryOptions,
} from './eval-contract.js'
import { executeProjectEvalCommand } from './project-eval.js'

const FIXTURE_ROOT = join(
  process.cwd(),
  'test/fixtures/native/evals/glob-ripgrep-admission',
)
const roots: string[] = []
const keptWorkspaceRoots: string[] = []
const MAX_RESULTS = 100
const TEST_BUILD_IDENTITY = {
  schema_version: '1.0' as const,
  source_revision: `git:${'a'.repeat(40)}` as `git:${string}`,
  source_dirty: false,
  artifact_sha256: `sha256:${'b'.repeat(64)}` as `sha256:${string}`,
}
const loadTestBuildIdentity = async () => TEST_BUILD_IDENTITY

interface LegacyGlobMatch {
  path: string
  mtimeMs: number
  order: number
}

function compareLegacyMatches(
  left: LegacyGlobMatch,
  right: LegacyGlobMatch,
): number {
  return left.mtimeMs - right.mtimeMs || left.order - right.order
}

function insertOldestLegacy(
  matches: LegacyGlobMatch[],
  candidate: LegacyGlobMatch,
): void {
  let low = 0
  let high = matches.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    const current = matches[middle]
    if (current && compareLegacyMatches(current, candidate) <= 0)
      low = middle + 1
    else high = middle
  }
  matches.splice(low, 0, candidate)
  if (matches.length > MAX_RESULTS) matches.pop()
}

async function legacyGlobFiles(options: GlobSearchRequest): Promise<string> {
  const pattern = portable(options.pattern)
  const absolutePattern = isAbsolute(options.pattern)
  const matchBase = !absolutePattern && !pattern.includes('/')
  const matches: LegacyGlobMatch[] = []
  const directories = ['']
  let count = 0
  let order = 0
  while (directories.length) {
    if (options.signal?.aborted)
      throw new DOMException('Tool execution aborted', 'AbortError')
    const relativeDirectory = directories.pop() ?? ''
    const directory = await opendir(join(options.root, relativeDirectory))
    for await (const entry of directory) {
      if (options.signal?.aborted)
        throw new DOMException('Tool execution aborted', 'AbortError')
      const relativePath = join(relativeDirectory, entry.name)
      if (entry.isDirectory()) {
        directories.push(relativePath)
        continue
      }
      if (!entry.isFile()) continue
      const rel = portable(relativePath)
      const absolute = portable(resolve(options.absoluteRoot, rel))
      if (
        pattern &&
        !minimatch(absolutePattern ? absolute : rel, pattern, {
          dot: true,
          matchBase,
          noext: true,
        })
      )
        continue
      let metadata
      try {
        metadata = await lstat(join(options.root, relativePath))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      if (!metadata.isFile()) continue
      const path = absolutePattern
        ? absolute
        : portable(join(options.displayRoot, rel))
      insertOldestLegacy(matches, { path, mtimeMs: metadata.mtimeMs, order })
      order += 1
      count += 1
    }
  }
  if (!count) return 'No files found'
  const content = matches.map((match) => match.path).join('\n')
  return count > MAX_RESULTS
    ? `${content}\n(Showing 100 of ${count} matching files; ${count - 100} more are not listed. Narrow the pattern or path to see the rest.)`
    : content
}

class LegacyGlobSearch implements GlobSearch {
  async search(request: GlobSearchRequest): Promise<GlobSearchResult> {
    return { content: await legacyGlobFiles(request), isError: false }
  }
}

function portable(value: string): string {
  return sep === '/' ? value : value.split(sep).join('/')
}

type CandidateRunner = NonNullable<RipgrepGlobSearchOptions['runner']>

class ControllableCandidateRunner implements CandidateRunner {
  private failNext = false

  constructor(private readonly real: BoundedProcessRunner) {}

  armFailure(): void {
    this.failNext = true
  }

  run(options: Parameters<CandidateRunner['run']>[0]): Promise<ProcessResult> {
    if (this.failNext) {
      this.failNext = false
      return Promise.resolve({
        stdout: '',
        stderr: 'injected failure',
        output: 'injected failure',
        code: 2,
        timedOut: false,
        truncated: false,
      })
    }
    return this.real.run(options)
  }
}

function createProductionGlobRegistry(
  options: Omit<LocalToolRegistryOptions, 'globSearch'>,
  environment: Readonly<Record<string, string>> = {},
  runner?: CandidateRunner,
): LocalToolRegistry {
  return new LocalToolRegistry({
    ...options,
    globSearch: new RipgrepGlobSearch({
      cwd: options.cwd,
      timeoutMs: 120_000,
      environment,
      ...(runner ? { runner } : {}),
    }),
  })
}

class ScopeProbeRegistry implements ToolRegistry {
  constructor(
    private readonly base: ToolRegistry,
    private readonly variant: 'baseline' | 'candidate',
    private readonly candidateRunner?: ControllableCandidateRunner,
  ) {}

  definitions() {
    return this.base.definitions()
  }

  schedulingPolicy(call: ModelToolCall) {
    return (
      this.base.schedulingPolicy?.(call) ?? {
        concurrency: 'exclusive' as const,
      }
    )
  }

  prepare(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ModelToolCall> {
    return this.base.prepare(call, context)
  }

  async execute(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (call.name !== 'Glob' || context.signal?.aborted)
      return this.base.execute(call, context)
    if (call.id === 'scope-cancelled') {
      const controller = new AbortController()
      controller.abort()
      return this.base.execute(call, { ...context, signal: controller.signal })
    }
    if (call.id === 'scope-failed') {
      if (this.variant === 'baseline')
        throw new Error(
          'Glob enumeration failed with exit code 2: injected failure',
        )
      this.candidateRunner?.armFailure()
    }
    return this.base.execute(call, context)
  }
}

function toolCall(
  id: string,
  name: 'Glob' | 'Bash',
  input: Record<string, unknown>,
) {
  return {
    type: 'tool-call' as const,
    call: { id, name, input } as ModelToolCall,
  }
}

function requestText(request: ModelRequest): string {
  return JSON.stringify(request.messages)
}

function scriptedProvider(options: EvalRuntimeFactoryOptions): {
  provider: ModelProvider
  requests: ModelRequest[]
} {
  const scenario = options.env.EVAL_SCENARIO
  const requests: ModelRequest[] = []
  let turn = 0
  const provider: ModelProvider = {
    model: 'glob-ripgrep-admission-model',
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
      const saw = (text: string) => requestText(request).includes(text)
      if (scenario === 'default-semantics') {
        if (turn === 1)
          yield* finishTool(toolCall('glob', 'Glob', { pattern: '*.ts' }))
        else if (saw('normal.ts') && saw('ignored.ts') && saw('.hidden.ts'))
          yield* finish()
        else yield* finish()
      } else if (scenario === 'ignore-filter') {
        if (turn === 1)
          yield* finishTool(toolCall('glob', 'Glob', { pattern: '*.ts' }))
        else if (!saw('target.ts'))
          yield* finishTool(
            toolCall('fallback', 'Bash', {
              command: "rg --files --hidden --no-ignore -g '*.ts'",
            }),
          )
        else yield* finish()
      } else if (scenario === 'hidden-filter') {
        if (turn === 1)
          yield* finishTool(toolCall('glob', 'Glob', { pattern: '*.ts' }))
        else if (!saw('visible.ts'))
          yield* finishTool(
            toolCall('fallback', 'Bash', {
              command: "rg --files --hidden --no-ignore -g '*.ts'",
            }),
          )
        else yield* finish()
      } else if (scenario === 'scope-safety') {
        const resultText = requestText(request)
        if (turn === 1 && !resultText.includes('additional.ts'))
          yield* finishTool(
            toolCall('scope-additional', 'Glob', {
              pattern: '*.ts',
              path: join(options.cwd, '..', 'glob-additional'),
            }),
          )
        else if (turn === 2 && resultText.includes('additional.ts'))
          yield* finishTool(
            toolCall('scope-forbidden', 'Glob', {
              pattern: '*.ts',
              path: join(options.cwd, '..', 'glob-forbidden'),
            }),
          )
        else if (turn === 3 && resultText.includes('outside workspace'))
          yield* finishTool(
            toolCall('scope-symlink', 'Glob', {
              pattern: 'scope-link/**/*.ts',
            }),
          )
        else if (turn === 4 && resultText.includes('No files found'))
          yield* finishTool(
            toolCall('scope-cancelled', 'Glob', { pattern: '*.ts' }),
          )
        else if (turn === 5 && resultText.includes('aborted'))
          yield* finishTool(
            toolCall('scope-failed', 'Glob', { pattern: '*.ts' }),
          )
        else if (turn === 6 && resultText.includes('Glob enumeration failed'))
          yield* finishTool(
            toolCall('scope-inside', 'Glob', { pattern: '*.ts' }),
          )
        else if (turn === 7 && resultText.includes('inside.ts')) yield* finish()
        else yield* finish()
      } else yield* finish()
    },
  }
  return { provider, requests }
}

async function setupDynamic(
  options: EvalRuntimeFactoryOptions,
): Promise<() => Promise<void>> {
  const scenario = options.env.EVAL_SCENARIO
  const created: string[] = []
  const make = async (name: string, mtime: number) => {
    const path = join(options.cwd, name)
    await writeFile(path, `${name}\n`, 'utf8')
    await utimes(path, new Date(mtime), new Date(mtime))
    created.push(path)
  }
  const now = Date.now()
  if (scenario === 'default-semantics') {
    await writeFile(join(options.cwd, '.ignore'), 'ignored.ts\n', 'utf8')
    created.push(join(options.cwd, '.ignore'))
    await make('normal.ts', now - 3_000)
    await make('ignored.ts', now - 2_000)
    await make('.hidden.ts', now - 1_000)
  } else if (scenario === 'ignore-filter') {
    await writeFile(join(options.cwd, '.gitignore'), 'ignored-*.ts\n', 'utf8')
    created.push(join(options.cwd, '.gitignore'))
    await writeFile(join(options.cwd, '.ignore'), 'ignored-*.ts\n', 'utf8')
    created.push(join(options.cwd, '.ignore'))
    await make('target.ts', now + 2_000)
    for (let i = 0; i < 101; i += 1)
      await make(`ignored-${String(i).padStart(3, '0')}.ts`, now - 10_000 - i)
  } else if (scenario === 'hidden-filter') {
    await make('visible.ts', now + 2_000)
    for (let i = 0; i < 101; i += 1)
      await make(`.hidden-${String(i).padStart(3, '0')}.ts`, now - 10_000 - i)
  } else if (scenario === 'scope-safety') {
    await make('inside.ts', now)
    const additionalRoot = join(dirname(options.cwd), 'glob-additional')
    const forbiddenRoot = join(dirname(options.cwd), 'glob-forbidden')
    await mkdir(additionalRoot)
    await mkdir(forbiddenRoot)
    created.push(additionalRoot, forbiddenRoot)
    await writeFile(
      join(additionalRoot, 'additional.ts'),
      'additional\n',
      'utf8',
    )
    await writeFile(join(forbiddenRoot, 'forbidden.ts'), 'forbidden\n', 'utf8')
    created.push(
      join(additionalRoot, 'additional.ts'),
      join(forbiddenRoot, 'forbidden.ts'),
    )
    const symlinkPath = join(options.cwd, 'scope-link')
    await symlink(additionalRoot, symlinkPath)
    created.push(symlinkPath)
  }
  return async () => {
    for (const path of [...created].reverse())
      await rm(path, { recursive: true, force: true })
  }
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
      modelId: options.model ?? 'glob-ripgrep-admission-model',
    }),
    create: async (options) => {
      const cleanup = await setupDynamic(options)
      const scripted = scriptedProvider(options)
      const globEnv: Record<string, string> = {}
      const hidden = options.env.EVAL_CLAUDE_CODE_GLOB_HIDDEN
      const noIgnore = options.env.EVAL_CLAUDE_CODE_GLOB_NO_IGNORE
      if (hidden !== undefined) globEnv.CLAUDE_CODE_GLOB_HIDDEN = hidden
      if (noIgnore !== undefined) globEnv.CLAUDE_CODE_GLOB_NO_IGNORE = noIgnore
      const candidateRunner =
        variant === 'candidate'
          ? new ControllableCandidateRunner(
              new BoundedProcessRunner({
                cwd: options.cwd,
                maxOutputBytes: 2 * 1024 * 1024,
              }),
            )
          : undefined
      const registryOptions = {
        cwd: options.cwd,
        dataPlane: 'native' as const,
        additionalDirectories:
          options.env.EVAL_SCENARIO === 'scope-safety'
            ? [join(dirname(options.cwd), 'glob-additional')]
            : [],
        homeDirectory: options.home,
        configRoot: options.configRoot,
      }
      const globRegistry: ToolRegistry =
        variant === 'candidate'
          ? createProductionGlobRegistry(
              registryOptions,
              globEnv,
              candidateRunner,
            )
          : new LocalToolRegistry({
              ...registryOptions,
              globSearch: new LegacyGlobSearch(),
            })
      const registry: ToolRegistry =
        options.env.EVAL_SCENARIO === 'scope-safety'
          ? new ScopeProbeRegistry(globRegistry, variant, candidateRunner)
          : globRegistry
      const tools = new FilteredToolRegistry(registry, {
        tools: options.allowedTools,
      })
      const permissions: PermissionResolver = {
        resolve: (call) =>
          options.env.EVAL_SCENARIO === 'scope-safety' &&
          call.id === 'scope-forbidden'
            ? {
                behavior: 'deny',
                reason: 'Path is outside workspace and was not authorized',
              }
            : { behavior: 'allow' },
      }
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
            turns: Math.max(1, scripted.requests.length),
            usage: result.usage,
          }
        },
        close: async () => {
          try {
            await service.close()
          } finally {
            await cleanup()
          }
        },
      }
    },
  }
}

interface Aggregate {
  schema_version: '1.0'
  output_dir: string
  run_count: number
  passed: number
  safety_passed: number
  safety_failed: number
  total_turns: number
  permission_decisions: { allow: number; ask: number; deny: number }
  tool_errors: number
  retries: number
  terminations: { completed: number; timeout: number; interrupted: number }
  runs: { case: string; run: number; turns: number; artifact_dir: string }[]
}

async function runEval(variant: 'baseline' | 'candidate', outputDir: string) {
  const output: string[] = []
  const code = await executeProjectEvalCommand(
    [
      FIXTURE_ROOT,
      '--allow-tools',
      'Bash',
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
      version: 'glob-ripgrep-admission-test',
    },
  )
  const aggregate = JSON.parse(output.at(-1) ?? '{}') as Aggregate
  for (const run of aggregate.runs) {
    const result = JSON.parse(
      await readFile(
        join(aggregate.output_dir, run.artifact_dir, 'result.json'),
        'utf8',
      ),
    ) as { temp_root?: string }
    if (result.temp_root) keptWorkspaceRoots.push(result.temp_root)
  }
  return { code, aggregate }
}

async function inspectAggregate(
  aggregate: Aggregate,
  variant: 'baseline' | 'candidate',
) {
  for (const run of aggregate.runs) {
    const artifactDir = join(aggregate.output_dir, run.artifact_dir)
    const result = JSON.parse(
      await readFile(join(artifactDir, 'result.json'), 'utf8'),
    ) as {
      passed: boolean
      safety_passed: boolean
      cleanup_errors: string[]
      temp_root: string | null
    }
    expect(result).toMatchObject({
      passed: true,
      safety_passed: true,
      cleanup_errors: [],
    })
    expect(result.temp_root).toBeTruthy()
    const verifications = JSON.parse(
      await readFile(join(artifactDir, 'verification.json'), 'utf8'),
    ) as Array<{
      schema_version: string
      passed: boolean
      exit_code: number | null
      timed_out: boolean
      error: string | null
    }>
    expect(verifications).toHaveLength(1)
    expect(verifications[0]).toMatchObject({
      schema_version: '1.0',
      passed: true,
      exit_code: 0,
      timed_out: false,
      error: null,
    })
    for (const artifact of [
      'trace.jsonl',
      'workspace-diff.json',
      'verification.json',
      'result.json',
    ])
      await expect(
        readFile(join(artifactDir, artifact), 'utf8'),
      ).resolves.toBeTruthy()
    const diff = JSON.parse(
      await readFile(join(artifactDir, 'workspace-diff.json'), 'utf8'),
    ) as { changed: string[] }
    expect(diff.changed).toEqual([])
    const trace = (await readFile(join(artifactDir, 'trace.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string
            tool?: string
            id?: string
            callId?: string
            content?: string
            isError?: boolean
          },
      )
    const calls = trace
      .filter((event) => event.type === 'tool-call')
      .map((event) => ({ tool: event.tool, id: event.id }))
    const expected =
      run.case === 'default-semantics'
        ? ['Glob']
        : run.case === 'scope-safety'
          ? ['Glob', 'Glob', 'Glob', 'Glob', 'Glob', 'Glob']
          : variant === 'baseline'
            ? ['Glob', 'Bash']
            : ['Glob']
    expect(calls.map((call) => call.tool)).toEqual(expected)
    const content = trace
      .filter((event) => event.type === 'tool-result')
      .map((event) => event.content ?? '')
      .join('\n')
    if (run.case === 'default-semantics') {
      const results = trace
        .filter((event) => event.type === 'tool-result')
        .map((event) => event.content ?? '')
      expect(results[0]).toBe('normal.ts\nignored.ts\n.hidden.ts')
    }
    if (run.case === 'scope-safety')
      expect(calls.map((call) => call.id)).toEqual([
        'scope-additional',
        'scope-forbidden',
        'scope-symlink',
        'scope-cancelled',
        'scope-failed',
        'scope-inside',
      ])
    if (run.case === 'scope-safety') {
      const results = new Map(
        trace
          .filter((event) => event.type === 'tool-result')
          .map((event) => [event.callId, event]),
      )
      expect(results.get('scope-additional')).toMatchObject({
        isError: false,
        content: expect.stringContaining('additional.ts'),
      })
      expect(results.get('scope-forbidden')).toMatchObject({ isError: true })
      expect(results.get('scope-symlink')).toEqual(
        expect.objectContaining({ isError: false, content: 'No files found' }),
      )
      expect(results.get('scope-cancelled')).toMatchObject({
        isError: true,
        content: expect.stringContaining('aborted'),
      })
      expect(results.get('scope-failed')).toMatchObject({
        isError: true,
        content: expect.stringContaining('Glob enumeration failed'),
      })
      expect(results.get('scope-inside')).toMatchObject({
        isError: false,
        content: expect.stringContaining('inside.ts'),
      })
      const tempRoot = result.temp_root ?? ''
      await expect(lstat(join(tempRoot, 'glob-additional'))).rejects.toThrow()
      await expect(lstat(join(tempRoot, 'glob-forbidden'))).rejects.toThrow()
      await expect(lstat(join(tempRoot, 'cwd', 'scope-link'))).rejects.toThrow()
    }
    if (run.case === 'ignore-filter' || run.case === 'hidden-filter') {
      const target = run.case === 'ignore-filter' ? 'target.ts' : 'visible.ts'
      const distractor =
        run.case === 'ignore-filter' ? 'ignored-000.ts' : '.hidden-000.ts'
      const results = trace
        .filter((event) => event.type === 'tool-result')
        .map((event) => event.content ?? '')
      expect(content).toContain(target)
      expect(variant === 'candidate' ? results[0] : results[1]).toContain(
        target,
      )
      if (variant === 'baseline') expect(results[0]).not.toContain(target)
      if (variant === 'candidate') expect(content).not.toContain(distractor)
    }
  }
}

describe('Glob ripgrep admission eval', () => {
  afterAll(async () => {
    await Promise.all(
      [...new Set([...roots, ...keptWorkspaceRoots])].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    )
  })

  it('preserves Glob semantics and fails closed across process and scope boundaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-glob-ripgrep-unit-'))
    roots.push(root)
    const sibling = await mkdtemp(
      join(tmpdir(), 'praxis-glob-ripgrep-additional-'),
    )
    roots.push(sibling)
    await mkdir(join(root, 'extra'))
    await writeFile(join(root, 'a.ts'), 'a\n', 'utf8')
    await writeFile(join(root, '.hidden.ts'), 'h\n', 'utf8')
    await writeFile(join(root, 'extra', 'b.ts'), 'b\n', 'utf8')
    await writeFile(join(sibling, 'b.ts'), 'b\n', 'utf8')
    await mkdir(join(sibling, 'symlink-target'))
    await writeFile(
      join(sibling, 'symlink-target', 'outside.ts'),
      'outside\n',
      'utf8',
    )
    await symlink(join(sibling, 'symlink-target'), join(root, 'link-dir'))
    const base = createProductionGlobRegistry({
      cwd: root,
      dataPlane: 'native',
      additionalDirectories: [join(root, 'extra'), sibling],
      homeDirectory: join(root, 'home'),
      configRoot: join(root, 'config'),
    })
    const candidate = base
    const context: ToolExecutionContext = { cwd: root }
    const result = await candidate.execute(
      await candidate.prepare(
        { id: 'glob', name: 'Glob', input: { pattern: '*.ts' } },
        context,
      ),
      context,
    )
    expect(result.content).toContain('a.ts')
    expect(result.content).toContain('.hidden.ts')
    const emptyRoot = await mkdtemp(
      join(tmpdir(), 'praxis-glob-ripgrep-empty-'),
    )
    roots.push(emptyRoot)
    const emptyCandidate = createProductionGlobRegistry({
      cwd: emptyRoot,
      dataPlane: 'native',
      homeDirectory: join(emptyRoot, 'home'),
      configRoot: join(emptyRoot, 'config'),
    })
    const emptyResult = await emptyCandidate.execute(
      await emptyCandidate.prepare(
        { id: 'empty', name: 'Glob', input: { pattern: '*.ts' } },
        { cwd: emptyRoot },
      ),
      { cwd: emptyRoot },
    )
    expect(emptyResult).toEqual({ content: 'No files found', isError: false })
    await symlink(join(root, 'a.ts'), join(root, 'link.ts'))
    const symlinkResult = await candidate.execute(
      await candidate.prepare(
        { id: 'symlink', name: 'Glob', input: { pattern: '**/*.ts' } },
        context,
      ),
      context,
    )
    expect(symlinkResult.content).not.toContain('link-dir')
    const absolute = await candidate.execute(
      await candidate.prepare(
        {
          id: 'absolute',
          name: 'Glob',
          input: { pattern: `${root}/a.ts` },
        },
        context,
      ),
      context,
    )
    expect(absolute.content).toBe(portable(resolve(root, 'a.ts')))
    expect(
      await legacyGlobFiles({
        root,
        displayRoot: '.',
        absoluteRoot: root,
        pattern: `${root}/link.ts`,
      }),
    ).toBe('No files found')
    const absoluteSymlink = await candidate.execute(
      await candidate.prepare(
        {
          id: 'absolute-symlink',
          name: 'Glob',
          input: { pattern: `${root}/link.ts` },
        },
        context,
      ),
      context,
    )
    expect(absoluteSymlink.content).toBe('No files found')
    expect(
      (
        await candidate.execute(
          await candidate.prepare(
            { id: 'none', name: 'Glob', input: { pattern: '*.jsx' } },
            context,
          ),
          context,
        )
      ).content,
    ).toBe('No files found')
    const extra = await candidate.execute(
      await candidate.prepare(
        {
          id: 'extra',
          name: 'Glob',
          input: { pattern: '*.ts', path: sibling },
        },
        context,
      ),
      context,
    )
    expect(extra.content).toContain('b.ts')
    const orderedNames = Array.from(
      { length: 105 },
      (_, index) => `ordered-${String(index).padStart(3, '0')}.ts`,
    )
    const capped = createProductionGlobRegistry(
      {
        cwd: root,
        dataPlane: 'native',
        additionalDirectories: [join(root, 'extra'), sibling],
        homeDirectory: join(root, 'home'),
        configRoot: join(root, 'config'),
      },
      {},
      {
        run: async () => ({
          stdout: `${orderedNames.join('\0')}\0`,
          stderr: '',
          output: '',
          code: 0,
          timedOut: false,
          truncated: false,
        }),
      },
    )
    const cappedResult = await capped.execute(
      await capped.prepare(
        { id: 'cap', name: 'Glob', input: { pattern: '*.ts' } },
        context,
      ),
      context,
    )
    const cappedLines = cappedResult.content.split('\n')
    expect(cappedLines).toHaveLength(101)
    expect(cappedLines[0]).toBe('ordered-000.ts')
    expect(cappedLines[99]).toBe('ordered-099.ts')
    expect(cappedLines.at(-1)).toBe(
      '(Showing 100 of 105 matching files; 5 more are not listed. Narrow the pattern or path to see the rest.)',
    )
    const captured: string[][] = []
    const controls = createProductionGlobRegistry(
      {
        cwd: root,
        dataPlane: 'native',
        additionalDirectories: [join(root, 'extra'), sibling],
        homeDirectory: join(root, 'home'),
        configRoot: join(root, 'config'),
      },
      { CLAUDE_CODE_GLOB_HIDDEN: 'false', CLAUDE_CODE_GLOB_NO_IGNORE: 'false' },
      {
        run: async (options) => {
          captured.push([...options.args])
          return {
            stdout: 'a.ts\0',
            stderr: '',
            output: '',
            code: 0,
            timedOut: false,
            truncated: false,
          }
        },
      },
    )
    await controls.execute(
      await controls.prepare(
        { id: 'controls', name: 'Glob', input: { pattern: '*.ts' } },
        context,
      ),
      context,
    )
    expect(captured[0]).not.toContain('--hidden')
    expect(captured[0]).not.toContain('--no-ignore')
    await expect(
      candidate.prepare(
        {
          id: 'outside',
          name: 'Glob',
          input: { pattern: '*', path: join(root, '..') },
        },
        context,
      ),
    ).rejects.toThrow()
    await expect(
      candidate.prepare(
        {
          id: 'invalid',
          name: 'Glob',
          input: { pattern: '*', path: join(root, 'missing') },
        },
        context,
      ),
    ).rejects.toThrow()
    const failedProcessRun = async (): Promise<ProcessResult> => ({
      stdout: '',
      stderr: 'missing',
      output: '',
      code: 127,
      timedOut: false,
      truncated: false,
    })
    const failedRegistry = createProductionGlobRegistry(
      {
        cwd: root,
        dataPlane: 'native',
        additionalDirectories: [join(root, 'extra'), sibling],
        homeDirectory: join(root, 'home'),
        configRoot: join(root, 'config'),
      },
      {},
      { run: failedProcessRun },
    )
    await expect(
      failedRegistry.execute(
        await failedRegistry.prepare(
          { id: 'failed', name: 'Glob', input: { pattern: '*' } },
          context,
        ),
        context,
      ),
    ).rejects.toThrow('exit code 127')
    const missing = createProductionGlobRegistry(
      {
        cwd: root,
        dataPlane: 'native',
        additionalDirectories: [join(root, 'extra'), sibling],
        homeDirectory: join(root, 'home'),
        configRoot: join(root, 'config'),
      },
      {},
      {
        run: async () => {
          throw new Error('spawn ENOENT')
        },
      },
    )
    await expect(
      missing.execute(
        await missing.prepare(
          { id: 'missing', name: 'Glob', input: { pattern: '*' } },
          context,
        ),
        context,
      ),
    ).rejects.toThrow('ENOENT')
    const truncated = createProductionGlobRegistry(
      {
        cwd: root,
        dataPlane: 'native',
        additionalDirectories: [join(root, 'extra'), sibling],
        homeDirectory: join(root, 'home'),
        configRoot: join(root, 'config'),
      },
      {},
      {
        run: async () => ({
          stdout: 'a.ts\0',
          stderr: '',
          output: '',
          code: 0,
          timedOut: false,
          truncated: true,
        }),
      },
    )
    await expect(
      truncated.execute(
        await truncated.prepare(
          { id: 'truncated', name: 'Glob', input: { pattern: '*' } },
          context,
        ),
        context,
      ),
    ).rejects.toThrow('truncated')
    const timedOutRegistry = createProductionGlobRegistry(
      {
        cwd: root,
        dataPlane: 'native',
        additionalDirectories: [join(root, 'extra'), sibling],
        homeDirectory: join(root, 'home'),
        configRoot: join(root, 'config'),
      },
      {},
      {
        run: async () => ({
          stdout: '',
          stderr: '',
          output: '',
          code: 1,
          timedOut: true,
          truncated: false,
        }),
      },
    )
    expect(
      (
        await timedOutRegistry.execute(
          await timedOutRegistry.prepare(
            { id: 'timeout', name: 'Glob', input: { pattern: '*' } },
            context,
          ),
          context,
        )
      ).isError,
    ).toBe(true)
    const controller = new AbortController()
    const abortContext = { ...context, signal: controller.signal }
    const abortCall = await candidate.prepare(
      { id: 'abort', name: 'Glob', input: { pattern: '*' } },
      abortContext,
    )
    controller.abort()
    await expect(candidate.execute(abortCall, abortContext)).rejects.toThrow(
      'aborted',
    )
    const swap = join(root, 'swap')
    const replacement = join(root, 'replacement')
    await mkdir(swap)
    await mkdir(replacement)
    const swapCall = await candidate.prepare(
      { id: 'swap', name: 'Glob', input: { pattern: '*', path: swap } },
      context,
    )
    await rename(swap, join(root, 'old-swap'))
    await symlink(replacement, swap)
    await expect(candidate.execute(swapCall, context)).rejects.toThrow(
      'changed after permission approval',
    )
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('a\n')
  })

  it('records a faster ripgrep median on a deterministic large tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-glob-ripgrep-bench-'))
    roots.push(root)
    for (let i = 0; i < 600; i += 1)
      await writeFile(
        join(root, `file-${String(i).padStart(4, '0')}.ts`),
        `${i}\n`,
        'utf8',
      )
    const legacy = new LegacyGlobSearch()
    const baselineRun = () =>
      legacy.search({
        root,
        displayRoot: '.',
        absoluteRoot: root,
        pattern: '*.ts',
      })
    const candidate = createProductionGlobRegistry({
      cwd: root,
      dataPlane: 'native',
      homeDirectory: join(root, 'home'),
      configRoot: join(root, 'config'),
    })
    const candidateRun = async () => {
      const prepared = await candidate.prepare(
        { id: 'bench', name: 'Glob', input: { pattern: '*.ts' } },
        { cwd: root },
      )
      return candidate.execute(prepared, { cwd: root })
    }
    await baselineRun()
    await candidateRun()
    const baseline: number[] = []
    const candidateSamples: number[] = []
    const measure = async (run: () => Promise<unknown>) => {
      const started = performance.now()
      await run()
      return Number((performance.now() - started).toFixed(3))
    }
    for (let i = 0; i < 5; i += 1) {
      if (i % 2 === 0) {
        baseline.push(await measure(baselineRun))
        candidateSamples.push(await measure(candidateRun))
      } else {
        candidateSamples.push(await measure(candidateRun))
        baseline.push(await measure(baselineRun))
      }
    }
    const median = (values: number[]) =>
      [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0
    const artifact = {
      schema_version: '1.0',
      files: 600,
      baseline_samples_ms: baseline,
      candidate_samples_ms: candidateSamples,
      baseline_median_ms: median(baseline),
      candidate_median_ms: median(candidateSamples),
    }
    await writeFile(
      join(root, 'benchmark-result.json'),
      `${JSON.stringify(artifact, null, 2)}\n`,
      'utf8',
    )
    const retained = JSON.parse(
      await readFile(join(root, 'benchmark-result.json'), 'utf8'),
    ) as typeof artifact
    expect(retained.schema_version).toBe('1.0')
    expect(retained.baseline_samples_ms).toHaveLength(5)
    expect(retained.candidate_samples_ms).toHaveLength(5)
    expect(baseline).toHaveLength(5)
    expect(candidateSamples).toHaveLength(5)
    expect(artifact.candidate_median_ms).toBeLessThan(
      artifact.baseline_median_ms,
    )
  })

  it('compares the production baseline with the eval-only ripgrep candidate across four cases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-glob-ripgrep-eval-'))
    roots.push(root)
    const baseline = await runEval('baseline', join(root, 'baseline'))
    const candidate = await runEval('candidate', join(root, 'candidate'))
    expect(baseline.code).toBe(0)
    expect(candidate.code).toBe(0)
    expect(baseline.aggregate).toMatchObject({
      run_count: 4,
      passed: 4,
      safety_passed: 4,
      safety_failed: 0,
      total_turns: 15,
      permission_decisions: { allow: 10, ask: 0, deny: 1 },
      tool_errors: 3,
      retries: 0,
      terminations: { completed: 4, timeout: 0, interrupted: 0 },
    })
    expect(candidate.aggregate).toMatchObject({
      run_count: 4,
      passed: 4,
      safety_passed: 4,
      safety_failed: 0,
      total_turns: 13,
      permission_decisions: { allow: 8, ask: 0, deny: 1 },
      tool_errors: 3,
      retries: 0,
      terminations: { completed: 4, timeout: 0, interrupted: 0 },
    })
    await inspectAggregate(baseline.aggregate, 'baseline')
    await inspectAggregate(candidate.aggregate, 'candidate')
    expect(candidate.aggregate.total_turns).toBeLessThan(
      baseline.aggregate.total_turns,
    )
    expect(candidate.aggregate.tool_errors).toBeLessThanOrEqual(
      baseline.aggregate.tool_errors,
    )
    const compareOutput: string[] = []
    await expect(
      executeProjectEvalCommand(
        [
          'compare',
          '--baseline',
          join(root, 'baseline', 'aggregate-result.json'),
          '--baseline-name',
          'baseline',
          '--candidate',
          join(root, 'candidate', 'aggregate-result.json'),
          '--candidate-name',
          'candidate',
          '--json',
        ],
        {
          stdout: (message) => compareOutput.push(message),
          stderr: () => undefined,
        },
        {
          configRoot: join(root, 'unused'),
          loadBuildIdentity: loadTestBuildIdentity,
          runtimeFactory: createFactory('candidate'),
          version: 'glob-ripgrep-admission-test',
        },
      ),
    ).resolves.toBe(0)
    expect(JSON.parse(compareOutput[0] ?? '{}')).toMatchObject({
      schema_version: '1.1',
      passed: true,
      comparable_run_count: 4,
      regressions: [],
      metrics: {
        average_turns: { baseline: 3.75, candidate: 3.25, delta: -0.5 },
        tool_errors: { baseline: 3, candidate: 3, delta: 0 },
        permission_decisions: {
          allow: { baseline: 10, candidate: 8, delta: -2 },
          ask: { baseline: 0, candidate: 0, delta: 0 },
          deny: { baseline: 1, candidate: 1, delta: 0 },
        },
      },
    })
    await expect(
      readFile(join(root, 'candidate', 'comparison-result.json'), 'utf8'),
    ).resolves.toContain('"passed": true')
  }, 30_000)
})
