import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { detectClaudeVersion } from './lib/claude-probe.mjs'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-agents-dashboard-compat-'))
const configRoot = join(root, 'claude-config')
const cwd = join(root, 'work')
const praxisCli = join(process.cwd(), 'dist', 'cli.js')
let launchedId

process.env.DISABLE_AUTOUPDATER = '1'

function environment() {
  return {
    ...process.env,
    CLAUDE_CONFIG_DIR: configRoot,
    DISABLE_AUTOUPDATER: '1',
  }
}

function requiredOptions(output) {
  for (const option of [
    '--add-dir <directory>',
    '--agent <agent>',
    '--all',
    '--allow-dangerously-skip-permissions',
    '--cwd <path>',
    '--dangerously-skip-permissions',
    '--effort <level>',
    '--json',
    '--mcp-config <config>',
    '--model <model>',
    '--permission-mode <mode>',
    '--plugin-dir <path>',
    '--setting-sources <sources>',
    '--settings <file-or-json>',
    '--strict-mcp-config',
  ]) {
    assert(output.includes(option), `agents help omitted ${option}`)
  }
}

async function jsonAgents(all = false) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [praxisCli, 'agents', '--json', ...(all ? ['--all'] : [])],
    { cwd, env: environment(), timeout: 30_000 },
  )
  const agents = JSON.parse(stdout)
  assert(Array.isArray(agents), 'Praxis agents --json did not return an array')
  return agents
}

async function waitForCompletedAgent(id) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const agent = (await jsonAgents(true)).find((current) => current.id === id)
    if (agent && agent.state !== 'working') return agent
    await new Promise((resolveWait) => globalThis.setTimeout(resolveWait, 50))
  }
  throw new Error(`background agent ${id} did not complete`)
}

async function runPraxisPty() {
  const { stdout } = await execFileAsync(
    'expect',
    [
      '-c',
      `
set timeout 15
spawn $env(PRAXIS_NODE) $env(PRAXIS_CLI) agents
expect {
  -re {Praxis agents} { send "\\003"; expect eof; exit 0 }
  timeout { puts stderr "Praxis agents PTY did not render"; exit 1 }
}
`,
    ],
    {
      cwd,
      env: {
        ...environment(),
        PRAXIS_NODE: process.execPath,
        PRAXIS_CLI: praxisCli,
      },
      timeout: 30_000,
    },
  )
  assert.match(stdout, /Praxis agents/u)
}

try {
  const version = await detectClaudeVersion('Agents dashboard compatibility')
  assert.equal(version, '2.1.208')
  await Promise.all([mkdir(configRoot, { recursive: true }), mkdir(cwd)])

  const claudeHelp = await execFileAsync('claude', ['agents', '--help'], {
    cwd,
    env: environment(),
    timeout: 30_000,
  })
  const praxisHelp = await execFileAsync(
    process.execPath,
    [praxisCli, 'agents', '--help'],
    { cwd, env: environment(), timeout: 30_000 },
  )
  requiredOptions(claudeHelp.stdout)
  requiredOptions(praxisHelp.stdout)

  await assert.rejects(
    execFileAsync('claude', ['agents'], {
      cwd,
      env: environment(),
      timeout: 30_000,
    }),
    (error) =>
      error.stderr.includes(
        "'claude agents' requires an interactive terminal",
      ) && error.stderr.includes("'claude agents --json'"),
  )
  await assert.rejects(
    execFileAsync(process.execPath, [praxisCli, 'agents'], {
      cwd,
      env: environment(),
      timeout: 30_000,
    }),
    (error) =>
      error.stderr.includes(
        "'praxis agents' requires an interactive terminal",
      ) && error.stderr.includes("'praxis agents --json'"),
  )

  const claudeJson = await execFileAsync('claude', ['agents', '--json'], {
    cwd,
    env: environment(),
    timeout: 30_000,
  })
  const claudeAllJson = await execFileAsync(
    'claude',
    ['agents', '--json', '--all'],
    { cwd, env: environment(), timeout: 30_000 },
  )
  assert.deepEqual(JSON.parse(claudeJson.stdout), [])
  assert.deepEqual(JSON.parse(claudeAllJson.stdout), [])
  assert.deepEqual(await jsonAgents(), [])

  const launched = await execFileAsync(
    process.execPath,
    [praxisCli, '--background', '--bare', 'AGENTS_DASHBOARD_JSON_GATE'],
    { cwd, env: environment(), timeout: 30_000 },
  )
  launchedId = /backgrounded · ([0-9a-f]{8})/u.exec(launched.stdout)?.[1]
  assert.ok(launchedId, `Praxis background launch failed: ${launched.stdout}`)
  const completed = await waitForCompletedAgent(launchedId)
  assert.notEqual(completed.status, 'active')
  assert.equal(
    (await jsonAgents()).some((agent) => agent.id === launchedId),
    false,
  )
  assert.equal(
    (await jsonAgents(true)).some((agent) => agent.id === launchedId),
    true,
  )

  await runPraxisPty()

  process.stdout.write(
    `Claude ${version} agents dashboard compatibility passed: help, non-TTY guard, JSON active/all listing, and Ink PTY rendering\n`,
  )
} finally {
  if (launchedId) {
    await execFileAsync(process.execPath, [praxisCli, 'stop', launchedId], {
      cwd,
      env: environment(),
      timeout: 30_000,
    }).catch(() => undefined)
  }
  await rm(root, { recursive: true, force: true })
}
