import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { detectClaudeVersion } from './lib/claude-probe.mjs'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-agents-dashboard-compat-'))
const configRoot = join(root, 'claude-config')
const cwd = join(root, 'work')
const otherCwd = join(root, 'other-work')
const installRoot = join(root, 'install')
let praxisCli
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
  await execFileAsync(
    'expect',
    [
      '-c',
      `
set timeout 15
spawn $env(PRAXIS_NODE) $env(PRAXIS_CLI) agents
expect {
  -re {Ready for review [(]} { send "?"; expect -re {Shortcuts}; send "\\022"; expect -re {Working [(]}; send "\\003"; expect eof; exit 0 }
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
}

try {
  const version = await detectClaudeVersion('Agents dashboard compatibility')
  assert.equal(version, '2.1.208')
  await Promise.all([
    mkdir(configRoot, { recursive: true }),
    mkdir(cwd),
    mkdir(otherCwd),
    mkdir(installRoot),
  ])
  const { stdout: packed } = await execFileAsync(
    'npm',
    ['pack', '--pack-destination', root],
    { cwd: process.cwd(), timeout: 60_000 },
  )
  const artifact = join(root, packed.trim().split(/\s+/u).at(-1))
  await execFileAsync(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-package-lock',
      '--prefix',
      installRoot,
      artifact,
    ],
    { timeout: 60_000 },
  )
  praxisCli = join(installRoot, 'node_modules', '.bin', 'praxis')

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
  assert(Array.isArray(JSON.parse(claudeJson.stdout)))
  assert(Array.isArray(JSON.parse(claudeAllJson.stdout)))
  await mkdir(join(configRoot, 'sessions'))
  await writeFile(
    join(configRoot, 'sessions', '424242.json'),
    `${JSON.stringify({
      pid: 424242,
      sessionId: 'native-fixture-session',
      cwd: otherCwd,
      startedAt: 1,
      kind: 'interactive',
      name: 'native fixture',
      status: 'idle',
    })}\n`,
  )
  assert.deepEqual(await jsonAgents(), [
    {
      pid: 424242,
      cwd: otherCwd,
      kind: 'interactive',
      startedAt: 1,
      sessionId: 'native-fixture-session',
      name: 'native fixture',
      status: 'idle',
    },
  ])
  assert.deepEqual(await jsonAgents(true), await jsonAgents())
  assert.deepEqual(
    await (async () => {
      const { stdout } = await execFileAsync(
        process.execPath,
        [praxisCli, 'agents', '--json', '--cwd', cwd],
        { cwd, env: environment(), timeout: 30_000 },
      )
      return JSON.parse(stdout)
    })(),
    [],
  )
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [praxisCli, 'agents', '--thinking', 'adaptive'],
      { cwd, env: environment(), timeout: 30_000 },
    ),
    (error) => error.stderr.includes('--thinking is not valid with agents'),
  )

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
    `Claude ${version} agents dashboard compatibility passed: packed artifact, help, non-TTY guard, native/cross-CWD JSON, strict options, and interactive dashboard controls\n`,
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
