import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearTimeout, setTimeout } from 'node:timers'
import { promisify } from 'node:util'

import { detectClaudeVersion, runClaudeJson } from './lib/claude-probe.mjs'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-background-command-compat-'))
let cwd = join(root, 'work')
const configRoot = join(root, 'claude-config')
const praxisCli = join(process.cwd(), 'dist', 'cli.js')
const requests = []
let claudeJobId
let praxisJobId
let providerPort

function textEvents(text) {
  return [
    {
      type: 'message_start',
      message: {
        id: `msg_background_${requests.length}`,
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
  let source = ''
  for await (const chunk of request) source += chunk
  const body = JSON.parse(source)
  requests.push(body)
  const messages = JSON.stringify(body.messages ?? [])
  const text = messages.includes('BACKGROUND_CONTEXT_CHECK')
    ? messages.includes('BACKGROUND_CONTEXT_SEED')
      ? 'BACKGROUND_CONTEXT_PRESERVED'
      : 'BACKGROUND_CONTEXT_MISSING'
    : 'BACKGROUND_CONTEXT_READY'
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    textEvents(text)
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(''),
  )
})

function environment() {
  return {
    ...process.env,
    CLAUDE_CONFIG_DIR: configRoot,
    ANTHROPIC_AUTH_TOKEN: 'fixture-key',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${providerPort}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    PRAXIS_PROVIDER: 'anthropic',
    PRAXIS_API_KEY: 'fixture-key',
    PRAXIS_MODEL: 'fixture-model',
    PRAXIS_BASE_URL: `http://127.0.0.1:${providerPort}`,
  }
}

function assertBackgrounding(output) {
  const escape = String.fromCharCode(27)
  assert.match(
    output,
    new RegExp(`Backgroundi(?:ng|(?:${escape}\\[[0-9;?]*[ -/]*[@-~])*g)…`, 'u'),
  )
}

function waitForExit(child, label, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`${label} timed out: ${output.slice(-4000)}`))
    }, timeoutMs)
    const capture = (chunk) => (output += chunk.toString('utf8'))
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      if (code === 0) resolve(output)
      else
        reject(
          new Error(
            `${label} failed${signal ? ` with ${signal}` : ` with exit ${code}`}: ${output.slice(-4000)}`,
          ),
        )
    })
  })
}

async function runTty(command, args, interactions, label) {
  const driver = `
import json, os, select, subprocess, sys, time
actions = json.loads(sys.argv[1])
master, slave = os.openpty()
process = subprocess.Popen(sys.argv[2:], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
output = b''
action_index = 0
while process.poll() is None:
    ready, _, _ = select.select([master], [], [], 0.1)
    if not ready:
        continue
    try:
        chunk = os.read(master, 65536)
    except OSError:
        break
    if not chunk:
        break
    output += chunk
    sys.stdout.buffer.write(chunk)
    sys.stdout.buffer.flush()
    if action_index < len(actions) and actions[action_index]['waitFor'].encode() in output:
        value = actions[action_index]['input'].encode()
        action_index += 1
        time.sleep(0.05)
        if value == b'__TERMINATE__':
            process.terminate()
            process.wait()
            sys.exit(0)
        elif value.endswith(b'\\r'):
            os.write(master, value[:-1])
            time.sleep(0.05)
            os.write(master, b'\\r')
        else:
            os.write(master, value)
sys.exit(process.wait())
`
  const child = spawn(
    'python3',
    ['-c', driver, JSON.stringify(interactions), command, ...args],
    { cwd, env: environment(), stdio: ['pipe', 'pipe', 'pipe'] },
  )
  return waitForExit(child, label)
}

function spawnWithInput(file, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      env: environment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`command timed out: ${file} ${args.join(' ')}`))
    }, 30_000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timeout)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${file} exited ${code}: ${stderr || stdout}`))
    })
    child.stdin.end(input)
  })
}

async function transcript(sessionId, required = true) {
  const projectsRoot = join(configRoot, 'projects')
  for (const project of await readdir(projectsRoot)) {
    try {
      return await readFile(
        join(projectsRoot, project, `${sessionId}.jsonl`),
        'utf8',
      )
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  if (required) throw new Error(`Transcript not found: ${sessionId}`)
  return null
}

async function transcriptContaining(marker) {
  const projectsRoot = join(configRoot, 'projects')
  for (const project of await readdir(projectsRoot)) {
    const directory = join(projectsRoot, project)
    for (const file of await readdir(directory)) {
      if (!file.endsWith('.jsonl')) continue
      const path = join(directory, file)
      const source = await readFile(path, 'utf8')
      if (source.includes(marker)) return { path, source }
    }
  }
  throw new Error(`Transcript marker not found: ${marker}`)
}

async function waitForJobState(id) {
  const path = join(configRoot, 'jobs', id, 'state.json')
  let lastState
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const state = JSON.parse(await readFile(path, 'utf8'))
      lastState = state
      if (state.tempo === 'idle' || state.tempo === 'blocked') return state
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(
    `Claude background job did not settle: ${id} ${JSON.stringify(lastState)}`,
  )
}

async function removeProbeRoot() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true })
      return
    } catch (error) {
      if (error.code !== 'ENOTEMPTY' || attempt === 4) throw error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}

try {
  const version = await detectClaudeVersion('/background compatibility')
  await mkdir(cwd, { recursive: true })
  cwd = await realpath(cwd)
  await mkdir(configRoot, { recursive: true })
  await writeFile(
    join(configRoot, '.claude.json'),
    JSON.stringify({
      theme: 'dark',
      hasCompletedOnboarding: true,
      lastOnboardingVersion: version,
      projects: { [cwd]: { hasTrustDialogAccepted: true } },
    }),
  )
  await new Promise((resolve, reject) => {
    provider.once('error', reject)
    provider.listen(0, '127.0.0.1', resolve)
  })
  const address = provider.address()
  assert.ok(address && typeof address !== 'string')
  providerPort = address.port

  const output = await runTty(
    'claude',
    ['--model', 'fixture-model', 'BACKGROUND_CONTEXT_SEED'],
    [{ waitFor: 'CONTEXT_READY', input: '/background\r' }],
    'Claude /background',
  )
  assertBackgrounding(output)
  claudeJobId = /backgrounded · ([0-9a-f]{8})/u.exec(output)?.[1]
  assert.ok(claudeJobId, output.slice(-4000))

  const state = await waitForJobState(claudeJobId)
  assert.equal(state.sessionId.slice(0, 8), claudeJobId)
  assert.equal(state.tempo, 'blocked')
  assert.equal(state.needs, 'send a prompt to start')
  const claudeSource = await transcriptContaining('BACKGROUND_CONTEXT_SEED')
  assert.doesNotMatch(claudeSource.source, /<command-name>\/background/u)
  const beforeAttach = await transcript(state.sessionId, false)
  if (beforeAttach)
    assert.doesNotMatch(beforeAttach, /BACKGROUND_CONTEXT_SEED/u)

  const attached = await runTty(
    'claude',
    ['attach', claudeJobId],
    [
      { waitFor: 'CONTEXT_READY', input: 'BACKGROUND_CONTEXT_CHECK\r' },
      { waitFor: 'CONTEXT_PRESERVED', input: '__TERMINATE__' },
    ],
    'Claude attach',
  )
  assert.match(attached, /BACKGROUND_CONTEXT_PRESERVED/u)
  const attachRequest = requests.find((request) =>
    JSON.stringify(request.messages).includes('BACKGROUND_CONTEXT_CHECK'),
  )
  assert.ok(attachRequest)
  assert.match(
    JSON.stringify(attachRequest.messages),
    /BACKGROUND_CONTEXT_SEED/u,
  )
  const afterAttach = await transcript(state.sessionId)
  assert.equal(await readFile(claudeSource.path, 'utf8'), claudeSource.source)

  await execFileAsync('claude', ['stop', claudeJobId], {
    cwd,
    env: environment(),
    timeout: 30_000,
  })
  claudeJobId = undefined

  const praxisOutput = await runTty(
    process.execPath,
    [praxisCli, '--model', 'fixture-model', 'PRAXIS_BACKGROUND_CONTEXT_SEED'],
    [{ waitFor: 'CONTEXT_READY', input: '/background\r' }],
    'Praxis /background',
  )
  assertBackgrounding(praxisOutput)
  praxisJobId = /backgrounded · ([0-9a-f]{8})/u.exec(praxisOutput)?.[1]
  assert.ok(praxisJobId, praxisOutput.slice(-4000))
  const praxisState = await waitForJobState(praxisJobId)
  assert.equal(praxisState.sessionId.slice(0, 8), praxisJobId)
  assert.equal(praxisState.tempo, 'blocked')
  assert.equal(praxisState.needs, 'send a prompt to start')
  const praxisSource = await transcriptContaining(
    'PRAXIS_BACKGROUND_CONTEXT_SEED',
  )
  assert.doesNotMatch(praxisSource.source, /<command-name>\/background/u)
  const praxisBeforeAttach = await transcript(praxisState.sessionId, false)
  if (praxisBeforeAttach) {
    assert.doesNotMatch(praxisBeforeAttach, /PRAXIS_BACKGROUND_CONTEXT_SEED/u)
  }

  const praxisAttached = await spawnWithInput(
    process.execPath,
    [praxisCli, 'attach', praxisJobId],
    'PRAXIS_BACKGROUND_CONTEXT_CHECK\n',
  )
  assert.match(praxisAttached.stdout, /BACKGROUND_CONTEXT_PRESERVED/u)
  const praxisAttachRequest = requests.find((request) =>
    JSON.stringify(request.messages).includes(
      'PRAXIS_BACKGROUND_CONTEXT_CHECK',
    ),
  )
  assert.ok(praxisAttachRequest)
  assert.match(
    JSON.stringify(praxisAttachRequest.messages),
    /PRAXIS_BACKGROUND_CONTEXT_SEED/u,
  )
  const praxisAfterAttach = await transcript(praxisState.sessionId)
  assert.match(praxisAfterAttach, /PRAXIS_BACKGROUND_CONTEXT_SEED/u)
  assert.equal(await readFile(praxisSource.path, 'utf8'), praxisSource.source)

  await execFileAsync(process.execPath, [praxisCli, 'stop', praxisJobId], {
    cwd,
    env: environment(),
    timeout: 30_000,
  })
  praxisJobId = undefined

  const requestCountBeforeClaudeResume = requests.length
  const claudeResume = await runClaudeJson(
    [
      '--model',
      'fixture-model',
      '-p',
      '--output-format=json',
      '--resume',
      praxisState.sessionId,
      'BACKGROUND_CONTEXT_CHECK',
    ],
    cwd,
    configRoot,
    environment(),
  )
  assert.match(claudeResume.result, /BACKGROUND_CONTEXT_PRESERVED/u)
  const claudeResumeRequest = requests
    .slice(requestCountBeforeClaudeResume)
    .find((request) =>
      JSON.stringify(request.messages).includes('BACKGROUND_CONTEXT_CHECK'),
    )
  assert.ok(claudeResumeRequest)
  assert.match(
    JSON.stringify(claudeResumeRequest.messages),
    /PRAXIS_BACKGROUND_CONTEXT_SEED/u,
  )

  console.log(
    JSON.stringify({
      version,
      claude: {
        jobSessionIsNew: true,
        blockedUntilPrompt: true,
        transcriptInitiallyMetadataOnly: true,
        attachContextPreserved: true,
        sourceTranscriptUnchanged: true,
        attachTranscriptContainsSourceContext: afterAttach.includes(
          'BACKGROUND_CONTEXT_SEED',
        ),
      },
      praxis: {
        jobSessionIsNew: true,
        blockedUntilPrompt: true,
        transcriptInitiallyMetadataOnly: true,
        attachContextPreserved: true,
        sourceTranscriptUnchanged: true,
        attachTranscriptContainsSourceContext: true,
        claudeResumePreservedContext: true,
      },
    }),
  )
} finally {
  if (claudeJobId && providerPort) {
    await execFileAsync('claude', ['stop', claudeJobId], {
      cwd,
      env: environment(),
      timeout: 30_000,
    }).catch(() => undefined)
  }
  if (praxisJobId && providerPort) {
    await execFileAsync(process.execPath, [praxisCli, 'stop', praxisJobId], {
      cwd,
      env: environment(),
      timeout: 30_000,
    }).catch(() => undefined)
  }
  await new Promise((resolve) => provider.close(resolve))
  await new Promise((resolve) => setTimeout(resolve, 100))
  await removeProbeRoot()
}
