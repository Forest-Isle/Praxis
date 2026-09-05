import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  truncate,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { stringify as stringifyYaml } from 'yaml'

import {
  discoverProjectEvalCases,
  loadProjectEvalCase,
  parseProjectEvalCase,
} from './project-eval-schema.js'
import {
  executeProjectEvalCommand,
  parseProjectEvalOptions,
} from './project-eval.js'
import { runProjectEvalCase } from './project-eval-runner.js'
import type {
  IdentifiedEvalRuntimeFactory,
  EvalRuntimeFactoryOptions,
} from './eval-contract.js'
import {
  MAX_BYTES as MAX_FIXTURE_BYTES,
  cleanupProjectEvalWorkspace,
  createProjectEvalWorkspace,
  diffProjectEvalWorkspace,
} from './project-eval-workspace.js'

const temporaryRoots: string[] = []

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

function caseDefinition(name: string): Record<string, unknown> {
  return {
    schema_version: '1.0',
    name,
    fixture: 'fixture',
    execution: { prompt: 'Update the fixture.' },
    expect: { allowed_changed_paths: [] },
  }
}

async function writeCase(
  project: string,
  directory: string,
  definition: Record<string, unknown> = caseDefinition(directory),
): Promise<string> {
  const caseDir = join(project, 'evals', directory)
  await mkdir(join(caseDir, 'fixture'), { recursive: true })
  await writeFile(join(caseDir, 'case.yaml'), stringifyYaml(definition))
  return caseDir
}

function testIdentity(options: Pick<EvalRuntimeFactoryOptions, 'model'>) {
  return {
    providerId: 'test-provider',
    profileId: 'default',
    protocol: 'openai-compatible',
    endpoint: 'https://eval.test/v1',
    modelId: options.model ?? 'test-model',
  }
}

const TEST_BUILD_IDENTITY = {
  schema_version: '1.0' as const,
  source_revision: `git:${'a'.repeat(40)}` as `git:${string}`,
  source_dirty: false,
  artifact_sha256: `sha256:${'b'.repeat(64)}` as `sha256:${string}`,
}

async function loadTestBuildIdentity() {
  return TEST_BUILD_IDENTITY
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('project eval schema and discovery', () => {
  it('discovers a valid case deterministically and applies fixed defaults', async () => {
    const project = await temporaryRoot('praxis-project-eval-schema-')
    const definition = caseDefinition('alpha')
    definition.tags = ['fast']
    const caseDir = await writeCase(project, 'alpha', definition)
    await writeFile(join(caseDir, 'fixture', 'README.md'), 'fixture')
    let deepFixtureDirectory = join(caseDir, 'fixture')
    for (let depth = 0; depth < 18; depth += 1) {
      deepFixtureDirectory = join(deepFixtureDirectory, `level-${depth}`)
      await mkdir(deepFixtureDirectory)
    }

    const cases = await discoverProjectEvalCases(project, 'a*', ['fast'])

    expect(cases).toHaveLength(1)
    expect(cases[0]).toMatchObject({
      name: 'alpha',
      runs: 1,
      tags: ['fast'],
      execution: {
        maxTurns: 10,
        timeoutSeconds: 120,
        allowedTools: ['Read', 'Glob', 'Grep'],
        env: {},
      },
      verification: [],
      expect: {
        allowedChangedPaths: [],
        expectedChangedPaths: [],
        forbiddenChangedPaths: [],
      },
    })
    expect(cases[0]?.fixture).toBe(await realpath(join(caseDir, 'fixture')))
  })

  it('rejects missing, empty-filtered, and duplicate case discovery', async () => {
    const missing = await temporaryRoot('praxis-project-eval-missing-')
    await expect(discoverProjectEvalCases(missing)).rejects.toThrow(
      'No evals directory',
    )

    const project = await temporaryRoot('praxis-project-eval-duplicate-')
    await writeCase(project, 'first', caseDefinition('duplicate'))
    await writeCase(project, 'second', caseDefinition('duplicate'))
    await expect(discoverProjectEvalCases(project, 'absent*')).rejects.toThrow(
      'case names must be unique',
    )
    await expect(discoverProjectEvalCases(project)).rejects.toThrow(
      'case names must be unique',
    )
  })

  it('rejects oversized and symlinked case definitions before parsing', async () => {
    const oversizedProject = await temporaryRoot(
      'praxis-project-eval-oversized-',
    )
    const oversizedDir = await writeCase(oversizedProject, 'oversized')
    await truncate(join(oversizedDir, 'case.yaml'), 1024 * 1024 + 1)
    await expect(loadProjectEvalCase(oversizedDir)).rejects.toThrow(
      'exceeds 1 MiB',
    )

    const linkedProject = await temporaryRoot('praxis-project-eval-linked-')
    const linkedDir = await writeCase(linkedProject, 'linked')
    const definition = join(linkedDir, 'definition.yaml')
    await writeFile(definition, stringifyYaml(caseDefinition('linked')))
    await unlink(join(linkedDir, 'case.yaml'))
    await symlink(definition, join(linkedDir, 'case.yaml'))
    await expect(discoverProjectEvalCases(linkedProject)).rejects.toThrow(
      'contains symlink',
    )
  })

  it('rejects unsafe paths, malformed globs, and oversized object keys', async () => {
    expect(() =>
      parseProjectEvalCase(
        { ...caseDefinition('unsafe'), fixture: '../fixture' },
        '/case',
      ),
    ).toThrow('contained relative path')
    expect(() =>
      parseProjectEvalCase(
        {
          ...caseDefinition('unsafe'),
          expect: { allowed_changed_paths: ['src/['] },
        },
        '/case',
      ),
    ).toThrow('is invalid')

    const project = await temporaryRoot('praxis-project-eval-glob-')
    await writeCase(project, 'alpha')
    await expect(discoverProjectEvalCases(project, '[')).rejects.toThrow(
      'Invalid case glob',
    )

    const keyProject = await temporaryRoot('praxis-project-eval-key-')
    const keyDir = await writeCase(keyProject, 'key')
    const definition = caseDefinition('key')
    definition['x'.repeat(257)] = true
    await writeFile(join(keyDir, 'case.yaml'), stringifyYaml(definition))
    await expect(loadProjectEvalCase(keyDir)).rejects.toThrow('oversized key')
  })

  it('treats an omitted changed-path allowlist as no allowed mutations', () => {
    const parsed = parseProjectEvalCase(
      { ...caseDefinition('no-allowlist'), expect: {} },
      '/case',
    )
    expect(parsed.expect.allowedChangedPaths).toEqual([])
  })

  it('rejects invalid deterministic grader regexes before inference', () => {
    expect(() =>
      parseProjectEvalCase(
        {
          ...caseDefinition('invalid-regex'),
          graders: [
            { type: 'regex', name: 'invalid', pattern: '[unterminated' },
          ],
        },
        '/case',
      ),
    ).toThrow('pattern or flags are invalid')
  })
})

describe('project eval workspace', () => {
  it('rejects forbidden fixture roots, descendants, symlinks, and byte limits', async () => {
    const parent = await temporaryRoot('praxis-project-eval-unsafe-fixture-')
    const forbiddenRoot = join(parent, '.git')
    await mkdir(forbiddenRoot)
    await expect(createProjectEvalWorkspace(forbiddenRoot)).rejects.toThrow(
      'Fixture root is forbidden',
    )

    const forbiddenDescendant = join(parent, 'with-dependency')
    await mkdir(join(forbiddenDescendant, 'node_modules'), { recursive: true })
    await expect(
      createProjectEvalWorkspace(forbiddenDescendant),
    ).rejects.toThrow('forbidden directory')

    const linked = join(parent, 'with-link')
    await mkdir(linked)
    await writeFile(join(parent, 'outside.txt'), 'outside')
    await symlink(join(parent, 'outside.txt'), join(linked, 'link.txt'))
    await expect(createProjectEvalWorkspace(linked)).rejects.toThrow(
      'Unsupported fixture entry',
    )

    const oversized = join(parent, 'oversized')
    await mkdir(oversized)
    await writeFile(join(oversized, 'huge.bin'), '')
    await truncate(join(oversized, 'huge.bin'), MAX_FIXTURE_BYTES + 1)
    await expect(createProjectEvalWorkspace(oversized)).rejects.toThrow(
      'Fixture exceeds manifest limits',
    )
  })

  it('copies prototype-like filenames safely and classifies every mutation', async () => {
    const fixture = await temporaryRoot('praxis-project-eval-fixture-')
    await Promise.all([
      writeFile(join(fixture, '__proto__'), 'prototype'),
      writeFile(join(fixture, 'constructor'), 'constructor'),
      writeFile(join(fixture, 'delete.txt'), 'delete'),
      writeFile(join(fixture, 'keep.txt'), 'before'),
      writeFile(join(fixture, 'mode.txt'), 'mode'),
    ])
    await chmod(join(fixture, 'mode.txt'), 0o644)

    const workspace = await createProjectEvalWorkspace(fixture)
    temporaryRoots.push(workspace.root)
    expect(Object.hasOwn(workspace.before.files, '__proto__')).toBe(true)
    expect(Object.hasOwn(workspace.before.files, 'constructor')).toBe(true)
    expect(workspace.before).toEqual(workspace.sourceBefore)

    await Promise.all([
      writeFile(join(workspace.cwd, 'added.txt'), 'added'),
      writeFile(join(workspace.cwd, 'keep.txt'), 'after'),
      unlink(join(workspace.cwd, 'delete.txt')),
      chmod(join(workspace.cwd, 'mode.txt'), 0o755),
    ])
    const after = await workspace.manifest(workspace.cwd)
    const diff = await diffProjectEvalWorkspace(workspace.before, after)

    expect(diff).toEqual({
      added: ['added.txt'],
      modified: ['keep.txt', 'mode.txt'],
      deleted: ['delete.txt'],
      changed: ['added.txt', 'delete.txt', 'keep.txt', 'mode.txt'],
    })
    expect(await readFile(join(fixture, 'keep.txt'), 'utf8')).toBe('before')

    await cleanupProjectEvalWorkspace(workspace.root)
    temporaryRoots.splice(temporaryRoots.indexOf(workspace.root), 1)
  })
})

function capturedIo() {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout,
    stderr,
    io: {
      stdout: (message: string) => stdout.push(message),
      stderr: (message: string) => stderr.push(message),
    },
  }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

describe('project eval lifecycle and artifacts', () => {
  it('runs two isolated outcomes with authorized argv verifiers and complete aggregates', async () => {
    const project = await temporaryRoot('praxis-project-eval-e2e-')
    const configRoot = await temporaryRoot('praxis-project-eval-config-')
    const definition = caseDefinition('outcome')
    definition.runs = 2
    definition.execution = {
      prompt: 'Create result.txt.',
      model: 'case-model',
      append_system_prompt: 'Project eval system prompt.',
      allowed_tools: ['Read'],
      env: { EVAL_MARKER: 'explicit-value' },
    }
    definition.verification = [
      {
        name: 'result-check',
        command: process.execPath,
        args: [
          '-e',
          `const fs=require('node:fs');const ambient=process.env.PRAXIS_PROJECT_EVAL_SENTINEL||null;const marker=process.env.EVAL_MARKER;if(!fs.existsSync('result.txt')||ambient!==null||marker!=='explicit-value')process.exit(7);process.stdout.write(JSON.stringify({ambient,marker}))`,
        ],
        timeout_seconds: 10,
      },
    ]
    definition.expect = {
      allowed_changed_paths: ['result.txt'],
      expected_changed_paths: ['result.txt'],
      forbidden_changed_paths: ['forbidden.txt'],
    }
    const caseDir = await writeCase(project, 'outcome', definition)
    await writeFile(join(caseDir, 'fixture', 'input.txt'), 'source')

    const created: EvalRuntimeFactoryOptions[] = []
    const factory: IdentifiedEvalRuntimeFactory = {
      identify: async (options) => ({
        providerId: 'test-provider',
        profileId: 'default',
        protocol: 'openai-compatible',
        endpoint: 'https://eval.test/v1',
        modelId: options.model ?? 'test-model',
      }),
      create: async (options) => {
        created.push(options)
        const run = created.length
        return {
          run: async () => {
            await writeFile(join(options.cwd, 'result.txt'), `run-${run}`)
            return {
              text: 'done',
              turns: 2,
              usage: {
                inputTokens: 3,
                outputTokens: 4,
                cacheReadInputTokens: 1,
              },
              costUsd: 0.25,
            }
          },
        }
      },
    }
    const previousSentinel = process.env.PRAXIS_PROJECT_EVAL_SENTINEL
    process.env.PRAXIS_PROJECT_EVAL_SENTINEL = 'ambient-value'
    const output = capturedIo()
    let buildIdentityLoads = 0
    let exitCode: number
    try {
      exitCode = await executeProjectEvalCommand(
        [project, '--run-verification', '--model', 'override-model', '--json'],
        output.io,
        {
          runtimeFactory: factory,
          loadBuildIdentity: async () => {
            buildIdentityLoads += 1
            return TEST_BUILD_IDENTITY
          },
          version: 'test-version',
          configRoot,
        },
      )
    } finally {
      if (previousSentinel === undefined)
        delete process.env.PRAXIS_PROJECT_EVAL_SENTINEL
      else process.env.PRAXIS_PROJECT_EVAL_SENTINEL = previousSentinel
    }

    expect(exitCode).toBe(0)
    expect(output.stdout).toHaveLength(1)
    expect(output.stderr).toEqual([])
    expect(buildIdentityLoads).toBe(1)
    expect(created).toHaveLength(2)
    for (const options of created) {
      expect(options).toMatchObject({
        dataPlane: 'native',
        model: 'override-model',
        appendSystemPrompt: 'Project eval system prompt.',
        allowedTools: ['Read'],
        pluginDirectories: [],
      })
      expect(options.cwd).not.toContain(caseDir)
    }

    const aggregate = JSON.parse(output.stdout[0] ?? '{}') as Record<
      string,
      unknown
    >
    const outputDir = String(aggregate.output_dir)
    expect(outputDir).toContain(join(configRoot, 'evals', 'results'))
    expect(outputDir).not.toContain(project)
    expect(aggregate).toMatchObject({
      schema_version: '1.1',
      version: 'test-version',
      model: 'override-model',
      case_count: 1,
      planned_run_count: 2,
      completed_run_count: 2,
      passed: 2,
      failed: 0,
      total_turns: 4,
      usage_totals: {
        input_tokens: 6,
        output_tokens: 8,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 0,
        web_search_requests: 0,
      },
      usage_known_runs: 2,
      usage_unknown_runs: 0,
      known_cost_total_usd: 0.5,
      known_cost_runs: 2,
      unknown_cost_runs: 0,
      partial: false,
      interrupted: false,
      runs: [
        { identity: { runtime: { build: TEST_BUILD_IDENTITY } } },
        { identity: { runtime: { build: TEST_BUILD_IDENTITY } } },
      ],
    })
    expect(await readJson(join(outputDir, 'aggregate-result.json'))).toEqual(
      aggregate,
    )

    for (const run of [1, 2]) {
      const runDir = join(outputDir, 'outcome', `run-${run}`)
      await Promise.all(
        [
          'trace.jsonl',
          'workspace-diff.json',
          'verification.json',
          'identity.json',
          'result.json',
        ].map((name) => access(join(runDir, name))),
      )
      const result = await readJson(join(runDir, 'result.json'))
      expect(result).toMatchObject({
        case: 'outcome',
        run,
        passed: true,
        score: 1,
        model: 'override-model',
        turns: 2,
        cost_known: true,
        cost_usd: 0.25,
        termination: null,
      })
      const identity = await readJson(join(runDir, 'identity.json'))
      expect(identity).toMatchObject({
        schema_version: '1.1',
        model_id: 'override-model',
        runtime: { engine: 'praxis', build: TEST_BUILD_IDENTITY },
      })
      expect(result.identity).toEqual(identity)
      const verification = JSON.parse(
        await readFile(join(runDir, 'verification.json'), 'utf8'),
      ) as Array<Record<string, unknown>>
      expect(verification).toHaveLength(1)
      expect(verification[0]).toMatchObject({
        name: 'result-check',
        exit_code: 0,
        timed_out: false,
        passed: true,
        error: null,
      })
      expect(String(verification[0]?.stdout)).toContain('"ambient":null')
      expect(String(verification[0]?.stdout)).toContain('explicit-value')
    }
    await expect(
      access(join(caseDir, 'fixture', 'result.txt')),
    ).rejects.toThrow()
  })

  it('fails before runtime or artifacts when build identity loading fails', async () => {
    const project = await temporaryRoot('praxis-project-eval-build-error-')
    const configRoot = await temporaryRoot(
      'praxis-project-eval-build-error-config-',
    )
    const outputDir = join(configRoot, 'explicit-output')
    await writeCase(project, 'build-error')
    let factoryCalls = 0

    await expect(
      executeProjectEvalCommand(
        [project, '--output-dir', outputDir],
        capturedIo().io,
        {
          configRoot,
          loadBuildIdentity: async () => {
            throw new Error(
              'Invalid Praxis build identity: metadata is missing or unreadable',
            )
          },
          runtimeFactory: {
            identify: async () => {
              factoryCalls += 1
              throw new Error('factory must not be called')
            },
            create: async () => {
              factoryCalls += 1
              throw new Error('factory must not be called')
            },
          },
        },
      ),
    ).rejects.toThrow('metadata is missing or unreadable')
    expect(factoryCalls).toBe(0)
    await expect(access(outputDir)).rejects.toThrow()
  })

  it('does not load build identity for project eval help', async () => {
    let loads = 0
    const code = await executeProjectEvalCommand(['--help'], capturedIo().io, {
      configRoot: '/unused',
      loadBuildIdentity: async () => {
        loads += 1
        return TEST_BUILD_IDENTITY
      },
      runtimeFactory: {
        identify: async () => testIdentity({}),
        create: async () => {
          throw new Error('factory must not be called')
        },
      },
    })
    expect(code).toBe(0)
    expect(loads).toBe(0)
  })

  it('rejects verifier and gated-tool authorization before runtime creation', async () => {
    const project = await temporaryRoot('praxis-project-eval-auth-')
    const configRoot = await temporaryRoot('praxis-project-eval-auth-config-')
    const definition = caseDefinition('authorization')
    definition.execution = {
      prompt: 'Do work.',
      allowed_tools: ['Bash'],
    }
    definition.verification = [
      { name: 'verify', command: process.execPath, args: ['--version'] },
    ]
    await writeCase(project, 'authorization', definition)
    let factoryCalls = 0
    const factory: IdentifiedEvalRuntimeFactory = {
      identify: async (options) => ({
        providerId: 'test-provider',
        profileId: 'default',
        protocol: 'openai-compatible',
        endpoint: 'https://eval.test/v1',
        modelId: options.model ?? 'test-model',
      }),
      create: async () => {
        factoryCalls += 1
        throw new Error('factory must not be called')
      },
    }

    await expect(
      executeProjectEvalCommand([project], capturedIo().io, {
        runtimeFactory: factory,
        loadBuildIdentity: loadTestBuildIdentity,
        configRoot,
      }),
    ).rejects.toThrow('Verification requires --run-verification')
    await expect(
      executeProjectEvalCommand(
        [project, '--run-verification'],
        capturedIo().io,
        {
          runtimeFactory: factory,
          loadBuildIdentity: loadTestBuildIdentity,
          configRoot,
        },
      ),
    ).rejects.toThrow('grant it with --allow-tools')
    expect(factoryCalls).toBe(0)
  })

  it('records aggregate cost as null when every run cost is unknown', async () => {
    const project = await temporaryRoot('praxis-project-eval-unknown-cost-')
    const configRoot = await temporaryRoot(
      'praxis-project-eval-unknown-cost-config-',
    )
    await writeCase(project, 'unknown-cost')
    const output = capturedIo()
    const code = await executeProjectEvalCommand(
      [project, '--json'],
      output.io,
      {
        configRoot,
        loadBuildIdentity: loadTestBuildIdentity,
        runtimeFactory: {
          identify: async (options) => ({
            providerId: 'test-provider',
            profileId: 'default',
            protocol: 'openai-compatible',
            endpoint: 'https://eval.test/v1',
            modelId: options.model ?? 'test-model',
          }),
          create: async () => ({
            run: async () => ({ text: 'done', turns: 1 }),
          }),
        },
      },
    )
    expect(code).toBe(0)
    const aggregate = JSON.parse(output.stdout.at(-1) ?? '{}') as Record<
      string,
      unknown
    >
    expect(aggregate).toMatchObject({
      known_cost_total_usd: null,
      known_cost_runs: 0,
      unknown_cost_runs: 1,
    })
    expect(
      await readJson(
        join(String(aggregate.output_dir), 'aggregate-result.json'),
      ),
    ).toEqual(aggregate)
  })

  it('runs deterministic project graders and redacts secret trace values', async () => {
    const project = await temporaryRoot('praxis-project-eval-graders-')
    const outputDir = await temporaryRoot('praxis-project-eval-graders-out-')
    const definition = caseDefinition('graders')
    definition.execution = {
      ...((definition.execution ?? {}) as Record<string, unknown>),
      env: { EVAL_RUNTIME_SECRET: 'secret-value' },
    }
    definition.graders = [
      {
        type: 'regex',
        name: 'answer',
        pattern: 'done',
        match: 'contains',
      },
      {
        type: 'tool_used',
        name: 'read',
        tool: 'Read',
        min: 1,
      },
    ]
    const caseDir = await writeCase(project, 'graders', definition)
    const loaded = await loadProjectEvalCase(caseDir)
    const result = await runProjectEvalCase({
      case: loaded,
      buildIdentity: TEST_BUILD_IDENTITY,
      factory: {
        identify: async (options) => testIdentity(options),
        create: async (options) => ({
          run: async () => {
            options.eventSink({
              type: 'tool-call',
              call: {
                id: 'secret-call',
                name: 'Read',
                input: { token: 'secret-value' },
              },
            })
            return { text: 'done', turns: 1 }
          },
        }),
      },
      run: 1,
      outputDir,
      version: 'test',
    })

    expect(result).toMatchObject({ passed: true, score: 1 })
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'grader:answer', passed: true }),
        expect.objectContaining({ name: 'grader:read', passed: true }),
      ]),
    )
    const trace = await readFile(
      join(outputDir, 'graders', 'run-1', 'trace.jsonl'),
      'utf8',
    )
    expect(trace).toContain('[REDACTED]')
    expect(trace).not.toContain('secret-value')
  })

  it('fails explicitly when the retained trace exceeds its byte bound', async () => {
    const project = await temporaryRoot('praxis-project-eval-trace-bound-')
    const outputDir = await temporaryRoot(
      'praxis-project-eval-trace-bound-out-',
    )
    const loaded = await loadProjectEvalCase(
      await writeCase(project, 'trace-bound'),
    )
    const result = await runProjectEvalCase({
      case: loaded,
      buildIdentity: TEST_BUILD_IDENTITY,
      factory: {
        identify: async (options) => testIdentity(options),
        create: async (options) => ({
          run: async () => {
            options.eventSink({
              type: 'tool-result',
              callId: 'oversized-trace',
              content: 'x'.repeat(8 * 1024 * 1024),
              isError: false,
            })
            return { text: 'done', turns: 1 }
          },
        }),
      },
      run: 1,
      outputDir,
      version: 'test',
    })

    expect(result.passed).toBe(false)
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'trace-bounds', passed: false }),
      ]),
    )
    const tracePath = join(outputDir, 'trace-bound', 'run-1', 'trace.jsonl')
    expect((await stat(tracePath)).size).toBeLessThanOrEqual(8 * 1024 * 1024)
  })

  it('fails when a runtime resolves after the harness timeout', async () => {
    const project = await temporaryRoot('praxis-project-eval-late-timeout-')
    const outputDir = await temporaryRoot(
      'praxis-project-eval-late-timeout-out-',
    )
    const loaded = await loadProjectEvalCase(await writeCase(project, 'late'))
    const result = await runProjectEvalCase({
      case: {
        ...loaded,
        execution: { ...loaded.execution, timeoutSeconds: 1 },
      },
      buildIdentity: TEST_BUILD_IDENTITY,
      factory: {
        identify: async (options) => ({
          providerId: 'test-provider',
          profileId: 'default',
          protocol: 'openai-compatible',
          endpoint: 'https://eval.test/v1',
          modelId: options.model ?? 'test-model',
        }),
        create: async () => ({
          run: async (_prompt, signal) =>
            new Promise((resolve) => {
              signal.addEventListener(
                'abort',
                () => setTimeout(() => resolve({ text: 'late', turns: 1 }), 25),
                { once: true },
              )
            }),
        }),
      },
      run: 1,
      outputDir,
      version: 'test',
    })
    expect(result).toMatchObject({
      passed: false,
      termination: 'timeout',
      error: 'Eval run timed out',
    })
  })

  it('fails when a runtime resolves after external cancellation', async () => {
    const project = await temporaryRoot('praxis-project-eval-late-cancel-')
    const outputDir = await temporaryRoot(
      'praxis-project-eval-late-cancel-out-',
    )
    const loaded = await loadProjectEvalCase(await writeCase(project, 'late'))
    const controller = new AbortController()
    const resultPromise = runProjectEvalCase({
      case: loaded,
      buildIdentity: TEST_BUILD_IDENTITY,
      factory: {
        identify: async (options) => testIdentity(options),
        create: async () => ({
          run: async (_prompt, signal) =>
            new Promise((resolve) => {
              signal.addEventListener(
                'abort',
                () => setTimeout(() => resolve({ text: 'late', turns: 1 }), 25),
                { once: true },
              )
              controller.abort('test cancellation')
            }),
        }),
      },
      run: 1,
      outputDir,
      version: 'test',
      signal: controller.signal,
    })
    const result = await resultPromise
    expect(result).toMatchObject({
      passed: false,
      termination: 'interrupted',
      error: 'Eval run interrupted',
    })
  })

  it('records verifier nonzero and timeout failures', async () => {
    const project = await temporaryRoot('praxis-project-eval-verifiers-')
    const outputDir = await temporaryRoot('praxis-project-eval-verifiers-out-')
    const definition = caseDefinition('verifiers')
    definition.verification = [
      {
        name: 'nonzero',
        command: process.execPath,
        args: ['-e', 'process.exit(3)'],
      },
      {
        name: 'timeout',
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 5000)'],
        timeout_seconds: 1,
      },
    ]
    const loaded = await loadProjectEvalCase(
      await writeCase(project, 'verifiers', definition),
    )
    const result = await runProjectEvalCase({
      case: loaded,
      buildIdentity: TEST_BUILD_IDENTITY,
      runVerification: true,
      factory: {
        identify: async (options) => testIdentity(options),
        create: async () => ({
          run: async () => ({ text: 'done', turns: 1 }),
        }),
      },
      run: 1,
      outputDir,
      version: 'test',
    })
    expect(result.passed).toBe(false)
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'verifier:nonzero', passed: false }),
        expect.objectContaining({ name: 'verifier:timeout', passed: false }),
      ]),
    )
    const verification = JSON.parse(
      await readFile(
        join(outputDir, 'verifiers', 'run-1', 'verification.json'),
        'utf8',
      ),
    ) as Array<Record<string, unknown>>
    expect(verification).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'nonzero', exit_code: 3 }),
        expect.objectContaining({ name: 'timeout', timed_out: true }),
      ]),
    )
  })

  it('keeps and records the temporary workspace when requested', async () => {
    const project = await temporaryRoot('praxis-project-eval-keep-temp-')
    const outputDir = await temporaryRoot('praxis-project-eval-keep-temp-out-')
    const loaded = await loadProjectEvalCase(await writeCase(project, 'kept'))
    const result = await runProjectEvalCase({
      case: loaded,
      buildIdentity: TEST_BUILD_IDENTITY,
      keepTemp: true,
      factory: {
        identify: async (options) => testIdentity(options),
        create: async () => ({
          run: async () => ({ text: 'done', turns: 1 }),
        }),
      },
      run: 1,
      outputDir,
      version: 'test',
    })
    expect(result.temp_root).toEqual(expect.any(String))
    await expect(stat(result.temp_root as string)).resolves.toBeDefined()
    await rm(result.temp_root as string, { recursive: true, force: true })
  })

  it('fails forbidden, missing, and source mutations with explicit checks', async () => {
    const project = await temporaryRoot('praxis-project-eval-outcomes-')
    const outputDir = await temporaryRoot('praxis-project-eval-output-')
    const definition = caseDefinition('negative')
    definition.expect = {
      allowed_changed_paths: ['forbidden.txt'],
      expected_changed_paths: ['required.txt'],
      forbidden_changed_paths: ['forbidden.txt'],
    }
    const caseDir = await writeCase(project, 'negative', definition)
    const loaded = await loadProjectEvalCase(caseDir)
    const result = await runProjectEvalCase({
      case: loaded,
      buildIdentity: TEST_BUILD_IDENTITY,
      factory: {
        identify: async (options) => testIdentity(options),
        create: async (options) => ({
          run: async () => {
            await writeFile(join(options.cwd, 'forbidden.txt'), 'forbidden')
            await writeFile(join(loaded.fixture, 'source.txt'), 'mutated')
            return { text: 'done', turns: 1 }
          },
        }),
      },
      run: 1,
      outputDir,
      version: 'test',
    })

    expect(result.passed).toBe(false)
    expect(result.score).toBe(0)
    expect(
      result.checks.find((check) => check.name === 'source-unchanged')?.passed,
    ).toBe(false)
    expect(
      result.checks.find((check) => check.name === 'expected-paths')?.passed,
    ).toBe(false)
    expect(
      result.checks.find((check) => check.name === 'forbidden-paths')?.passed,
    ).toBe(false)
  })

  it('classifies a runtime deadline as timeout', async () => {
    const project = await temporaryRoot('praxis-project-eval-timeout-')
    const outputDir = await temporaryRoot('praxis-project-eval-timeout-out-')
    const caseDir = await writeCase(project, 'timeout')
    const loaded = await loadProjectEvalCase(caseDir)
    const result = await runProjectEvalCase({
      case: {
        ...loaded,
        execution: { ...loaded.execution, timeoutSeconds: 0 },
      },
      buildIdentity: TEST_BUILD_IDENTITY,
      factory: {
        identify: async (options) => testIdentity(options),
        create: async () => ({
          run: async (_prompt, signal) =>
            new Promise((_, reject) => {
              signal.addEventListener(
                'abort',
                () => reject(new DOMException('aborted', 'AbortError')),
                { once: true },
              )
            }),
        }),
      },
      run: 1,
      outputDir,
      version: 'test',
    })
    expect(result).toMatchObject({ passed: false, termination: 'timeout' })
  })

  it('persists an interrupted only run and returns exit code 130', async () => {
    const project = await temporaryRoot('praxis-project-eval-interrupt-')
    const configRoot = await temporaryRoot(
      'praxis-project-eval-interrupt-config-',
    )
    await writeCase(project, 'interrupt')
    const controller = new AbortController()
    const output = capturedIo()
    const code = await executeProjectEvalCommand(
      [project, '--json'],
      output.io,
      {
        configRoot,
        loadBuildIdentity: loadTestBuildIdentity,
        runtimeFactory: {
          identify: async (options) => ({
            providerId: 'test-provider',
            profileId: 'default',
            protocol: 'openai-compatible',
            endpoint: 'https://eval.test/v1',
            modelId: options.model ?? 'test-model',
          }),
          create: async () => ({
            run: async (_prompt, signal) =>
              new Promise((_, reject) => {
                signal.addEventListener(
                  'abort',
                  () => reject(new DOMException('aborted', 'AbortError')),
                  { once: true },
                )
                controller.abort('test interruption')
              }),
          }),
        },
      },
      process.cwd(),
      controller.signal,
    )
    const aggregate = JSON.parse(output.stdout[0] ?? '{}') as Record<
      string,
      unknown
    >
    expect(code).toBe(130)
    expect(aggregate).toMatchObject({
      planned_run_count: 1,
      completed_run_count: 1,
      partial: true,
      interrupted: true,
    })
    expect((aggregate.runs as Array<Record<string, unknown>>)[0]).toMatchObject(
      { termination: 'interrupted', passed: false },
    )
    expect(
      await readJson(
        join(String(aggregate.output_dir), 'aggregate-result.json'),
      ),
    ).toEqual(aggregate)
  })

  it('parses repeatable comma-separated list flags without consuming target', () => {
    expect(
      parseProjectEvalOptions([
        '--tag',
        'fast,smoke',
        '--tag',
        'safe',
        '--allow-tools',
        'Bash,Edit',
        'target',
      ]),
    ).toMatchObject({
      target: 'target',
      tags: ['fast', 'smoke', 'safe'],
      allowTools: ['Bash', 'Edit'],
    })
  })
})
