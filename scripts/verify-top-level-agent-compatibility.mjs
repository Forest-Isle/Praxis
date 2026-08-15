import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { detectClaudeVersion } from './lib/claude-probe.mjs'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-top-agent-compat-'))
const configRoot = join(root, 'claude-config')
const cwd = join(root, 'work')
const praxisCli = join(process.cwd(), 'dist', 'cli.js')
const ignoredSessionId = '21212121-2121-4121-8121-212121212121'
let messageNumber = 0
let claudeId
let praxisId
let providerPort
const providerRequests = []

function responseText(body) {
  if (body.includes('CLAUDE_RESUMES_PRAXIS')) return 'CLAUDE_RESUME_DONE'
  if (body.includes('PRAXIS_RESUMES_CLAUDE')) return 'PRAXIS_RESUME_DONE'
  if (body.includes('PRAXIS_ATTACHED_PROMPT')) return 'PRAXIS_ATTACHED_DONE'
  if (body.includes('PRAXIS_INITIAL_PROMPT')) return 'PRAXIS_BACKGROUND_DONE'
  return 'CLAUDE_BACKGROUND_DONE'
}

function textEvents(text) {
  return [
    {
      type: 'message_start',
      message: {
        id: `msg_top_level_${++messageNumber}`,
        type: 'message',
        role: 'assistant',
        model: 'fixture-model',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 2, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ]
}

const provider = createServer(async (request, response) => {
  if (request.method === 'HEAD') {
    response.writeHead(200).end()
    return
  }
  let body = ''
  for await (const chunk of request) body += chunk
  providerRequests.push(JSON.parse(body))
  await new Promise((resolveWait) => globalThis.setTimeout(resolveWait, 300))
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    textEvents(responseText(body))
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(''),
  )
})

function listen() {
  return new Promise((resolveListen, reject) => {
    provider.once('error', reject)
    provider.listen(0, '127.0.0.1', resolveListen)
  })
}

function closeProvider() {
  return new Promise((resolveClose, reject) => {
    provider.close((error) => (error ? reject(error) : resolveClose()))
  })
}

function claudeEnvironment(port) {
  const environment = {
    ...process.env,
    CLAUDE_CONFIG_DIR: configRoot,
    ANTHROPIC_API_KEY: 'fixture-key',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
  for (const name of [
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'CLAUDE_CODE_EFFORT_LEVEL',
    'CLAUDE_CODE_SUBAGENT_MODEL',
  ]) {
    delete environment[name]
  }
  return environment
}

function praxisEnvironment(port) {
  return {
    ...process.env,
    CLAUDE_CONFIG_DIR: configRoot,
    PRAXIS_PROVIDER: 'anthropic',
    PRAXIS_API_KEY: 'fixture-key',
    PRAXIS_MODEL: 'fixture-model',
    PRAXIS_BASE_URL: `http://127.0.0.1:${port}`,
  }
}

async function claudeAgents(port, all = false) {
  const result = await execFileAsync(
    'claude',
    ['agents', '--json', '--cwd', cwd, ...(all ? ['--all'] : [])],
    { cwd, env: claudeEnvironment(port), timeout: 30_000 },
  )
  return JSON.parse(result.stdout)
}

async function praxisAgents(port, all = false) {
  const result = await execFileAsync(
    process.execPath,
    [praxisCli, 'agents', '--json', '--cwd', cwd, ...(all ? ['--all'] : [])],
    { cwd, env: praxisEnvironment(port), timeout: 30_000 },
  )
  return JSON.parse(result.stdout)
}

async function waitForAgent(load, predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const agents = await load()
    const match = agents.find(predicate)
    if (match) return match
    await new Promise((resolveWait) => globalThis.setTimeout(resolveWait, 25))
  }
  throw new Error('background agent state timed out')
}

function spawnWithInput(file, args, options, input) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(file, args, {
      ...options,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
    const timer = globalThis.setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`command timed out: ${file} ${args.join(' ')}`))
    }, 30_000)
    child.once('error', (error) => {
      globalThis.clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      globalThis.clearTimeout(timer)
      if (code === 0) resolveRun({ stdout, stderr })
      else reject(new Error(`${file} exited ${code}: ${stderr || stdout}`))
    })
    child.stdin.end(input)
  })
}

async function findTranscript(sessionId) {
  const projects = join(configRoot, 'projects')
  for (const project of await readdir(projects)) {
    const path = join(projects, project, `${sessionId}.jsonl`)
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  throw new Error(`transcript missing: ${sessionId}`)
}

try {
  const version = await detectClaudeVersion('Top-level agent compatibility')
  await Promise.all([
    mkdir(configRoot, { recursive: true }),
    mkdir(cwd, { recursive: true }),
    listen(),
  ])
  await mkdir(join(configRoot, 'agents'), { recursive: true })
  await writeFile(
    join(configRoot, 'agents', 'runtime-probe.md'),
    [
      '---',
      'name: runtime-probe',
      'description: Verify top-level agent controls.',
      'model: claude-opus-4-1-20250805',
      'effort: low',
      'tools: [Read]',
      'initialPrompt: AGENT_INITIAL_MARKER',
      '---',
      'AGENT_SYSTEM_MARKER',
      '',
    ].join('\n'),
  )
  const address = provider.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  providerPort = address.port

  await assert.rejects(
    execFileAsync('claude', ['--bg', '--print', 'conflict'], {
      cwd,
      env: claudeEnvironment(providerPort),
      timeout: 30_000,
    }),
    (error) =>
      error.stderr.includes('--bg and --print conflict') &&
      error.stderr.includes("claude --bg '<task>'"),
  )

  const claudeLaunch = await execFileAsync(
    'claude',
    [
      '--background',
      '--bare',
      '--session-id',
      ignoredSessionId,
      '--model',
      'claude-sonnet-4-5-20250929',
      'CLAUDE_INITIAL_PROMPT',
    ],
    { cwd, env: claudeEnvironment(providerPort), timeout: 30_000 },
  )
  assert.match(claudeLaunch.stderr, /ignoring --session-id/u)
  claudeId = /backgrounded · ([0-9a-f]{8})/u.exec(claudeLaunch.stdout)?.[1]
  assert.ok(claudeId)
  const claudeIdle = await waitForAgent(
    () => claudeAgents(providerPort, true),
    (agent) => agent.id === claudeId && agent.status === 'idle',
  )
  assert.equal(claudeIdle.sessionId.slice(0, 8), claudeId)
  await execFileAsync('claude', ['stop', claudeId], {
    cwd,
    env: claudeEnvironment(providerPort),
    timeout: 30_000,
  })
  claudeId = undefined

  const praxisLaunch = await execFileAsync(
    process.execPath,
    [
      praxisCli,
      '--background',
      '--bare',
      '--session-id',
      ignoredSessionId,
      'PRAXIS_INITIAL_PROMPT',
    ],
    { cwd, env: praxisEnvironment(providerPort), timeout: 30_000 },
  )
  assert.match(praxisLaunch.stderr, /ignoring --session-id/u)
  praxisId = /backgrounded · ([0-9a-f]{8})/u.exec(praxisLaunch.stdout)?.[1]
  assert.ok(praxisId)
  const praxisIdle = await waitForAgent(
    () => praxisAgents(providerPort, true),
    (agent) => agent.id === praxisId && agent.status === 'idle',
  )
  assert.equal(praxisIdle.sessionId.slice(0, 8), praxisId)
  const state = JSON.parse(
    await readFile(join(configRoot, 'jobs', praxisId, 'state.json'), 'utf8'),
  )
  assert.equal(state.backend, 'daemon')
  assert.equal(state.praxisOwner, 1)
  assert.equal(state.template, 'bg')
  assert.equal(state.tempo, 'idle')

  const logs = await execFileAsync(
    process.execPath,
    [praxisCli, 'logs', praxisId],
    { cwd, env: praxisEnvironment(providerPort), timeout: 30_000 },
  )
  assert.match(logs.stdout, /PRAXIS_BACKGROUND_DONE/u)
  const attached = await spawnWithInput(
    process.execPath,
    [praxisCli, 'attach', praxisId],
    { cwd, env: praxisEnvironment(providerPort) },
    'PRAXIS_ATTACHED_PROMPT\n',
  )
  assert.match(attached.stdout, /PRAXIS_BACKGROUND_DONE/u)
  assert.match(attached.stdout, /PRAXIS_ATTACHED_DONE/u)

  await execFileAsync(process.execPath, [praxisCli, 'stop', praxisId], {
    cwd,
    env: praxisEnvironment(providerPort),
    timeout: 30_000,
  })
  const stopped = await waitForAgent(
    () => praxisAgents(providerPort, true),
    (agent) => agent.id === praxisId && agent.state === 'stopped',
  )
  assert.equal(stopped.status, undefined)
  const stoppedState = JSON.parse(
    await readFile(join(configRoot, 'jobs', praxisId, 'state.json'), 'utf8'),
  )
  assert.equal(stoppedState.state, 'stopped')
  assert.equal('pid' in stoppedState, false)
  assert.equal('socketPath' in stoppedState, false)
  assert.equal('controlToken' in stoppedState, false)
  await assert.rejects(
    readFile(join(configRoot, 'sessions', `${praxisIdle.pid}.json`), 'utf8'),
    (error) => error.code === 'ENOENT',
  )
  const praxisSessionId = praxisIdle.sessionId
  praxisId = undefined

  const praxisTranscript = await findTranscript(praxisSessionId)
  const praxisMessages = praxisTranscript
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === 'user' || entry.type === 'assistant')
  assert.ok(praxisMessages.length >= 4)
  assert.ok(praxisMessages.every((entry) => entry.sessionKind === 'bg'))
  assert.ok(praxisMessages.every((entry) => entry.entrypoint === 'cli'))

  const praxisResume = await execFileAsync(
    process.execPath,
    [
      praxisCli,
      '--print',
      '--bare',
      '--resume',
      claudeIdle.sessionId,
      'PRAXIS_RESUMES_CLAUDE',
    ],
    { cwd, env: praxisEnvironment(providerPort), timeout: 30_000 },
  )
  assert.match(praxisResume.stdout, /PRAXIS_RESUME_DONE/u)

  const claudeResume = await execFileAsync(
    'claude',
    [
      '--print',
      '--bare',
      '--resume',
      praxisSessionId,
      '--model',
      'claude-sonnet-4-5-20250929',
      'CLAUDE_RESUMES_PRAXIS',
    ],
    { cwd, env: claudeEnvironment(providerPort), timeout: 30_000 },
  )
  assert.match(claudeResume.stdout, /CLAUDE_RESUME_DONE/u)

  providerRequests.length = 0
  const claudeAgentSessionId = '31313131-3131-4131-8131-313131313131'
  await execFileAsync(
    'claude',
    [
      '--print',
      '--agent',
      'runtime-probe',
      '--session-id',
      claudeAgentSessionId,
      'CLAUDE_AGENT_USER_MARKER',
    ],
    { cwd, env: claudeEnvironment(providerPort), timeout: 30_000 },
  )
  const claudeAgentRequest = providerRequests.shift()
  assert.ok(claudeAgentRequest)
  assert.match(
    JSON.stringify(claudeAgentRequest.system),
    /AGENT_SYSTEM_MARKER/u,
  )
  assert.match(
    JSON.stringify(claudeAgentRequest.messages),
    /AGENT_INITIAL_MARKER\\n\\nCLAUDE_AGENT_USER_MARKER/u,
  )
  assert.deepEqual(
    claudeAgentRequest.tools.map((tool) => tool.name),
    ['Read'],
  )
  assert.match(claudeAgentRequest.model, /opus/u)
  await execFileAsync(
    'claude',
    ['--print', '--resume', claudeAgentSessionId, 'CLAUDE_AGENT_RESUME_MARKER'],
    { cwd, env: claudeEnvironment(providerPort), timeout: 30_000 },
  )
  const claudeAgentResumeRequest = providerRequests.shift()
  assert.ok(claudeAgentResumeRequest)
  assert.equal(
    (
      JSON.stringify(claudeAgentResumeRequest.messages).match(
        /AGENT_INITIAL_MARKER/gu,
      ) ?? []
    ).length,
    1,
  )

  const praxisAgentSessionId = '41414141-4141-4141-8141-414141414141'
  await execFileAsync(
    process.execPath,
    [
      praxisCli,
      '--print',
      '--agent',
      'runtime-probe',
      '--session-id',
      praxisAgentSessionId,
      'PRAXIS_AGENT_USER_MARKER',
    ],
    { cwd, env: praxisEnvironment(providerPort), timeout: 30_000 },
  )
  const praxisAgentRequest = providerRequests.shift()
  assert.ok(praxisAgentRequest)
  assert.match(
    JSON.stringify(praxisAgentRequest.system),
    /AGENT_SYSTEM_MARKER/u,
  )
  assert.match(
    JSON.stringify(praxisAgentRequest.messages),
    /AGENT_INITIAL_MARKER\\n\\nPRAXIS_AGENT_USER_MARKER/u,
  )
  assert.deepEqual(
    praxisAgentRequest.tools.map((tool) => tool.name),
    ['Read'],
  )
  assert.equal(praxisAgentRequest.model, 'claude-opus-4-1-20250805')
  await execFileAsync(
    process.execPath,
    [
      praxisCli,
      '--print',
      '--resume',
      praxisAgentSessionId,
      'PRAXIS_AGENT_RESUME_MARKER',
    ],
    { cwd, env: praxisEnvironment(providerPort), timeout: 30_000 },
  )
  const praxisAgentResumeRequest = providerRequests.shift()
  assert.ok(praxisAgentResumeRequest)
  assert.equal(
    (
      JSON.stringify(praxisAgentResumeRequest.messages).match(
        /AGENT_INITIAL_MARKER/gu,
      ) ?? []
    ).length,
    1,
  )

  for (const [executable, environment, userMarker] of [
    ['claude', claudeEnvironment(providerPort), 'CLAUDE_EXPLICIT_USER'],
    [process.execPath, praxisEnvironment(providerPort), 'PRAXIS_EXPLICIT_USER'],
  ]) {
    const args = [
      ...(executable === process.execPath ? [praxisCli] : []),
      '--print',
      '--agent',
      'runtime-probe',
      '--model',
      'claude-sonnet-4-5-20250929',
      '--system-prompt',
      'EXPLICIT_SYSTEM_MARKER',
      userMarker,
    ]
    await execFileAsync(executable, args, {
      cwd,
      env: environment,
      timeout: 30_000,
    })
    const explicitRequest = providerRequests.shift()
    assert.ok(explicitRequest)
    assert.equal(explicitRequest.model, 'claude-sonnet-4-5-20250929')
    assert.match(
      JSON.stringify(explicitRequest.system),
      /EXPLICIT_SYSTEM_MARKER/u,
    )
    assert.doesNotMatch(
      JSON.stringify(explicitRequest.system),
      /AGENT_SYSTEM_MARKER/u,
    )
    assert.match(
      JSON.stringify(explicitRequest.messages),
      /AGENT_INITIAL_MARKER/u,
    )
  }

  await writeFile(
    join(configRoot, 'settings.json'),
    JSON.stringify({ agent: 'runtime-probe' }),
  )
  const settingsSessions = [
    {
      executable: 'claude',
      environment: claudeEnvironment(providerPort),
      sessionId: '51515151-5151-4151-8151-515151515151',
      marker: 'CLAUDE_SETTINGS_AGENT',
    },
    {
      executable: process.execPath,
      environment: praxisEnvironment(providerPort),
      sessionId: '61616161-6161-4161-8161-616161616161',
      marker: 'PRAXIS_SETTINGS_AGENT',
    },
  ]
  for (const entry of settingsSessions) {
    await execFileAsync(
      entry.executable,
      [
        ...(entry.executable === process.execPath ? [praxisCli] : []),
        '--print',
        '--session-id',
        entry.sessionId,
        '--model',
        'claude-sonnet-4-5-20250929',
        entry.marker,
      ],
      { cwd, env: entry.environment, timeout: 30_000 },
    )
    const settingsRequest = providerRequests.shift()
    assert.ok(settingsRequest)
    assert.match(JSON.stringify(settingsRequest.system), /AGENT_SYSTEM_MARKER/u)
    assert.match(
      await findTranscript(entry.sessionId),
      /"agentSetting":"runtime-probe"/u,
    )
  }
  await rm(join(configRoot, 'settings.json'), { force: true })

  for (const sessionId of [claudeAgentSessionId, praxisAgentSessionId]) {
    assert.match(await findTranscript(sessionId), /"type":"agent-setting"/u)
  }

  console.log(
    JSON.stringify({
      version,
      claude: {
        conflict: true,
        background: true,
        idle: true,
        stopped: true,
      },
      praxis: {
        background: true,
        idle: true,
        attach: true,
        logs: true,
        stopped: true,
        nativeJobLayout: true,
        backgroundTranscriptMetadata: true,
      },
      crossResume: { claudeToPraxis: true, praxisToClaude: true },
      mainThreadAgent: {
        systemPrompt: true,
        initialPrompt: true,
        resume: true,
        modelPrecedence: true,
        toolControls: true,
        agentSetting: true,
        sharedSetting: true,
      },
    }),
  )
} finally {
  if (claudeId && providerPort) {
    await execFileAsync('claude', ['stop', claudeId], {
      cwd,
      env: claudeEnvironment(providerPort),
      timeout: 30_000,
    }).catch(() => undefined)
  }
  if (praxisId && providerPort) {
    await execFileAsync(process.execPath, [praxisCli, 'stop', praxisId], {
      cwd,
      env: praxisEnvironment(providerPort),
      timeout: 30_000,
    }).catch(() => undefined)
  }
  await closeProvider().catch(() => undefined)
  await rm(root, { recursive: true, force: true })
}
