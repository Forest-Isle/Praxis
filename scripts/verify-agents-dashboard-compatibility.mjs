import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { detectClaudeVersion } from './lib/claude-probe.mjs'
import { resolveClaudePaths } from '../dist/compatibility/claude/paths.js'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-agents-dashboard-compat-'))
const configRoot = join(root, 'claude-config')
const cwd = join(root, 'work')
const otherCwd = join(root, 'other-work')
const installRoot = join(root, 'install')
let praxisCli
let launchedId
let resumedId
let providerPort
let providerTurn = 0
const providerRequests = []

const provider = createServer(async (request, response) => {
  let source = ''
  request.setEncoding('utf8')
  for await (const chunk of request) source += chunk
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404).end()
    return
  }
  providerRequests.push(JSON.parse(source))
  providerTurn += 1
  const text = `AGENTS_DASHBOARD_FAKE_${providerTurn}`
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`,
  )
})

async function listenProvider() {
  await new Promise((resolveListen, reject) => {
    provider.once('error', reject)
    provider.listen(0, '127.0.0.1', resolveListen)
  })
  providerPort = provider.address().port
}

process.env.DISABLE_AUTOUPDATER = '1'

function environment() {
  return {
    ...process.env,
    CLAUDE_CONFIG_DIR: configRoot,
    DISABLE_AUTOUPDATER: '1',
    PRAXIS_PROVIDER: 'openai',
    PRAXIS_API_KEY: 'fixture-key',
    PRAXIS_MODEL: 'fixture-model',
    PRAXIS_BASE_URL: `http://127.0.0.1:${providerPort}/v1`,
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
set timeout 20
spawn env TERM=xterm-256color $env(PRAXIS_NODE) $env(PRAXIS_CLI) agents
expect {
  -re {Completed [(]1[)]} {
    send "\\033\\[B"
    set selected_pattern "Selected $env(INITIAL_ID)"
    expect {
      -re $selected_pattern {}
      timeout { puts stderr "completed agent was not selected"; exit 1 }
      eof { puts stderr "dashboard exited before completed agent selection"; exit 1 }
    }
    send "\\r"
    set review_pattern "Reviewing $env(INITIAL_ID); enter a prompt to resume"
    expect {
      -re $review_pattern {}
      timeout { puts stderr "review did not load"; exit 1 }
      eof { puts stderr "dashboard exited before review loaded"; exit 1 }
    }
    send "resume dashboard"
    expect {
      -re {› resume dashboard} {}
      timeout { puts stderr "resume prompt did not render"; exit 1 }
      eof { puts stderr "dashboard exited before resume prompt rendered"; exit 1 }
    }
    send "\\r"
    expect {
      -re {Attached to ([0-9a-f]{8})} {}
      timeout { puts stderr "resumed agent did not attach"; exit 1 }
      eof { puts stderr "dashboard exited before resumed agent attached"; exit 1 }
    }
    set resumed_id $expect_out(1,string)
    set detached_pattern "Detached from $resumed_id"
    set stopped_pattern "Stopped $resumed_id"
    expect {
      -re {AGENTS_DASHBOARD_FAKE_2} {}
      timeout { puts stderr "resumed output did not render"; exit 1 }
      eof { puts stderr "dashboard exited before resumed output rendered"; exit 1 }
    }
    send "continuation"
    expect {
      -re {› continuation} {}
      timeout { puts stderr "continuation prompt did not render"; exit 1 }
      eof { puts stderr "dashboard exited before continuation prompt rendered"; exit 1 }
    }
    send "\\r"
    expect {
      -re {AGENTS_DASHBOARD_FAKE_3} {}
      timeout { puts stderr "continuation output did not render"; exit 1 }
      eof { puts stderr "dashboard exited before continuation output rendered"; exit 1 }
    }
    send "\\033"
    expect {
      -re $detached_pattern {}
      timeout { puts stderr "resumed agent did not detach"; exit 1 }
      eof { puts stderr "dashboard exited before detach"; exit 1 }
    }
    send "\\030"
    expect {
      -re $stopped_pattern {}
      timeout { puts stderr "resumed agent did not stop"; exit 1 }
      eof { puts stderr "dashboard exited before stop"; exit 1 }
    }
    send "\\003"
    expect {
      eof {}
      timeout { puts stderr "dashboard did not exit"; exit 1 }
    }
    exit 0
  }
  timeout { puts stderr "Praxis agents PTY did not render"; exit 1 }
  eof { puts stderr "Praxis agents PTY exited before rendering"; exit 1 }
}
`,
    ],
    {
      cwd,
      env: {
        ...environment(),
        PRAXIS_NODE: process.execPath,
        PRAXIS_CLI: praxisCli,
        INITIAL_ID: launchedId,
      },
      timeout: 30_000,
    },
  )
  return stdout
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
  await writeFile(
    join(configRoot, 'settings.json'),
    `${JSON.stringify({ theme: 'light-ansi' })}\n`,
  )
  await listenProvider()
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
  let becameIdle = false
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = (await jsonAgents()).find(
      (agent) => agent.id === launchedId,
    )
    if (current?.status === 'idle') {
      becameIdle = true
      break
    }
    await new Promise((resolveWait) => globalThis.setTimeout(resolveWait, 50))
  }
  assert.equal(
    becameIdle,
    true,
    'Initial background worker did not become idle',
  )
  await execFileAsync(process.execPath, [praxisCli, 'stop', launchedId], {
    cwd,
    env: environment(),
    timeout: 30_000,
  })
  const completed = (await jsonAgents(true)).find(
    (agent) => agent.id === launchedId,
  )
  assert.equal(completed?.state, 'stopped')
  assert.equal(
    (await jsonAgents()).some((agent) => agent.id === launchedId),
    false,
  )
  assert.equal(
    (await jsonAgents(true)).some((agent) => agent.id === launchedId),
    true,
  )

  const dashboardOutput = await runPraxisPty()
  assert.match(
    dashboardOutput,
    new RegExp(String.raw`\u001B\[95m(?:\u001B\[[0-9;]*m)*Praxis agents`, 'u'),
    'installed agents dashboard did not apply its persisted accent theme',
  )
  assert.match(
    dashboardOutput,
    new RegExp(String.raw`\u001B\[93m(?:\u001B\[[0-9;]*m)*Loading agents`, 'u'),
    'installed agents dashboard did not apply its persisted warning theme',
  )
  const resumed = (await jsonAgents(true)).find(
    (agent) =>
      agent.id !== launchedId && agent.sessionId === completed.sessionId,
  )
  assert(resumed?.id, 'PTY resume did not create a new background worker')
  resumedId = resumed.id
  assert.equal((await waitForCompletedAgent(resumedId)).state, 'stopped')
  const logs = await execFileAsync(
    process.execPath,
    [praxisCli, 'logs', resumedId],
    { cwd, env: environment(), timeout: 30_000 },
  )
  assert.equal(
    [...logs.stdout.matchAll(/AGENTS_DASHBOARD_FAKE_/gu)].length >= 2,
    true,
    'Resumed worker log omitted resume or continuation output',
  )
  const transcript = await readFile(
    resolveClaudePaths({
      configDir: configRoot,
      cwd: completed.cwd,
      sessionId: completed.sessionId,
    }).sessionFile,
    'utf8',
  )
  assert.match(transcript, /resume dashboard/u)
  assert.match(transcript, /continuation/u)
  assert.equal(
    [...transcript.matchAll(/AGENTS_DASHBOARD_FAKE_/gu)].length >= 3,
    true,
    'Shared transcript omitted a lifecycle provider response',
  )
  assert.equal(providerTurn >= 3, true, 'Provider did not receive all turns')
  const providerPayloads = JSON.stringify(providerRequests)
  assert.match(providerPayloads, /AGENTS_DASHBOARD_JSON_GATE/u)
  assert.match(providerPayloads, /resume dashboard/u)
  assert.match(providerPayloads, /continuation/u)
  const persistedState = JSON.parse(
    await readFile(join(configRoot, 'jobs', resumedId, 'state.json'), 'utf8'),
  )
  assert.equal(persistedState.state, 'stopped')
  assert.equal(persistedState.tempo, 'idle')
  assert.equal(persistedState.sessionId, completed.sessionId)
  assert.equal(persistedState.resumeSessionId, completed.sessionId)

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
  if (resumedId)
    await execFileAsync(process.execPath, [praxisCli, 'stop', resumedId], {
      cwd,
      env: environment(),
      timeout: 30_000,
    }).catch(() => undefined)
  await new Promise((resolveClose) => provider.close(resolveClose))
  await rm(root, { recursive: true, force: true })
}
