import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  applyCompatibilityEndpointModelOverrides,
  buildQualificationEnvironment,
  canonicalizePrerequisiteBinaries,
  classifyGateError,
  classifyQualification,
  discoverCompatibilityEntrypoints,
  findMissingPrerequisites,
  qualificationExitCode,
  resolvePrimaryReferenceBinary,
} from './lib/compatibility-qualification.mjs'

const projectRoot = process.cwd()
const claudeBinary = process.env.PRAXIS_CLAUDE_BINARY ?? 'claude'
const wrapperPath = realpathSync(join(projectRoot, 'scripts', 'claude'))
const realClaudeBinary = resolvePrimaryReferenceBinary(claudeBinary, {
  path: process.env.PATH,
  wrapperPath,
})
if (!realClaudeBinary) {
  console.error(
    `[qualification blocked] unable to resolve a non-wrapper Claude binary for PRAXIS_CLAUDE_BINARY`,
  )
  process.exit(2)
}
let compatibilityEnvironment = buildQualificationEnvironment(process.env, {
  configRoot: undefined,
  projectRoot,
  realClaudeBinary,
  referenceBinary: realClaudeBinary,
})
compatibilityEnvironment = applyCompatibilityEndpointModelOverrides(
  compatibilityEnvironment,
  process.env,
)
const packageDocument = JSON.parse(
  await readFile(join(projectRoot, 'package.json'), 'utf8'),
)
const requiredEnvironment = new Map([
  [
    'scripts/verify-cross-version-session-compatibility.mjs',
    ['PRAXIS_CLAUDE_BINARY', 'PRAXIS_CLAUDE_CROSS_VERSION_BINARY'],
  ],
  [
    'scripts/verify-cross-version-resume-at-compatibility.mjs',
    ['PRAXIS_CLAUDE_BINARY', 'PRAXIS_CLAUDE_CROSS_VERSION_BINARY'],
  ],
  [
    'scripts/verify-cross-version-fork-compatibility.mjs',
    ['PRAXIS_CLAUDE_BINARY', 'PRAXIS_CLAUDE_CROSS_VERSION_BINARY'],
  ],
  [
    'scripts/verify-cross-version-sidechain-compatibility.mjs',
    ['PRAXIS_CLAUDE_BINARY', 'PRAXIS_CLAUDE_CROSS_VERSION_BINARY'],
  ],
  [
    'scripts/verify-cross-version-compaction-compatibility.mjs',
    ['PRAXIS_CLAUDE_BINARY', 'PRAXIS_CLAUDE_CROSS_VERSION_BINARY'],
  ],
  [
    'scripts/verify-session-metadata-compatibility.mjs',
    ['PRAXIS_CLAUDE_2_1_237'],
  ],
  ['scripts/verify-subagent-compatibility.mjs', ['PRAXIS_CLAUDE_2_1_237']],
  [
    'scripts/verify-background-agent-compatibility.mjs',
    ['PRAXIS_CLAUDE_2_1_237'],
  ],
  ['scripts/verify-plugin-maintenance.mjs', ['PRAXIS_CLAUDE_2_1_237']],
  ['scripts/verify-plugin-eval-compatibility.mjs', ['PRAXIS_CLAUDE_2_1_237']],
  ['scripts/verify-tui-compatibility.mjs', ['PRAXIS_CLAUDE_2_1_208']],
])
const claude237PrimaryEntrypoints = new Set([
  'scripts/verify-session-metadata-compatibility.mjs',
  'scripts/verify-subagent-compatibility.mjs',
  'scripts/verify-background-agent-compatibility.mjs',
  'scripts/verify-plugin-maintenance.mjs',
  'scripts/verify-mcp-oauth-serve.mjs',
])
const optionalEnvironment = new Map()
const retryableTransientGates = new Set([
  'scripts/verify-claude-compatibility.mjs',
  'scripts/verify-claude-shared-resources.mjs',
  'scripts/verify-conditional-rules.mjs',
  'scripts/verify-extension-compatibility.mjs',
  'scripts/verify-image-compatibility.mjs',
  'scripts/verify-interactive-plan-compatibility.mjs',
  'scripts/verify-mcp-oauth-serve.mjs',
  'scripts/verify-runtime-compatibility.mjs',
])
const maxDiagnosticsBytes = 64 * 1024
const transientModelPatterns = [
  'Claude exited with 143',
  'error_max_turns',
  '"stop_reason":"tool_use"',
  'Reached maximum number of turns',
  'did not expose marker SHARED_',
  'Claude image resume did not expose marker IMAGE_WRITER_OK',
  'Claude reverse image resume did not expose marker PRAXIS_IMAGE_RESUME_OK',
  'did not write one successful tool result',
  'activation was',
  'MCP error -32000: Connection closed',
  'claude interactive timed out',
  'Claude did not recover Praxis runtime',
]

const entrypoints = discoverCompatibilityEntrypoints(packageDocument.scripts)

const canonicalized = canonicalizePrerequisiteBinaries(compatibilityEnvironment)
compatibilityEnvironment = canonicalized.environment
if (!compatibilityEnvironment.PRAXIS_CLAUDE_2_1_237) {
  console.error(
    '[qualification blocked] Claude 2.1.237 binary is missing or invalid; set PRAXIS_CLAUDE_2_1_237 to the pinned executable',
  )
  process.exit(2)
}
const missingEntrypoints = findMissingPrerequisites(
  entrypoints,
  requiredEnvironment,
  compatibilityEnvironment,
  canonicalized.invalid,
)
if (missingEntrypoints.length > 0) {
  for (const skipped of missingEntrypoints) {
    console.warn(
      `[qualification blocked] ${skipped.name}: ${skipped.file}; missing or invalid ${skipped.missing.join(', ')}`,
    )
  }
  process.exit(2)
}
const skippedEntrypoints = findMissingPrerequisites(
  entrypoints,
  optionalEnvironment,
  compatibilityEnvironment,
  canonicalized.invalid,
)
const skippedFiles = new Set(skippedEntrypoints.map(({ file }) => file))
const runnableEntrypoints = entrypoints.filter(
  ({ file }) => !skippedFiles.has(file),
)
for (const skipped of skippedEntrypoints) {
  console.warn(
    `[qualification skipped] ${skipped.name}: ${skipped.file}; missing ${skipped.missing.join(', ')}`,
  )
}

function run({ name, file }, index) {
  return new Promise((resolve, reject) => {
    const label = `${index + 1}/${entrypoints.length} ${name}: ${file}`
    console.log(`\n[compatibility ${label}]`)
    const childEnvironment = claude237PrimaryEntrypoints.has(file)
      ? {
          ...compatibilityEnvironment,
          PRAXIS_CLAUDE_BINARY: compatibilityEnvironment.PRAXIS_CLAUDE_2_1_237,
          PRAXIS_REAL_CLAUDE_BINARY:
            compatibilityEnvironment.PRAXIS_CLAUDE_2_1_237,
        }
      : compatibilityEnvironment
    const child = spawn(process.execPath, [file], {
      cwd: projectRoot,
      env: childEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let diagnostics = ''
    const capture = (chunk, destination) => {
      destination.write(chunk)
      diagnostics = `${diagnostics}${chunk.toString('utf8')}`.slice(
        -maxDiagnosticsBytes,
      )
    }
    child.stdout.on('data', (chunk) => capture(chunk, process.stdout))
    child.stderr.on('data', (chunk) => capture(chunk, process.stderr))
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else {
        const error = new Error(
          `${file} failed${signal ? ` with signal ${signal}` : ` with exit ${code}`}`,
        )
        error.diagnostics = diagnostics
        reject(error)
      }
    })
  })
}

function isTransientFailure(error) {
  const diagnostics =
    error && typeof error === 'object' && 'diagnostics' in error
      ? String(error.diagnostics)
      : ''
  return transientModelPatterns.some((pattern) => diagnostics.includes(pattern))
}

const fallbackConfigRoot = await mkdtemp(
  join(tmpdir(), 'praxis-compat-matrix-'),
)
compatibilityEnvironment.PRAXIS_COMPAT_SEED_CLAUDE_CONFIG = '1'
compatibilityEnvironment.CLAUDE_CONFIG_DIR = fallbackConfigRoot
try {
  const startedAt = Date.now()
  const blocked = []
  const failures = []
  let attempted = 0
  for (const [index, entrypoint] of runnableEntrypoints.entries()) {
    attempted += 1
    try {
      await run(entrypoint, index)
    } catch (error) {
      if (
        !retryableTransientGates.has(entrypoint.file) ||
        !isTransientFailure(error)
      ) {
        const outcome = classifyGateError(error)
        if (outcome.verdict === 'blocked') {
          blocked.push({ entrypoint, outcome })
          break
        }
        failures.push({ entrypoint, error })
      } else {
        console.warn(
          `\nRetrying transient compatibility gate: ${entrypoint.file}`,
        )
        try {
          await run(entrypoint, index)
        } catch (retryError) {
          const outcome = classifyGateError(retryError)
          if (outcome.verdict === 'blocked') {
            blocked.push({ entrypoint, outcome })
            break
          }
          failures.push({ entrypoint, error: retryError })
        }
      }
    }
  }
  const verdict = classifyQualification({
    failures: failures.length,
    blocked: blocked.length,
    skipped: skippedEntrypoints.length,
  })
  const duration = ((Date.now() - startedAt) / 1000).toFixed(1)
  for (const { entrypoint, outcome } of blocked) {
    console.error(
      `[qualification blocked] ${entrypoint.file}: ${outcome.prerequisite}`,
    )
  }
  if (verdict === 'complete') {
    console.log(
      `\n[qualification complete] ${runnableEntrypoints.length} isolated gates in ${duration}s.`,
    )
  } else if (verdict === 'blocked') {
    console.error(
      `[qualification blocked] ${blocked.length} external prerequisite lane(s); ${attempted} gates attempted in ${duration}s.`,
    )
  } else if (verdict === 'skipped') {
    console.error(
      `[qualification skipped] ${skippedEntrypoints.length} lane(s); qualification did not complete in ${duration}s.`,
    )
  } else {
    for (const { entrypoint, error } of failures) {
      console.error(
        `[qualification failed] ${entrypoint.file}: ${error.message}`,
      )
    }
    console.error(
      `[qualification failed] ${failures.length} gate(s) failed and ${blocked.length} blocked; ${attempted} gates attempted in ${duration}s.`,
    )
  }
  process.exitCode = qualificationExitCode(verdict)
} finally {
  await rm(fallbackConfigRoot, { recursive: true, force: true })
}
