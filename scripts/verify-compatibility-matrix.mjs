import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'

const projectRoot = process.cwd()
const compatibilityEnvironment = { ...process.env }
if (process.env.PRAXIS_CLAUDE_BINARY) {
  compatibilityEnvironment.PATH = `${dirname(
    process.env.PRAXIS_CLAUDE_BINARY,
  )}${delimiter}${process.env.PATH ?? ''}`
}
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
const retryableModelGates = new Set([
  'scripts/verify-claude-shared-resources.mjs',
  'scripts/verify-image-compatibility.mjs',
])
const maxDiagnosticsBytes = 64 * 1024
const transientModelPatterns = [
  'error_max_turns',
  '"stop_reason":"tool_use"',
  'Reached maximum number of turns',
  'Claude memoryBoundary did not expose marker SHARED_MEMORY_LINE_',
  'Claude reverse image resume did not expose marker PRAXIS_IMAGE_RESUME_OK',
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

function isTransientModelFailure(error) {
  const diagnostics =
    error && typeof error === 'object' && 'diagnostics' in error
      ? String(error.diagnostics)
      : ''
  return transientModelPatterns.some((pattern) => diagnostics.includes(pattern))
}

const startedAt = Date.now()
for (const [index, entrypoint] of entrypoints.entries()) {
  try {
    await run(entrypoint, index)
  } catch (error) {
    if (
      !retryableModelGates.has(entrypoint.file) ||
      !isTransientModelFailure(error)
    ) {
      throw error
    }
    console.warn(`\nRetrying nondeterministic model gate: ${entrypoint.file}`)
    await run(entrypoint, index)
  }
}
console.log(
  `\nCompatibility matrix passed: ${entrypoints.length} isolated gates in ${(
    (Date.now() - startedAt) /
    1000
  ).toFixed(1)}s.`,
)
