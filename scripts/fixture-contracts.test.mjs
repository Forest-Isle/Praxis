import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fixtureContractDiagnostics } from './lib/fixture-contracts.mjs'
import {
  runFixtureContracts,
  sanitizedEnvironment,
} from './run-fixture-contracts.mjs'

const clone = (value) => JSON.parse(JSON.stringify(value))

const baseManifest = {
  schemaVersion: 1,
  behaviors: [
    {
      id: 'core.runtime.turn.limit',
      seam: 'AgentRuntime',
      contract: 'A run enforces its per-run maximum model turn limit.',
      status: 'qualified',
      modules: ['src/core/runtime.ts'],
      outcomes: ['The run stops at the configured maximum.'],
      evidence: [
        {
          kind: 'vitest',
          file: 'src/core/runtime.test.ts',
          testName: 'AgentRuntime > honors a per-run maximum model turn limit',
        },
      ],
    },
  ],
  gates: [{ id: 'fixtures', script: 'test:fixtures', ciJob: 'fixtures' }],
}

const temporaryRepositories = []

async function createRepository({ fixtures = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'praxis-fixture-contracts-'))
  temporaryRepositories.push(root)
  await mkdir(join(root, 'src/core'), { recursive: true })
  await mkdir(join(root, 'test/fixtures/native'), { recursive: true })
  await mkdir(join(root, 'test/fixtures/reference'), { recursive: true })
  await writeFile(join(root, 'src/core/runtime.ts'), '')
  await writeFile(join(root, 'src/core/runtime.test.ts'), '')
  for (const path of fixtures) await writeFile(join(root, path), 'fixture')
  return root
}

afterEach(async () => {
  for (const root of temporaryRepositories.splice(0))
    await rm(root, { recursive: true })
})

const context = (root, manifest = baseManifest) => ({
  root,
  manifest,
  packageData: {
    scripts: { 'test:fixtures': 'node scripts/run-fixture-contracts.mjs' },
  },
  workflow: {
    jobs: {
      fixtures: { steps: [{ run: 'npm run test:fixtures' }] },
      'native-deletion': { steps: [{ run: 'npm run test:native:deletion' }] },
      required: {
        needs: ['fixtures'],
        steps: [
          {
            env: { FIXTURES_RESULT: '${{ needs.fixtures.result }}' },
            run: 'test "$FIXTURES_RESULT" = success',
          },
        ],
      },
    },
  },
})

async function prepareRunnerRepository(root, script = 'node runner.mjs') {
  await mkdir(join(root, '.github/workflows'), { recursive: true })
  await writeFile(
    join(root, 'test/fixtures/manifest.json'),
    JSON.stringify(baseManifest),
  )
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { 'test:fixtures': script } }),
  )
  await writeFile(
    join(root, '.github/workflows/ci.yml'),
    'jobs:\n  fixtures:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run test:fixtures\n  required:\n    needs: [fixtures]\n    if: always()\n    steps:\n      - env:\n          FIXTURES_RESULT: ${{ needs.fixtures.result }}\n        run: test "$FIXTURES_RESULT" = success\n',
  )
}

function fakeChild(exitCode = 0) {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  process.nextTick(() => {
    child.stdout.end('final stdout chunk')
    child.stderr.end('')
    child.emit('close', exitCode)
  })
  return child
}

describe('fixture contract verifier', () => {
  it('accepts the qualified tracer behavior', async () => {
    const root = await createRepository()
    await expect(fixtureContractDiagnostics(context(root))).resolves.toEqual([])
  })

  it('accepts a gate-only qualified behavior when the gate is wired', async () => {
    const root = await createRepository()
    const manifest = clone(baseManifest)
    manifest.behaviors[0].evidence = [{ kind: 'gate', gate: 'fixtures' }]
    await expect(
      fixtureContractDiagnostics(context(root, manifest)),
    ).resolves.toEqual([])
  })

  it.each([
    ['empty', ''],
    ['whitespace', '  \t\n  '],
    ['true', 'true'],
    ['colon', ':'],
    ['exit 0', 'exit 0'],
    ['pure echo', 'echo preparing'],
    ['pure printf', 'printf preparing'],
    ['self-recursion', 'npm run test:fixtures'],
    ['self-recursion with separator', 'npm run test:fixtures --'],
  ])(
    'rejects a %s package-script qualification command',
    async (_name, script) => {
      const root = await createRepository()
      const diagnostics = await fixtureContractDiagnostics({
        ...context(root),
        packageData: { scripts: { 'test:fixtures': script } },
      })
      expect(diagnostics.join('\n')).toContain(
        "package script 'test:fixtures' is not an executable qualification command",
      )
    },
  )

  it('accepts a logging command chained to executable gate evidence', async () => {
    const root = await createRepository()
    await expect(
      fixtureContractDiagnostics({
        ...context(root),
        packageData: {
          scripts: {
            'test:fixtures':
              'echo preparing && node scripts/run-fixture-contracts.mjs',
          },
        },
      }),
    ).resolves.toEqual([])
  })

  it('rejects qualified fixture-only evidence', async () => {
    const root = await createRepository({
      fixtures: ['test/fixtures/native/a.json'],
    })
    const manifest = clone(baseManifest)
    manifest.behaviors[0].evidence = [
      { kind: 'fixture', path: 'test/fixtures/native/a.json' },
    ]
    const diagnostics = await fixtureContractDiagnostics(
      context(root, manifest),
    )
    expect(diagnostics.join('\n')).toContain('qualified behavior')
  })

  it('accepts excluded behavior with empty modules and evidence', async () => {
    const root = await createRepository()
    const manifest = clone(baseManifest)
    manifest.behaviors[0] = {
      id: 'core.removed',
      seam: 'Removed',
      contract: 'Removed surface.',
      status: 'excluded',
      modules: [],
      outcomes: ['The surface is unavailable.'],
      evidence: [],
      reason: 'Removed by ADR 0002.',
    }
    await expect(
      fixtureContractDiagnostics(context(root, manifest)),
    ).resolves.toEqual([])
  })

  it('rejects executable evidence on excluded behavior', async () => {
    const root = await createRepository()
    const manifest = clone(baseManifest)
    manifest.behaviors[0].status = 'excluded'
    manifest.behaviors[0].reason = 'Removed by ADR 0002.'
    const diagnostics = await fixtureContractDiagnostics(
      context(root, manifest),
    )
    expect(diagnostics.join('\n')).toContain('may not pretend to pass')
  })

  it('rejects a CI job that does not invoke the referenced gate script', async () => {
    const root = await createRepository()
    const manifest = clone(baseManifest)
    manifest.gates[0] = {
      id: 'fixtures',
      script: 'test:fixtures',
      ciJob: 'fixtures',
    }
    const diagnostics = await fixtureContractDiagnostics({
      root,
      manifest,
      packageData: {
        scripts: { 'test:fixtures': 'node scripts/run-fixture-contracts.mjs' },
      },
      workflow: { jobs: { fixtures: { steps: [{ run: 'npm test' }] } } },
    })
    expect(diagnostics.join('\n')).toContain('does not run')
  })

  it('rejects a runnable gate omitted from required needs', async () => {
    const root = await createRepository()
    const workflow = clone(context(root).workflow)
    workflow.jobs.required.needs = []
    const diagnostics = await fixtureContractDiagnostics({
      root,
      manifest: baseManifest,
      packageData: {
        scripts: { 'test:fixtures': 'node scripts/run-fixture-contracts.mjs' },
      },
      workflow,
    })
    expect(diagnostics.join('\n')).toContain(
      "gate 'fixtures' CI job 'fixtures' is not required by jobs.required",
    )
  })

  it('rejects a required result exported without a success assertion', async () => {
    const root = await createRepository()
    const workflow = clone(context(root).workflow)
    workflow.jobs.required.steps[0].run = 'echo "$FIXTURES_RESULT"'
    const diagnostics = await fixtureContractDiagnostics({
      root,
      manifest: baseManifest,
      packageData: {
        scripts: { 'test:fixtures': 'node scripts/run-fixture-contracts.mjs' },
      },
      workflow,
    })
    expect(diagnostics.join('\n')).toContain(
      "gate 'fixtures' CI job 'fixtures' required result FIXTURES_RESULT is not asserted",
    )
  })

  it('fails closed for non-array behaviors without spawning Vitest', async () => {
    const root = await createRepository()
    await prepareRunnerRepository(root)
    const malformed = clone(baseManifest)
    malformed.behaviors = { unexpected: true }
    await writeFile(
      join(root, 'test/fixtures/manifest.json'),
      JSON.stringify(malformed),
    )
    let spawned = false
    const result = await runFixtureContracts({
      root,
      spawn: () => {
        spawned = true
        return fakeChild()
      },
    })
    expect(result.ok).toBe(false)
    expect(result.diagnostics.join('\n')).toContain(
      'behaviors must be an array',
    )
    expect(spawned).toBe(false)
  })

  it('fails closed for invalid manifest JSON without spawning Vitest', async () => {
    const root = await createRepository()
    await prepareRunnerRepository(root)
    await writeFile(join(root, 'test/fixtures/manifest.json'), '{ invalid')
    let spawned = false
    const result = await runFixtureContracts({
      root,
      spawn: () => {
        spawned = true
        return fakeChild()
      },
    })
    expect(result.ok).toBe(false)
    expect(result.diagnostics.join('\n')).toContain(
      'manifest JSON could not be read or parsed',
    )
    expect(spawned).toBe(false)
  })

  it.each([
    [
      'duplicate behavior IDs',
      (manifest) => manifest.behaviors.push({ ...manifest.behaviors[0] }),
      'duplicate behavior id',
    ],
    [
      'path escape',
      (manifest) => {
        manifest.behaviors[0].modules[0] = '../outside.ts'
      },
      'repository-relative',
    ],
    [
      'missing Vitest evidence',
      (manifest) => {
        manifest.behaviors[0].evidence = []
      },
      'qualified behavior',
    ],
    [
      'unknown behavior field',
      (manifest) => {
        manifest.behaviors[0].extra = true
      },
      'unknown key',
    ],
    [
      'unknown status',
      (manifest) => {
        manifest.behaviors[0].status = 'passing'
      },
      'status',
    ],
    [
      'unknown evidence kind',
      (manifest) => {
        manifest.behaviors[0].evidence[0] = { kind: 'snapshot' }
      },
      'evidence',
    ],
    [
      'unknown gate',
      (manifest) => {
        manifest.gates[0].script = 'missing-script'
      },
      'package script',
    ],
    [
      'unknown test file',
      (manifest) => {
        manifest.behaviors[0].evidence[0].file = 'src/core/missing.test.ts'
      },
      'does not exist',
    ],
    [
      'unknown production module',
      (manifest) => {
        manifest.behaviors[0].modules[0] = 'src/core/missing.ts'
      },
      'does not exist',
    ],
  ])('rejects %s', async (_name, mutate, expected) => {
    const root = await createRepository()
    const manifest = clone(baseManifest)
    mutate(manifest)
    const diagnostics = await fixtureContractDiagnostics(
      context(root, manifest),
    )
    expect(diagnostics.join('\n').toLowerCase()).toContain(expected)
  })

  it('rejects symlinked paths and duplicate or orphaned fixtures', async () => {
    const root = await createRepository({
      fixtures: ['test/fixtures/native/a.json'],
    })
    await symlink(
      join(root, 'src/core/runtime.ts'),
      join(root, 'src/core/link.ts'),
    )
    const manifest = clone(baseManifest)
    manifest.behaviors[0].modules.push('src/core/link.ts')
    let diagnostics = await fixtureContractDiagnostics(context(root, manifest))
    expect(diagnostics.join('\n')).toContain('symlink')

    manifest.behaviors[0].modules.pop()
    manifest.behaviors[0].evidence.push({
      kind: 'fixture',
      path: 'test/fixtures/native/a.json',
    })
    manifest.behaviors.push({
      ...clone(baseManifest.behaviors[0]),
      id: 'core.other',
      evidence: [{ kind: 'fixture', path: 'test/fixtures/native/a.json' }],
    })
    diagnostics = await fixtureContractDiagnostics(context(root, manifest))
    expect(diagnostics.join('\n')).toContain('owned')

    manifest.behaviors.pop()
    manifest.behaviors[0].evidence.pop()
    diagnostics = await fixtureContractDiagnostics(context(root, manifest))
    expect(diagnostics.join('\n')).toContain('orphan')
  })

  it('reports files in an unapproved legacy fixture root as orphaned', async () => {
    const root = await createRepository()
    await writeFile(join(root, 'test/fixtures/legacy.json'), 'legacy')
    const diagnostics = await fixtureContractDiagnostics(context(root))
    expect(diagnostics.join('\n')).toContain(
      "orphan fixture 'test/fixtures/legacy.json'",
    )
  })

  it('runs each referenced Vitest file through the injected process seam', async () => {
    const root = await createRepository()
    await prepareRunnerRepository(root)
    const calls = []
    const spawn = (executable, args, options) => {
      calls.push({ executable, args, options })
      return fakeChild()
    }
    const result = await runFixtureContracts({
      root,
      spawn,
      readJson: async () => ({
        testResults: [
          {
            assertionResults: [
              {
                ancestorTitles: ['AgentRuntime'],
                title: 'honors a per-run maximum model turn limit',
                status: 'passed',
              },
            ],
          },
        ],
      }),
    })
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toEqual([
      'run',
      'src/core/runtime.test.ts',
      '--reporter=json',
      expect.stringMatching(/^--outputFile=/),
    ])
    expect(calls[0].options.shell).toBe(false)
  })

  it('reports failed assertions from a readable nonzero Vitest report', async () => {
    const root = await createRepository()
    await prepareRunnerRepository(root)
    const result = await runFixtureContracts({
      root,
      spawn: () => fakeChild(1),
      readJson: async () => ({
        testResults: [
          {
            assertionResults: [
              {
                ancestorTitles: ['AgentRuntime'],
                title: 'honors a per-run maximum model turn limit',
                status: 'passed',
              },
              {
                ancestorTitles: ['AgentRuntime'],
                title: 'reports the failed model turn limit assertion',
                status: 'failed',
              },
            ],
          },
        ],
      }),
    })
    expect(result.ok).toBe(false)
    const diagnostics = result.diagnostics.join('\n')
    expect(diagnostics).toContain(
      "Vitest evidence file 'src/core/runtime.test.ts' assertion 'AgentRuntime > reports the failed model turn limit assertion' has status failed",
    )
    expect(diagnostics).not.toContain(
      "Vitest evidence file 'src/core/runtime.test.ts' assertion 'AgentRuntime > honors a per-run maximum model turn limit' has status passed",
    )
  })

  it('rejects a referenced skipped assertion even when Vitest exits successfully', async () => {
    const root = await createRepository()
    await prepareRunnerRepository(root, 'run')
    const spawn = () => fakeChild()
    const result = await runFixtureContracts({
      root,
      spawn,
      readJson: async () => ({
        testResults: [
          {
            assertionResults: [
              {
                ancestorTitles: ['AgentRuntime'],
                title: 'honors a per-run maximum model turn limit',
                status: 'skipped',
              },
            ],
          },
        ],
      }),
    })
    expect(result.ok).toBe(false)
    expect(result.diagnostics.join('\n')).toContain('status skipped')
  })

  it.each([
    ['missing', []],
    [
      'duplicate',
      [
        {
          ancestorTitles: ['AgentRuntime'],
          title: 'honors a per-run maximum model turn limit',
          status: 'passed',
        },
        {
          ancestorTitles: ['AgentRuntime'],
          title: 'honors a per-run maximum model turn limit',
          status: 'passed',
        },
      ],
    ],
  ])('rejects a %s exact referenced title', async (_name, assertionResults) => {
    const root = await createRepository()
    await prepareRunnerRepository(root)
    const result = await runFixtureContracts({
      root,
      spawn: () => fakeChild(),
      readJson: async () => ({ testResults: [{ assertionResults }] }),
    })
    expect(result.ok).toBe(false)
    expect(result.diagnostics.join('\n')).toContain(
      "behavior 'core.runtime.turn.limit' evidence src/core/runtime.test.ts 'AgentRuntime > honors a per-run maximum model turn limit' matched",
    )
    expect(result.diagnostics.join('\n')).toContain(
      `matched ${assertionResults.length} Vitest assertions`,
    )
  })

  it('rejects nonzero Vitest exit and unreadable JSON output', async () => {
    const root = await createRepository()
    await prepareRunnerRepository(root)
    const result = await runFixtureContracts({
      root,
      spawn: () => fakeChild(1),
      readJson: async () => {
        throw new Error('report missing')
      },
    })
    expect(result.ok).toBe(false)
    const diagnostics = result.diagnostics.join('\n')
    expect(diagnostics).toContain('produced no readable JSON report')
    expect(diagnostics).toContain('exited with code 1')
  })

  it('sanitizes provider, Claude, Praxis, and Codex state while retaining PATH', () => {
    const environment = sanitizedEnvironment({
      PATH: '/bin',
      PRAXIS_HOME: '/tmp/praxis',
      PRAXIS_MODEL: 'model',
      CODEX_HOME: '/tmp/codex',
      OPENAI_API_KEY: 'secret',
      CLAUDE_CONFIG_DIR: '/tmp/claude',
    })
    expect(environment.PATH).toBe('/bin')
    for (const key of [
      'PRAXIS_HOME',
      'PRAXIS_MODEL',
      'CODEX_HOME',
      'OPENAI_API_KEY',
      'CLAUDE_CONFIG_DIR',
    ])
      expect(environment).not.toHaveProperty(key)
  })
})
