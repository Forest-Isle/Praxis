import { spawnSync } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = process.cwd()
const targetClaudeVersion = '2.1.237'
const auditedPraxisBase = '9cd0fb04aeebd83992cc9c88106ca71c09f66cb9'
const reportPath = 'docs/CORE_DESIGN_DRIFT_AUDIT.md'

const areas = [
  {
    id: 'runtime',
    issues: [135, 277],
    documents: ['docs/RUNTIME_CONTRACT.md'],
    fixtures: [
      [
        'src/core/runtime.test.ts',
        'emits the typed provider terminal reason to runtime observers',
      ],
      [
        'src/core/runtime.test.ts',
        'continues beyond the former default model turn limit',
      ],
      [
        'src/providers/fallback-provider.test.ts',
        'preserves one terminal event from the successful buffered attempt',
      ],
      [
        'src/application/session-service.test.ts',
        'stops a main session at an explicit model turn limit without rewriting completed entries',
      ],
    ],
    gates: ['test:runtime-compat', 'test:stream-json-compat'],
  },
  {
    id: 'context',
    issues: [151, 118],
    documents: ['docs/RUNTIME_CONTRACT.md'],
    fixtures: [
      [
        'src/core/context-budget.test.ts',
        'anchors occupancy at actual usage and adds only post-watermark growth',
      ],
      [
        'src/application/session-service.test.ts',
        'compacts over-budget context before the model turn and preserves append-only history',
      ],
      [
        'src/application/session-service.test.ts',
        'reactively retries a prompt-too-long failure once after auto-compacting',
      ],
      [
        'src/application/session-service.test.ts',
        'does not retry when reactive compaction makes no occupancy progress',
      ],
    ],
    gates: [
      'test:context-compat',
      'test:compaction-compat',
      'test:cross-version-compaction-compat',
    ],
  },
  {
    id: 'session-memory',
    issues: [344],
    documents: ['CONTEXT.md', 'docs/RUNTIME_CONTRACT.md'],
    fixtures: [
      [
        'src/application/session-memory.test.ts',
        'returns from a context observation before a slow extraction and lets compact wait',
      ],
      [
        'src/application/session-memory.test.ts',
        'retains the last good summary and watermark when the atomic commit fails',
      ],
      [
        'src/application/session-service.test.ts',
        'anchors manual compact on the session memory watermark and preserves a recent suffix',
      ],
    ],
    gates: ['test:compaction-compat', 'test:cross-version-compaction-compat'],
  },
  {
    id: 'project-memory',
    issues: [120],
    documents: ['CONTEXT.md', 'docs/RUNTIME_CONTRACT.md'],
    fixtures: [
      [
        'src/application/project-memory.test.ts',
        'uses one canonical project key across native and Claude linked worktrees',
      ],
      [
        'src/application/project-memory.test.ts',
        'bounds the injected index by both lines and UTF-8 bytes',
      ],
      [
        'src/application/project-memory.test.ts',
        'prefetches recall once without waiting and consumes only a settled bounded result',
      ],
      [
        'src/application/project-memory.test.ts',
        'extracts only after the durable cursor and advances it only on success',
      ],
    ],
    gates: ['test:memory-import-compat', 'test:shared-compat'],
  },
  {
    id: 'scheduling',
    issues: [119],
    documents: ['docs/RUNTIME_CONTRACT.md'],
    fixtures: [
      [
        'src/core/tool-scheduling-policy.test.ts',
        'fails closed for missing, throwing, and malformed classifiers',
      ],
      [
        'src/core/runtime.test.ts',
        'starts completed concurrent tool calls before the provider stream ends and exposes results in completion order',
      ],
      [
        'src/core/runtime.test.ts',
        'treats exclusive tools as FIFO barriers between concurrent groups',
      ],
    ],
    gates: ['test:runtime-compat'],
  },
  {
    id: 'prompt-cache',
    issues: [129, 117],
    documents: ['docs/RUNTIME_CONTRACT.md'],
    fixtures: [
      [
        'src/core/prompt-composer.test.ts',
        'returns an ordered structured manifest for the default prompt',
      ],
      [
        'src/compatibility/claude/context.test.ts',
        'invalidates only sections affected by the lifecycle reason',
      ],
      [
        'src/providers/anthropic-compatible.test.ts',
        'renders official Anthropic cache breakpoints at stable prompt boundaries',
      ],
      [
        'src/providers/anthropic-compatible.test.ts',
        'keeps stable prompt prefixes byte-identical as the conversation grows',
      ],
      [
        'src/providers/anthropic-prompt-cache.test.ts',
        'captures environment decisions for the lifetime of the resolver',
      ],
    ],
    gates: ['test:dynamic-system-compat', 'test:runtime-compat'],
  },
  {
    id: 'hooks',
    issues: [343, 124],
    documents: ['docs/RUNTIME_CONTRACT.md'],
    fixtures: [
      [
        'src/application/session-service.test.ts',
        'runs session hooks once across multiple prompts and closes idempotently',
      ],
      [
        'src/application/session-service.test.ts',
        'reruns SessionStart with compact source and refreshes runtime context after an automatic compact boundary',
      ],
      [
        'src/hooks/claude-hooks.test.ts',
        'emits Claude-compatible hook lifecycle events without changing hook semantics',
      ],
      [
        'src/hooks/claude-hooks.test.ts',
        'cancels async hooks when the bounded drain expires',
      ],
    ],
    gates: ['test:hook-compat'],
  },
  {
    id: 'transcript-session',
    issues: [134, 131],
    documents: ['docs/COMPATIBILITY.md', 'docs/RUNTIME_CONTRACT.md'],
    fixtures: [
      [
        'src/compatibility/claude/schema.test.ts',
        'round-trips Claude Code 2.1.208 entries without losing unknown fields',
      ],
      [
        'src/persistence/claude-transcript-store.test.ts',
        'branches from an earlier message while retaining physical tail checks',
      ],
      [
        'src/compatibility/claude/history.test.ts',
        'follows a compact boundary logical parent instead of an unrelated physical tail',
      ],
      [
        'src/compatibility/claude/fork.test.ts',
        'forks the active compact branch and excludes an unrelated physical tail',
      ],
      [
        'src/persistence/claude-session-index.test.ts',
        'reads head and tail metadata without parsing a large middle',
      ],
      [
        'src/application/session-service.test.ts',
        'replays an interrupted prompt exactly once only with explicit opt-in',
      ],
    ],
    gates: [
      'test:session-metadata-compat',
      'test:resume-at-compat',
      'test:resume-selector-compat',
      'test:recovery-compat',
      'test:cross-version-session-compat',
      'test:cross-version-resume-at-compat',
      'test:cross-version-fork-compat',
    ],
  },
  {
    id: 'subagents',
    issues: [157],
    documents: ['docs/SUBAGENT_CONTRACT.md'],
    fixtures: [
      [
        'src/application/subagent-service.test.ts',
        'hands a running foreground agent to background without repeating committed tool work',
      ],
      [
        'src/application/subagent-service.test.ts',
        'aborts and drains multiple live agents on close without terminal notifications or transcript deletion',
      ],
      [
        'src/application/subagent-service.test.ts',
        'hydrates an incomplete sidechain without replay and resumes it through one filtered continuation',
      ],
      [
        'src/application/subagent-service.test.ts',
        'contains corrupt persisted lifecycle recovery without mutating the parent or sidechain transcript',
      ],
      [
        'src/persistence/claude-sidechain-store.test.ts',
        'reads parent/worktree fields without discarding compatible unknown metadata',
      ],
      [
        'src/application/session-service.test.ts',
        'delivers a prior-turn completion notification exactly once after parent cancellation',
      ],
    ],
    gates: [
      'test:subagent-compat',
      'test:background-agent-compat',
      'test:cross-version-sidechain-compat',
    ],
  },
]

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function projectFile(path) {
  return readFile(join(projectRoot, path), 'utf8')
}

const packageDocument = JSON.parse(await projectFile('package.json'))
const report = await projectFile(reportPath)
const parityMatrix = await projectFile('docs/PARITY_MATRIX.md')
const compatibilityMatrix = await projectFile(
  'scripts/verify-compatibility-matrix.mjs',
)
const domainContext = await projectFile('CONTEXT.md')
const ciWorkflow = await projectFile('.github/workflows/ci.yml')

assert(
  report.includes(`Claude Code ${targetClaudeVersion}`),
  `Core drift report is not pinned to Claude ${targetClaudeVersion}`,
)
assert(
  report.includes(auditedPraxisBase),
  `Core drift report is not pinned to Praxis base ${auditedPraxisBase}`,
)
assert(
  parityMatrix.includes(
    '[Core Design Drift Audit](CORE_DESIGN_DRIFT_AUDIT.md)',
  ),
  'Parity matrix does not link the core design drift audit',
)
assert(
  parityMatrix.includes(
    `core-design target is Claude Code ${targetClaudeVersion}`,
  ),
  'Parity matrix does not distinguish the core-design target',
)
for (const heading of [
  '## Intentional Praxis differences',
  '## Deferred capabilities',
  '## Excluded surfaces',
  '## Qualification status',
]) {
  assert(report.includes(heading), `Core drift report is missing ${heading}`)
}
assert(
  report.includes('issues/342'),
  'Core drift report is missing the canonical vocabulary issue #342',
)
for (const term of [
  '**Transcript**',
  '**Session memory**',
  '**Project memory**',
  '**Session lifecycle**',
  '**Turn lifecycle**',
  '**Terminal event**',
  '**ContextEngine**',
]) {
  assert(domainContext.includes(term), `CONTEXT.md is missing ${term}`)
}

const areaIds = new Set()
const issueIds = new Set()
const fixtureIds = new Set()
const fixtureFiles = new Set()
const fixtureManifest = []
const gateIds = new Set()
for (const area of areas) {
  assert(!areaIds.has(area.id), `Duplicate core area: ${area.id}`)
  areaIds.add(area.id)
  assert(
    report.includes(`<!-- core-design-area:${area.id} -->`),
    `Core drift report is missing area ${area.id}`,
  )
  for (const issue of area.issues) {
    issueIds.add(issue)
    assert(
      report.includes(`issues/${issue}`),
      `Core drift report is missing issue #${issue}`,
    )
  }
  for (const document of area.documents) {
    await access(join(projectRoot, document))
    assert(
      report.includes(`\`${document}\``),
      `Core drift report is missing document evidence ${document}`,
    )
  }
  for (const [file, marker] of area.fixtures) {
    const fixtureId = `${file}\u0000${marker}`
    assert(!fixtureIds.has(fixtureId), `Duplicate fixture evidence: ${file}`)
    fixtureIds.add(fixtureId)
    fixtureFiles.add(file)
    fixtureManifest.push({ file, marker })
    assert(
      report.includes(`\`${file}\``),
      `Core drift report is missing fixture evidence ${file}`,
    )
  }
  for (const gate of area.gates) {
    gateIds.add(gate)
    const command = packageDocument.scripts?.[gate]
    assert(typeof command === 'string', `Missing package gate ${gate}`)
    const entrypoints = [
      ...command.matchAll(/node (scripts\/[a-z0-9-]+\.mjs)/gu),
    ]
    assert(entrypoints.length > 0, `Gate ${gate} has no script entrypoint`)
    for (const [, entrypoint] of entrypoints) {
      await access(join(projectRoot, entrypoint))
    }
    assert(
      report.includes(`\`${gate}\``),
      `Core drift report is missing compatibility gate ${gate}`,
    )
  }
}

const vitestEntrypoint = fileURLToPath(
  new URL('./vitest.mjs', import.meta.resolve('vitest/package.json')),
)
await access(vitestEntrypoint)
const fixtureRunDirectory = await mkdtemp(
  join(tmpdir(), 'praxis-core-drift-fixtures-'),
)
const fixtureReportPath = join(fixtureRunDirectory, 'vitest.json')
let fixtureRun
let fixtureReport
try {
  fixtureRun = spawnSync(
    process.execPath,
    [
      vitestEntrypoint,
      'run',
      ...fixtureFiles,
      '--reporter=json',
      `--outputFile=${fixtureReportPath}`,
    ],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    },
  )
  assert(
    fixtureRun.status === 0,
    `Core fixture run failed (${fixtureRun.status ?? fixtureRun.signal ?? 'unknown'}):\n${fixtureRun.stderr || fixtureRun.stdout}`,
  )
  fixtureReport = JSON.parse(await readFile(fixtureReportPath, 'utf8'))
} finally {
  await rm(fixtureRunDirectory, { recursive: true, force: true })
}

assert(fixtureReport?.success === true, 'Core fixture report is not successful')
assert(
  fixtureReport.numPendingTests === 0 && fixtureReport.numTodoTests === 0,
  'Core fixture run contains skipped or todo tests',
)
const resultsByFile = new Map(
  fixtureReport.testResults.map((result) => [resolve(result.name), result]),
)
for (const { file, marker } of fixtureManifest) {
  const result = resultsByFile.get(resolve(projectRoot, file))
  assert(result, `Core fixture file did not execute: ${file}`)
  const matchingAssertions = result.assertionResults.filter(
    (assertion) => assertion.title === marker,
  )
  assert(
    matchingAssertions.length === 1,
    `Expected one executed core fixture in ${file}, found ${matchingAssertions.length}: ${marker}`,
  )
  assert(
    matchingAssertions[0].status === 'passed',
    `Core fixture did not pass in ${file}: ${marker} (${matchingAssertions[0].status})`,
  )
}

const requiredIssues = [
  117, 118, 119, 120, 124, 129, 131, 134, 135, 151, 157, 277, 342, 343, 344,
]
issueIds.add(342)
assert(
  JSON.stringify([...issueIds].sort((left, right) => left - right)) ===
    JSON.stringify(requiredIssues),
  'Core drift evidence does not cover the complete prerequisite frontier',
)
assert(
  packageDocument.scripts?.['test:core-design-drift'] ===
    'npm run build && node scripts/verify-core-design-drift.mjs',
  'test:core-design-drift is not wired to the executable audit',
)
assert(
  compatibilityMatrix.includes("name.startsWith('test:')") &&
    !compatibilityMatrix.includes("'test:core-design-drift',"),
  'The aggregate compatibility matrix does not discover the core drift gate',
)
for (const requiredCiFragment of [
  'name: Claude 2.1.237 core drift',
  '@anthropic-ai/claude-code@2.1.237',
  'run: npm run test:core-design-drift',
  'run: npm run test:session-metadata-compat',
  'run: npm run test:background-agent-compat',
  'CORE_DRIFT_RESULT: ${{ needs.core-design-drift.result }}',
  'test "$CORE_DRIFT_RESULT" = success',
]) {
  assert(
    ciWorkflow.includes(requiredCiFragment),
    `Required Claude 2.1.237 CI wiring is missing: ${requiredCiFragment}`,
  )
}

console.log(
  `Claude ${targetClaudeVersion} core design drift audit passed: ${areas.length} areas, ${requiredIssues.length} prerequisite issues, ${fixtureIds.size} executed contract fixtures, ${gateIds.size} compatibility gates, Praxis base ${auditedPraxisBase.slice(0, 8)}.`,
)
