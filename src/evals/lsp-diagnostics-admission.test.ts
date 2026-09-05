import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'
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
import type { ApplyPatchEdit } from '../tools/apply-patch.js'
import type {
  IdentifiedEvalRuntimeFactory,
  EvalRuntimeFactoryOptions,
} from './eval-contract.js'
import { executeProjectEvalCommand } from './project-eval.js'

const FIXTURE_ROOT = join(
  process.cwd(),
  'test/fixtures/native/evals/lsp-diagnostics-admission',
)
const roots: string[] = []
const keptWorkspaceRoots: string[] = []
const TEST_BUILD_IDENTITY = {
  schema_version: '1.0' as const,
  source_revision: `git:${'a'.repeat(40)}` as `git:${string}`,
  source_dirty: false,
  artifact_sha256: `sha256:${'b'.repeat(64)}` as `sha256:${string}`,
}
const loadTestBuildIdentity = async () => TEST_BUILD_IDENTITY

type DiagnosticSeverity = 'error' | 'warning' | 'information' | 'hint'

interface DiagnosticRecord {
  canonicalPath: string
  line: number
  column: number
  severity: DiagnosticSeverity
  code: string
  message: string
}

type DiagnosticSource = (
  filePath: string,
  content: string,
  cwd: string,
) => readonly DiagnosticRecord[]

const severityRank: Record<DiagnosticSeverity, number> = {
  error: 0,
  warning: 1,
  information: 2,
  hint: 3,
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

const marker =
  /@diag\s+severity=(\w+)\s+code=([A-Za-z0-9._-]+)\s+message=([^\r\n]+)/u

function markerDiagnostics(
  filePath: string,
  content: string,
): readonly DiagnosticRecord[] {
  const diagnostics: DiagnosticRecord[] = []
  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    const match = marker.exec(line)
    if (!match) continue
    const severity = match[1]
    if (
      severity !== 'error' &&
      severity !== 'warning' &&
      severity !== 'information' &&
      severity !== 'hint'
    )
      continue
    diagnostics.push({
      canonicalPath: filePath,
      line: index + 1,
      column: Math.max(1, line.indexOf('@diag') + 1),
      severity,
      code: match[2] ?? 'DIAG',
      message: match[3] ?? '',
    })
  }
  return diagnostics
}

function compareDiagnostics(a: DiagnosticRecord, b: DiagnosticRecord): number {
  const aPath = a.canonicalPath.replaceAll('\\', '/')
  const bPath = b.canonicalPath.replaceAll('\\', '/')
  return (
    compareText(aPath, bPath) ||
    a.line - b.line ||
    a.column - b.column ||
    severityRank[a.severity] - severityRank[b.severity] ||
    compareText(a.code, b.code) ||
    compareText(a.message, b.message)
  )
}

function formatDiagnostic(diagnostic: DiagnosticRecord, cwd: string): string {
  const path = relative(cwd, diagnostic.canonicalPath)
    .replaceAll('\\', '/')
    .replace(/^\.\//u, '')
  return `${path}:${diagnostic.line}:${diagnostic.column} ${diagnostic.severity} ${diagnostic.code} ${diagnostic.message}`
}

function formatDiagnostics(
  diagnostics: readonly DiagnosticRecord[],
  cwd: string,
): string {
  const sorted = [...diagnostics].sort(compareDiagnostics)
  const lines: string[] = []
  let truncated = sorted.length > 8
  for (const diagnostic of sorted.slice(0, 8)) {
    const line = formatDiagnostic(diagnostic, cwd)
    const candidate = `<diagnostics>\n${[...lines, line].join('\n')}\n</diagnostics>`
    if (Buffer.byteLength(candidate, 'utf8') > 4096) {
      truncated = true
      break
    }
    lines.push(line)
  }
  if (truncated) {
    const markerText = '… diagnostics truncated'
    while (
      Buffer.byteLength(
        `<diagnostics>\n${[...lines, markerText].join('\n')}\n</diagnostics>`,
        'utf8',
      ) > 4096
    )
      lines.pop()
    lines.push(markerText)
  }
  return `<diagnostics>\n${lines.join('\n')}\n</diagnostics>`
}

function isContained(path: string, cwd: string): boolean {
  const candidate = relative(cwd, path)
  return (
    candidate.length === 0 ||
    (candidate !== '..' &&
      !candidate.startsWith(`..${sep}`) &&
      !isAbsolute(candidate))
  )
}

class AdmissionDiagnosticsRegistry implements ToolRegistry {
  private readonly latest = new Map<string, readonly DiagnosticRecord[]>()

  constructor(
    private readonly base: ToolRegistry,
    private readonly source: DiagnosticSource,
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
    const result = await this.base.execute(call, context)
    if (result.isError || (call.name !== 'Edit' && call.name !== 'ApplyPatch'))
      return result
    const cwd = await realpath(context.cwd)
    const requestedPaths =
      call.name === 'Edit'
        ? [call.input.file_path]
        : Array.isArray(call.input.edits)
          ? call.input.edits.map((edit) => edit.file_path)
          : []
    const paths = new Set<string>()
    for (const requested of requestedPaths) {
      if (typeof requested !== 'string') continue
      try {
        const canonical = await realpath(resolve(cwd, requested))
        if (!(isContained(canonical, cwd) && (await stat(canonical)).isFile()))
          continue
        paths.add(canonical)
      } catch {
        // A successful mutation should leave no state for an invalid target.
      }
    }
    for (const path of paths) {
      const content = await readFile(path, 'utf8')
      const records = this.source(path, content, cwd).filter(
        (record) =>
          isContained(record.canonicalPath, cwd) &&
          record.canonicalPath === path,
      )
      this.latest.set(path, records)
    }
    const current = [...paths].flatMap((path) => this.latest.get(path) ?? [])
    if (current.length === 0) return result
    return {
      ...result,
      content: `${result.content}\n${formatDiagnostics(current, cwd)}`,
    }
  }
}

function call(
  id: string,
  name: 'Read' | 'Edit' | 'ApplyPatch' | 'Bash',
  input: Record<string, unknown>,
): { type: 'tool-call'; call: ModelToolCall } {
  return { type: 'tool-call', call: { id, name, input } }
}

function scriptedProvider(
  options: EvalRuntimeFactoryOptions,
  variant: 'baseline' | 'candidate',
): { provider: ModelProvider; requests: ModelRequest[] } {
  const scenario = options.env.EVAL_SCENARIO
  const requests: ModelRequest[] = []
  let turn = 0
  const provider: ModelProvider = {
    model: 'lsp-diagnostics-admission-model',
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
      const path = (name: string) => join(options.cwd, name)
      const sawDiagnostics = (code: string) =>
        request.messages.some((message) =>
          JSON.stringify(message).includes(code),
        )
      const edit = (
        id: string,
        filePath: string,
        oldString: string,
        newString: string,
      ) =>
        call(id, 'Edit', {
          file_path: filePath,
          old_string: oldString,
          new_string: newString,
        })
      const patch = (id: string, edits: ApplyPatchEdit[]) =>
        call(id, 'ApplyPatch', { edits })
      const checker = (id: string, filePath: string) =>
        call(id, 'Bash', { command: `node -e "require('./${filePath}')"` })

      if (scenario === 'single-file') {
        if (turn === 1)
          yield* finishTool(
            call('read', 'Read', { file_path: path('service.cjs') }),
          )
        else if (turn === 2)
          yield* finishTool(
            edit(
              'faulty',
              path('service.cjs'),
              "value: 'initial'",
              "value: 'broken' // @diag severity=error code=S001 message=service value is broken",
            ),
          )
        else if (variant === 'baseline' && turn === 3)
          yield* finishTool(checker('check', 'service.cjs'))
        else if (
          (variant === 'baseline' && turn === 4) ||
          (variant === 'candidate' && turn === 3 && sawDiagnostics('S001'))
        )
          yield* finishTool(
            edit(
              'repair',
              path('service.cjs'),
              "value: 'broken' // @diag severity=error code=S001 message=service value is broken",
              "value: 'ok'",
            ),
          )
        else yield* finish()
      } else if (scenario === 'multi-file') {
        if (turn === 1)
          yield* finishTool(
            call('read-a', 'Read', { file_path: path('alpha.cjs') }),
          )
        else if (turn === 2)
          yield* finishTool(
            call('read-b', 'Read', { file_path: path('beta.cjs') }),
          )
        else if (turn === 3)
          yield* finishTool(
            patch('faulty-patch', [
              {
                file_path: path('alpha.cjs'),
                old_string: "value: 'initial-alpha'",
                new_string:
                  "value: 'broken-alpha' // @diag severity=warning code=M001 message=alpha value is broken",
              },
              {
                file_path: path('beta.cjs'),
                old_string: "value: 'initial-beta'",
                new_string:
                  "value: 'broken-beta' // @diag severity=error code=M002 message=beta value is broken",
              },
            ]),
          )
        else if (variant === 'baseline' && turn === 4)
          yield* finishTool(checker('check', 'alpha.cjs'))
        else if (variant === 'baseline' && turn === 5)
          yield* finishTool(
            patch('repair-patch', [
              {
                file_path: path('alpha.cjs'),
                old_string:
                  "value: 'broken-alpha' // @diag severity=warning code=M001 message=alpha value is broken",
                new_string: "value: 'alpha'",
              },
              {
                file_path: path('beta.cjs'),
                old_string:
                  "value: 'broken-beta' // @diag severity=error code=M002 message=beta value is broken",
                new_string: "value: 'beta'",
              },
            ]),
          )
        else if (
          variant === 'candidate' &&
          turn === 4 &&
          sawDiagnostics('M001') &&
          sawDiagnostics('M002')
        )
          yield* finishTool(
            patch('repair-patch', [
              {
                file_path: path('alpha.cjs'),
                old_string:
                  "value: 'broken-alpha' // @diag severity=warning code=M001 message=alpha value is broken",
                new_string: "value: 'alpha'",
              },
              {
                file_path: path('beta.cjs'),
                old_string:
                  "value: 'broken-beta' // @diag severity=error code=M002 message=beta value is broken",
                new_string: "value: 'beta'",
              },
            ]),
          )
        else yield* finish()
      } else if (scenario === 'stale-clear') {
        if (turn === 1)
          yield* finishTool(
            call('read', 'Read', { file_path: path('value.cjs') }),
          )
        else if (turn === 2)
          yield* finishTool(
            edit(
              'faulty',
              path('value.cjs'),
              "value: 'initial'",
              "value: 'broken' // @diag severity=error code=C001 message=value is broken",
            ),
          )
        else if (variant === 'baseline' && turn === 3)
          yield* finishTool(checker('check', 'value.cjs'))
        else if (
          (variant === 'baseline' && turn === 4) ||
          (variant === 'candidate' && turn === 3 && sawDiagnostics('C001'))
        )
          yield* finishTool(
            edit(
              'clear',
              path('value.cjs'),
              "value: 'broken' // @diag severity=error code=C001 message=value is broken",
              "value: 'ok'",
            ),
          )
        else yield* finish()
      } else if (scenario === 'scope-isolation') {
        if (turn === 1)
          yield* finishTool(
            call('read', 'Read', { file_path: path('inside.cjs') }),
          )
        else if (turn === 2)
          yield* finishTool(
            edit(
              'faulty',
              path('inside.cjs'),
              "value: 'initial'",
              "value: 'broken' // @diag severity=error code=I001 message=inside value is broken",
            ),
          )
        else if (variant === 'baseline' && turn === 3)
          yield* finishTool(checker('check', 'inside.cjs'))
        else if (
          (variant === 'baseline' && turn === 4) ||
          (variant === 'candidate' && turn === 3 && sawDiagnostics('I001'))
        )
          yield* finishTool(
            edit(
              'repair',
              path('inside.cjs'),
              "value: 'broken' // @diag severity=error code=I001 message=inside value is broken",
              "value: 'ok'",
            ),
          )
        else yield* finish()
      } else yield* finish()
    },
  }
  return { provider, requests }
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
      modelId: options.model ?? 'lsp-diagnostics-admission-model',
    }),
    create: async (options) => {
      const scripted = scriptedProvider(options, variant)
      const base = new LocalToolRegistry({
        cwd: options.cwd,
        dataPlane: 'native',
        homeDirectory: options.home,
        configRoot: options.configRoot,
      })
      const registry: ToolRegistry =
        variant === 'candidate'
          ? new AdmissionDiagnosticsRegistry(base, (filePath, content, cwd) => {
              const records = markerDiagnostics(filePath, content)
              if (options.env.EVAL_SCENARIO === 'scope-isolation')
                return [
                  ...records,
                  {
                    canonicalPath: join(dirname(cwd), 'outside.cjs'),
                    line: 1,
                    column: 1,
                    severity: 'error',
                    code: 'X001',
                    message: 'outside must not surface',
                  },
                  {
                    canonicalPath: join(cwd, 'unrelated.cjs'),
                    line: 1,
                    column: 1,
                    severity: 'warning',
                    code: 'X002',
                    message: 'unrelated must not surface',
                  },
                ]
              return records
            })
          : base
      const tools = new FilteredToolRegistry(registry, {
        tools: options.allowedTools,
      })
      const permissions: PermissionResolver = {
        resolve: () => ({ behavior: 'allow' }),
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
        close: () => service.close(),
      }
    },
  }
}

interface Aggregate {
  schema_version: '1.1'
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

const expectedFiles: Record<string, Record<string, string>> = {
  'single-file': {
    'service.cjs': "/* global module */\nmodule.exports = { value: 'ok' }\n",
  },
  'multi-file': {
    'alpha.cjs': "/* global module */\nmodule.exports = { value: 'alpha' }\n",
    'beta.cjs': "/* global module */\nmodule.exports = { value: 'beta' }\n",
  },
  'stale-clear': {
    'value.cjs': "/* global module */\nmodule.exports = { value: 'ok' }\n",
  },
  'scope-isolation': {
    'inside.cjs': "/* global module */\nmodule.exports = { value: 'ok' }\n",
  },
}

async function registerKeptWorkspaceRoots(aggregate: Aggregate): Promise<void> {
  const results = await Promise.allSettled(
    aggregate.runs.map(async (run) => {
      const artifactDir = join(aggregate.output_dir, run.artifact_dir)
      return JSON.parse(
        await readFile(join(artifactDir, 'result.json'), 'utf8'),
      ) as { temp_root?: unknown }
    }),
  )
  for (const result of results)
    if (
      result.status === 'fulfilled' &&
      typeof result.value.temp_root === 'string'
    )
      keptWorkspaceRoots.push(result.value.temp_root)
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
      schema_version: string
      passed: boolean
      safety_passed: boolean
      cleanup_errors: string[]
      temp_root: string | null
    }
    expect(result).toMatchObject({
      schema_version: '1.1',
      passed: true,
      safety_passed: true,
      cleanup_errors: [],
    })
    expect(result.temp_root).toBeTruthy()

    const diff = JSON.parse(
      await readFile(join(artifactDir, 'workspace-diff.json'), 'utf8'),
    ) as { schema_version: string; changed: string[] }
    expect(diff.schema_version).toBe('1.0')
    const files = expectedFiles[run.case] ?? {}
    expect(diff.changed).toEqual(Object.keys(files).sort())
    const verifications = JSON.parse(
      await readFile(join(artifactDir, 'verification.json'), 'utf8'),
    ) as {
      schema_version: string
      passed: boolean
      exit_code: number | null
      timed_out: boolean
      error: string | null
    }[]
    expect(verifications.length).toBeGreaterThan(0)
    for (const verification of verifications)
      expect(verification).toMatchObject({
        schema_version: '1.0',
        passed: true,
        exit_code: 0,
        timed_out: false,
        error: null,
      })
    const workspace = join(result.temp_root ?? '', 'cwd')
    for (const [filePath, expected] of Object.entries(files))
      await expect(readFile(join(workspace, filePath), 'utf8')).resolves.toBe(
        expected,
      )

    const trace = (await readFile(join(artifactDir, 'trace.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as { type: string; tool?: string; content?: string },
      )
    const toolCalls = trace
      .filter((event) => event.type === 'tool-call')
      .map((event) => event.tool)
    expect(toolCalls).toEqual(
      variant === 'candidate'
        ? run.case === 'multi-file'
          ? ['Read', 'Read', 'ApplyPatch', 'ApplyPatch']
          : ['Read', 'Edit', 'Edit']
        : run.case === 'multi-file'
          ? ['Read', 'Read', 'ApplyPatch', 'Bash', 'ApplyPatch']
          : ['Read', 'Edit', 'Bash', 'Edit'],
    )
    if (variant === 'candidate') {
      if (run.case === 'single-file') {
        const content = trace
          .filter((event) => event.type === 'tool-result')
          .map((event) => event.content ?? '')
          .join('\n')
        expect(content).toContain('S001')
      }
      if (run.case === 'multi-file') {
        const mutation = trace.find(
          (event) =>
            event.type === 'tool-result' &&
            event.content?.includes('<diagnostics>'),
        )
        expect(mutation?.content).toContain('alpha.cjs:2:')
        expect(mutation?.content).toContain('beta.cjs:2:')
        const block =
          mutation?.content?.slice(mutation.content.indexOf('<diagnostics>')) ??
          ''
        expect(Buffer.byteLength(block, 'utf8')).toBeLessThanOrEqual(4096)
      }
      if (run.case === 'scope-isolation') {
        const content = trace
          .filter((event) => event.type === 'tool-result')
          .map((event) => event.content ?? '')
          .join('\n')
        expect(content).toContain('I001')
        expect(content).not.toContain('X001')
        expect(content).not.toContain('X002')
        await expect(
          lstat(join(result.temp_root ?? '', 'outside.cjs')),
        ).rejects.toThrow()
      }
      if (run.case === 'stale-clear') {
        const contents = trace
          .filter((event) => event.type === 'tool-result')
          .map((event) => event.content ?? '')
        expect(contents.some((content) => content.includes('C001'))).toBe(true)
        expect(contents.at(-1)).not.toContain('C001')
      }
    }
  }
}

async function runEval(variant: 'baseline' | 'candidate', outputDir: string) {
  const output: string[] = []
  const code = await executeProjectEvalCommand(
    [
      FIXTURE_ROOT,
      '--allow-tools',
      'Bash,Edit,ApplyPatch',
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
      version: 'lsp-diagnostics-admission-test',
    },
  )
  const aggregate = JSON.parse(output.at(-1) ?? '{}') as Aggregate
  await registerKeptWorkspaceRoots(aggregate)
  return { code, aggregate }
}

describe('LSP diagnostics admission eval', () => {
  afterAll(async () => {
    await Promise.all(
      [...new Set([...roots, ...keptWorkspaceRoots])].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    )
  })

  it('enforces current, contained, deterministic, bounded diagnostics at the mutation seam', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-lsp-diagnostics-unit-'))
    roots.push(root)
    const target = join(root, 'target.cjs')
    const other = join(root, 'other.cjs')
    const oversized = join(root, 'oversized.cjs')
    const clean = 'one\n'
    const faulty =
      Array.from(
        { length: 9 },
        (_, index) =>
          `line-${index} // @diag severity=${index === 0 ? 'warning' : 'error'} code=Z${String(index).padStart(3, '0')} message=diagnostic-${index}`,
      ).join('\n') + '\n'
    await writeFile(target, clean, 'utf8')
    await writeFile(other, 'other\n', 'utf8')
    await writeFile(oversized, 'oversized\n', 'utf8')
    const base = new LocalToolRegistry({
      cwd: root,
      dataPlane: 'native',
      homeDirectory: join(root, 'home'),
      configRoot: join(root, 'config'),
    })
    const registry = new AdmissionDiagnosticsRegistry(
      base,
      (filePath, content, cwd) => {
        const extras =
          filePath === target
            ? [
                {
                  canonicalPath: join(dirname(cwd), 'outside.cjs'),
                  line: 1,
                  column: 1,
                  severity: 'error' as const,
                  code: 'X001',
                  message: 'outside must not surface',
                },
                {
                  canonicalPath: join(cwd, 'unrelated.cjs'),
                  line: 1,
                  column: 1,
                  severity: 'warning' as const,
                  code: 'X002',
                  message: 'unrelated must not surface',
                },
              ]
            : []
        return [...markerDiagnostics(filePath, content), ...extras]
      },
    )
    const contextFor = async (
      filePath: string,
    ): Promise<ToolExecutionContext> => ({
      cwd: root,
      messages: [
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: `read-${filePath}`,
              name: 'Read',
              input: { file_path: filePath },
            },
          ],
        },
        {
          role: 'tool',
          toolCallId: `read-${filePath}`,
          content: await readFile(filePath, 'utf8'),
          isError: false,
        },
      ],
    })
    const context = await contextFor(target)
    const prepared = await registry.prepare(
      {
        id: 'edit',
        name: 'Edit',
        input: { file_path: target, old_string: clean, new_string: faulty },
      },
      context,
    )
    const result = await registry.execute(prepared, context)
    expect(result.isError).toBe(false)
    expect(result.content).toContain('<diagnostics>')
    expect(result.content).toContain('target.cjs:1:')
    expect(result.content).not.toContain('X001')
    expect(result.content).not.toContain('X002')
    expect(result.content).not.toContain('Z008')
    expect(result.content.indexOf('Z000')).toBeLessThan(
      result.content.indexOf('Z001'),
    )
    const diagnosticBlock = result.content.slice(
      result.content.indexOf('<diagnostics>'),
    )
    expect(Buffer.byteLength(diagnosticBlock, 'utf8')).toBeLessThanOrEqual(4096)
    expect(result.content).toContain('diagnostics truncated')

    const oversizedClean = 'oversized\n'
    const oversizedTail = 'oversized-tail-marker'
    const oversizedFaulty = `oversized // @diag severity=error code=B001 message=${'x'.repeat(5000)} ${oversizedTail}\n`
    const oversizedContext = await contextFor(oversized)
    const oversizedPrepared = await registry.prepare(
      {
        id: 'oversized',
        name: 'Edit',
        input: {
          file_path: oversized,
          old_string: oversizedClean,
          new_string: oversizedFaulty,
        },
      },
      oversizedContext,
    )
    const oversizedResult = await registry.execute(
      oversizedPrepared,
      oversizedContext,
    )
    const oversizedBlock = oversizedResult.content.slice(
      oversizedResult.content.indexOf('<diagnostics>'),
    )
    expect(Buffer.byteLength(oversizedBlock, 'utf8')).toBeLessThanOrEqual(4096)
    expect(oversizedBlock).toContain('diagnostics truncated')
    expect(oversizedBlock).not.toContain(oversizedTail)

    const otherContext = await contextFor(other)
    const otherFaulty =
      'other // @diag severity=error code=B002 message=other is broken\n'
    const otherPrepared = await registry.prepare(
      {
        id: 'other',
        name: 'Edit',
        input: {
          file_path: other,
          old_string: 'other\n',
          new_string: otherFaulty,
        },
      },
      otherContext,
    )
    const otherResult = await registry.execute(otherPrepared, otherContext)
    expect(otherResult.content).toContain('B002')
    expect(otherResult.content).not.toContain('Z000')
    expect(isContained(join(dirname(root), 'sibling'), root)).toBe(false)
    if (sep === '/') expect(isContained(`${root}\\sibling`, root)).toBe(false)

    const clearPrepared = await registry.prepare(
      {
        id: 'clear',
        name: 'Edit',
        input: { file_path: target, old_string: faulty, new_string: clean },
      },
      context,
    )
    const clearResult = await registry.execute(clearPrepared, context)
    expect(clearResult.content).not.toContain('Z000')
    expect(clearResult.content).not.toContain('<diagnostics>')

    const failedCall = {
      id: 'failed',
      name: 'Edit' as const,
      input: { file_path: target, old_string: 'missing', new_string: 'x' },
    }
    const failedPrepared = await registry.prepare(failedCall, context)
    await expect(registry.execute(failedPrepared, context)).rejects.toThrow()
    const otherClearPrepared = await registry.prepare(
      {
        id: 'other-clear',
        name: 'Edit',
        input: {
          file_path: other,
          old_string: otherFaulty,
          new_string: 'other\n',
        },
      },
      otherContext,
    )
    const otherClearResult = await registry.execute(
      otherClearPrepared,
      otherContext,
    )
    expect(otherClearResult.content).not.toContain('B002')
    expect(otherClearResult.content).not.toContain('Z000')
  })

  it('compares explicit checker baseline with eval-only diagnostics candidate across four cases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-lsp-diagnostics-eval-'))
    roots.push(root)
    const baselineDir = join(root, 'baseline')
    const candidateDir = join(root, 'candidate')
    const before = await Promise.all(
      [
        'single-file/fixture/service.cjs',
        'multi-file/fixture/alpha.cjs',
        'multi-file/fixture/beta.cjs',
        'stale-clear/fixture/value.cjs',
        'scope-isolation/fixture/inside.cjs',
      ].map((path) => readFile(join(FIXTURE_ROOT, 'evals', path), 'utf8')),
    )
    const baseline = await runEval('baseline', baselineDir)
    const candidate = await runEval('candidate', candidateDir)
    expect(baseline.code).toBe(0)
    expect(candidate.code).toBe(0)
    expect(baseline.aggregate).toMatchObject({
      schema_version: '1.1',
      run_count: 4,
      passed: 4,
      safety_passed: 4,
      safety_failed: 0,
      total_turns: 21,
      permission_decisions: { allow: 17, ask: 0, deny: 0 },
      tool_errors: 4,
      retries: 0,
      terminations: { completed: 4, timeout: 0, interrupted: 0 },
    })
    expect(candidate.aggregate).toMatchObject({
      schema_version: '1.1',
      run_count: 4,
      passed: 4,
      safety_passed: 4,
      safety_failed: 0,
      total_turns: 17,
      permission_decisions: { allow: 13, ask: 0, deny: 0 },
      tool_errors: 0,
      retries: 0,
      terminations: { completed: 4, timeout: 0, interrupted: 0 },
    })
    await inspectAggregate(baseline.aggregate, 'baseline')
    await inspectAggregate(candidate.aggregate, 'candidate')
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
          configRoot: join(root, 'unused'),
          loadBuildIdentity: loadTestBuildIdentity,
          runtimeFactory: createFactory('candidate'),
          version: 'lsp-diagnostics-admission-test',
        },
      ),
    ).resolves.toBe(0)
    expect(JSON.parse(compareOutput[0] ?? '{}')).toMatchObject({
      schema_version: '1.1',
      passed: true,
      comparable_run_count: 4,
      regressions: [],
      metrics: {
        pass_rate: { baseline: 1, candidate: 1, delta: 0 },
        safety_pass_rate: { baseline: 1, candidate: 1, delta: 0 },
        average_turns: { baseline: 5.25, candidate: 4.25, delta: -1 },
        tool_errors: { baseline: 4, candidate: 0, delta: -4 },
        retries: { baseline: 0, candidate: 0, delta: 0 },
        permission_decisions: {
          allow: { baseline: 17, candidate: 13, delta: -4 },
          ask: { baseline: 0, candidate: 0, delta: 0 },
          deny: { baseline: 0, candidate: 0, delta: 0 },
        },
      },
    })
    await expect(
      readFile(join(candidateDir, 'comparison-result.json'), 'utf8'),
    ).resolves.toContain('"passed": true')
    await expect(
      Promise.all(
        [
          'single-file/fixture/service.cjs',
          'multi-file/fixture/alpha.cjs',
          'multi-file/fixture/beta.cjs',
          'stale-clear/fixture/value.cjs',
          'scope-isolation/fixture/inside.cjs',
        ].map((path) => readFile(join(FIXTURE_ROOT, 'evals', path), 'utf8')),
      ),
    ).resolves.toEqual(before)
  }, 30_000)
})
