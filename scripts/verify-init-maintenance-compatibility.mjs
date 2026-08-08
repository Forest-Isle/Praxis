import { execFile } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-init-maintenance-'))
const cwd = join(root, 'project')
const configRoot = join(root, 'config')
const marker = join(root, 'hooks.log')
await mkdir(cwd)
await mkdir(configRoot)

const hookCode = [
  "let source=''",
  "process.stdin.setEncoding('utf8')",
  "process.stdin.on('data', chunk => source += chunk)",
  "process.stdin.on('end', () => { const input = JSON.parse(source); require('node:fs').appendFileSync(process.env.PRAXIS_HOOK_MARKER, input.hook_event_name + ':' + (input.trigger || input.source || '') + '\\n') })",
].join(';')
const hookCommand = `${process.execPath} -e ${JSON.stringify(hookCode)}`
await writeFile(
  join(configRoot, 'settings.json'),
  JSON.stringify({
    hooks: {
      Setup: [
        { matcher: 'init', hooks: [{ type: 'command', command: hookCommand }] },
        {
          matcher: 'maintenance',
          hooks: [{ type: 'command', command: hookCommand }],
        },
      ],
      SessionStart: [
        {
          matcher: 'startup',
          hooks: [{ type: 'command', command: hookCommand }],
        },
      ],
    },
  }),
)

const baseEnv = {
  ...process.env,
  CLAUDE_CONFIG_DIR: configRoot,
  PRAXIS_HOOK_MARKER: marker,
}

async function run(command, args, env = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      env: { ...baseEnv, ...env },
      timeout: 120_000,
    })
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    }
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function markerText() {
  try {
    return await readFile(marker, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw error
  }
}

async function jsonlFiles(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await jsonlFiles(path)))
    else if (entry.name.endsWith('.jsonl')) files.push(path)
  }
  return files
}

const claude = await run('claude', ['--init-only'])
assert(claude.code === 0, `Claude --init-only failed: ${claude.stderr}`)
const claudeMarker = await markerText()
assert(
  claudeMarker === 'Setup:init\nSessionStart:startup\n',
  `Claude lifecycle order mismatch: ${JSON.stringify(claudeMarker)}`,
)
await rm(marker, { force: true })

const praxis = await run(process.execPath, [
  join(process.cwd(), 'dist', 'cli.js'),
  '--init-only',
])
assert(praxis.code === 0, `Praxis --init-only failed: ${praxis.stderr}`)
const praxisMarker = await markerText()
assert(
  praxisMarker === 'Setup:init\nSessionStart:startup\n',
  `Praxis lifecycle order mismatch: ${JSON.stringify(praxisMarker)}`,
)
assert(
  (await jsonlFiles(configRoot)).length === 0,
  'init-only unexpectedly wrote a transcript',
)

await rm(marker, { force: true })
const claudeBare = await run('claude', ['--bare', '--init-only'])
assert(
  claudeBare.code === 0,
  `Claude bare init-only failed: ${claudeBare.stderr}`,
)
assert((await markerText()) === '', 'Claude bare mode executed lifecycle hooks')
const praxisBare = await run(process.execPath, [
  join(process.cwd(), 'dist', 'cli.js'),
  '--bare',
  '--init-only',
])
assert(
  praxisBare.code === 0,
  `Praxis bare init-only failed: ${praxisBare.stderr}`,
)
assert((await markerText()) === '', 'Praxis bare mode executed lifecycle hooks')

await rm(marker, { force: true })
const maintenance = await run(
  process.execPath,
  [join(process.cwd(), 'dist', 'cli.js'), '--maintenance', '-p', 'continue'],
  {
    PRAXIS_PROVIDER: 'openai',
    PRAXIS_API_KEY: 'fixture-key',
    PRAXIS_MODEL: 'fixture-model',
    PRAXIS_BASE_URL: 'http://127.0.0.1:1/v1',
  },
)
assert(
  maintenance.code !== 0,
  'maintenance unexpectedly completed provider turn',
)
assert(
  (await markerText()) === 'Setup:maintenance\nSessionStart:startup\n',
  `Maintenance matcher mismatch: ${JSON.stringify(await markerText())}`,
)

await rm(root, { recursive: true, force: true })
console.log(
  'Claude 2.1.208/Praxis init, init-only, and maintenance lifecycle compatibility passed',
)
