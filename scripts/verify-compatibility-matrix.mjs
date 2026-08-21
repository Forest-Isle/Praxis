import { execFileSync, spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'

const projectRoot = process.cwd()
const compatibilityEnvironment = { ...process.env }
compatibilityEnvironment.PRAXIS_PROVIDER = 'openai'
const claudeBinary = process.env.PRAXIS_CLAUDE_BINARY ?? 'claude'
const wrapperPath = realpathSync(join(projectRoot, 'scripts', 'claude'))
const candidates = execFileSync('which', ['-a', claudeBinary], {
  encoding: 'utf8',
})
  .trim()
  .split(/\r?\n/u)
  .map((path) => realpathSync(path))
const realClaudeBinary = candidates.find((path) => path !== wrapperPath)
if (!realClaudeBinary) throw new Error('Could not resolve real Claude binary')
compatibilityEnvironment.PRAXIS_REAL_CLAUDE_BINARY = realClaudeBinary
compatibilityEnvironment.PRAXIS_DATA_PLANE = 'claude'
compatibilityEnvironment.PATH = `${join(projectRoot, 'scripts')}${delimiter}${dirname(realClaudeBinary)}${delimiter}${process.env.PATH ?? ''}`
const packageDocument = JSON.parse(
  await readFile(join(projectRoot, 'package.json'), 'utf8'),
)
const excluded = new Set([
  'test:compat:all',
  'test:docs',
  'test:package',
  'test:performance',
])
const entrypoints = []
const seen = new Set()
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
  ['scripts/verify-plugin-eval-compatibility.mjs', ['PRAXIS_CLAUDE_BINARY']],
  ['scripts/verify-tui-compatibility.mjs', ['PRAXIS_CLAUDE_2_1_208']],
])
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

for (const [name, command] of Object.entries(packageDocument.scripts ?? {})) {
  if (!name.startsWith('test:') || excluded.has(name)) continue
  const parts = String(command).split(' && ')
  if (parts.shift() !== 'npm run build' || parts.length === 0) {
    throw new Error(`${name} does not follow compatibility gate command shape`)
  }
  for (const part of parts) {
    const match = /^node (scripts\/[a-z0-9-]+\.mjs)$/u.exec(part)
    if (!match) {
      throw new Error(`${name} has unsupported compatibility command: ${part}`)
    }
    const file = match[1]
    if (seen.has(file)) throw new Error(`Duplicate compatibility gate: ${file}`)
    seen.add(file)
    entrypoints.push({ name, file })
  }
}

if (entrypoints.length === 0)
  throw new Error('No compatibility gates discovered')

const skippedEntrypoints = entrypoints.flatMap((entrypoint) => {
  const missing = (requiredEnvironment.get(entrypoint.file) ?? []).filter(
    (name) => !compatibilityEnvironment[name],
  )
  return missing.length > 0 ? [{ ...entrypoint, missing }] : []
})
const runnableEntrypoints = entrypoints.filter(
  (entrypoint) =>
    !skippedEntrypoints.some((skipped) => skipped.file === entrypoint.file),
)
for (const skipped of skippedEntrypoints) {
  console.warn(
    `[compatibility skipped ${skipped.name}: ${skipped.file}; missing ${skipped.missing.join(', ')}]`,
  )
}

function run({ name, file }, index) {
  return new Promise((resolve, reject) => {
    const label = `${index + 1}/${entrypoints.length} ${name}: ${file}`
    console.log(`\n[compatibility ${label}]`)
    const child = spawn(process.execPath, [file], {
      cwd: projectRoot,
      env: compatibilityEnvironment,
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

const startedAt = Date.now()
for (const [index, entrypoint] of runnableEntrypoints.entries()) {
  try {
    await run(entrypoint, index)
  } catch (error) {
    if (
      !retryableTransientGates.has(entrypoint.file) ||
      !isTransientFailure(error)
    ) {
      throw error
    }
    console.warn(`\nRetrying transient compatibility gate: ${entrypoint.file}`)
    await run(entrypoint, index)
  }
}
console.log(
  `\nCompatibility matrix passed: ${runnableEntrypoints.length} isolated gates${skippedEntrypoints.length > 0 ? `; skipped ${skippedEntrypoints.length} environment-gated lanes` : ''} in ${(
    (Date.now() - startedAt) /
    1000
  ).toFixed(1)}s.`,
)
