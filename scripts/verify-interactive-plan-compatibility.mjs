import { execFile, spawn } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearTimeout, setTimeout } from 'node:timers'
import { promisify } from 'node:util'

import { detectClaudeVersion } from './lib/claude-probe.mjs'
import { resolveDataPlanePaths } from '../dist/persistence/data-plane.js'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-interactive-plan-compat-'))
let cwd = join(root, 'project')
const requests = []
const marker = 'INTERACTIVE_PLAN_SURFACE_READY'
const askMarker = 'ASK_USER_ROUND_TRIP_READY'
const planMarker = 'PLAN_MODE_ROUND_TRIP_READY'
let failure

function assert(value, message) {
  if (!value) throw new Error(message)
}

function responseEvents(model, response) {
  const block = response.tool
    ? {
        start: {
          type: 'tool_use',
          id: response.tool.id,
          name: response.tool.name,
          input: {},
        },
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(response.tool.input),
        },
      }
    : {
        start: { type: 'text', text: '' },
        delta: { type: 'text_delta', text: response.text },
      }
  return [
    {
      type: 'message_start',
      message: {
        id: `msg_interactive_${requests.length}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: block.start,
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: block.delta,
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: {
        stop_reason: response.tool ? 'tool_use' : 'end_turn',
        stop_sequence: null,
      },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ]
}

const provider = createServer(async (request, response) => {
  try {
    if (request.method === 'HEAD') {
      response.writeHead(200).end()
      return
    }
    let source = ''
    request.setEncoding('utf8')
    for await (const chunk of request) source += chunk
    if (!source) {
      response.writeHead(404).end()
      return
    }
    const body = JSON.parse(source)
    requests.push(body)
    const messages = JSON.stringify(body.messages ?? [])
    let fixtureResponse
    if (messages.includes('ASK_USER_ROUND_TRIP')) {
      fixtureResponse = messages.includes('tool_result')
        ? { text: askMarker }
        : {
            tool: {
              id: 'toolu_ask_round_trip',
              name: 'AskUserQuestion',
              input: {
                questions: [
                  {
                    question: 'Which option?',
                    header: 'Choice',
                    options: [
                      { label: 'Option A', description: 'First option' },
                      { label: 'Option B', description: 'Second option' },
                    ],
                    multiSelect: false,
                  },
                ],
              },
            },
          }
    } else if (messages.includes('PLAN_MODE_ROUND_TRIP')) {
      if (!messages.includes('Entered plan mode.')) {
        fixtureResponse = {
          tool: {
            id: 'toolu_enter_plan',
            name: 'EnterPlanMode',
            input: {},
          },
        }
      } else if (!messages.includes('Wrote ')) {
        const planPath = messages.match(
          /\/[^"\\]*\/plans\/praxis-[0-9a-f-]+\.md/u,
        )?.[0]
        if (!planPath) throw new Error('EnterPlanMode result omitted plan path')
        fixtureResponse = {
          tool: {
            id: 'toolu_write_plan',
            name: 'Write',
            input: { file_path: planPath, content: '# Plan\n\n1. Ship it.\n' },
          },
        }
      } else if (!messages.includes('Plan mode ended')) {
        fixtureResponse = {
          tool: {
            id: 'toolu_exit_plan',
            name: 'ExitPlanMode',
            input: {},
          },
        }
      } else {
        fixtureResponse = { text: planMarker }
      }
    } else {
      fixtureResponse = { text: marker }
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      responseEvents(body.model, fixtureResponse)
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(''),
    )
  } catch (error) {
    failure ??= error
    response.writeHead(500).end()
  }
})

function waitForExit(child, label, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`${label} timed out: ${output.slice(-4000)}`))
    }, timeoutMs)
    const capture = (chunk) => {
      output += chunk.toString('utf8')
    }
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

async function runTty(
  command,
  args,
  options,
  label,
  interactions = [{ waitFor: marker, input: '/exit\r' }],
) {
  const driver = `
import fcntl, json, os, select, struct, subprocess, sys, termios, time
actions = json.loads(sys.argv[1])
master, slave = os.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 60, 120, 0, 0))
process = subprocess.Popen(sys.argv[2:], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
output = b''
action_index = 0
action_start = 0
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
    while action_index < len(actions):
        needle = actions[action_index]['waitFor'].encode()
        match = output.find(needle, action_start)
        if match < 0:
            break
        value = actions[action_index]['input'].encode()
        action_index += 1
        action_start = match + len(needle)
        if actions[action_index - 1].get('terminate'):
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            sys.exit(0)
        if not value:
            continue
        time.sleep(0.05)
        if value.endswith(b'\\r'):
            os.write(master, value[:-1])
            time.sleep(0.05)
            os.write(master, b'\\r')
        else:
            os.write(master, value)
        break
sys.exit(process.wait())
`
  const child = spawn(
    'python3',
    ['-c', driver, JSON.stringify(interactions), command, ...args],
    {
      cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  return waitForExit(child, label)
}

function toolMap(request) {
  return new Map((request?.tools ?? []).map((tool) => [tool.name, tool]))
}

function requestForMarker(candidates, value) {
  return candidates
    .filter((request) => JSON.stringify(request.messages).includes(value))
    .sort(
      (left, right) => (right.tools?.length ?? 0) - (left.tools?.length ?? 0),
    )[0]
}

function normalizedSchema(value) {
  if (Array.isArray(value)) return value.map(normalizedSchema)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'description' && key !== '$schema')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, normalizedSchema(nested)]),
  )
}

async function seedClaudeConfig(configRoot) {
  await mkdir(configRoot, { recursive: true })
  await writeFile(
    join(configRoot, '.claude.json'),
    JSON.stringify({
      theme: 'dark',
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '2.1.208',
      projects: { [cwd]: { hasTrustDialogAccepted: true } },
    }),
  )
}

try {
  await detectClaudeVersion('interactive plan compatibility')
  await mkdir(cwd, { recursive: true })
  cwd = await realpath(cwd)
  await new Promise((resolve, reject) => {
    provider.once('error', reject)
    provider.listen(0, '127.0.0.1', resolve)
  })
  const address = provider.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const implementations = [
    {
      label: 'claude',
      command: 'claude',
      args: [],
      env: {
        ...process.env,
        ANTHROPIC_AUTH_TOKEN: 'fixture-key',
        ANTHROPIC_BASE_URL: baseUrl,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: '1',
        DISABLE_AUTOUPDATER: '1',
      },
    },
    {
      label: 'praxis',
      command: process.execPath,
      args: [join(process.cwd(), 'dist', 'cli.js')],
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: join(root, 'praxis-config'),
        PRAXIS_DATA_PLANE: 'native',
        PRAXIS_PROVIDER: 'anthropic',
        PRAXIS_API_KEY: 'fixture-key',
        PRAXIS_MODEL: 'fixture-model',
        PRAXIS_BASE_URL: `${baseUrl}/v1`,
      },
    },
  ]
  const observations = {}
  for (const implementation of implementations) {
    const headlessConfigRoot = join(
      root,
      `${implementation.label}-headless-config`,
    )
    const interactiveConfigRoot = join(
      root,
      `${implementation.label}-interactive-config`,
    )
    if (implementation.label === 'claude') {
      await seedClaudeConfig(headlessConfigRoot)
      await seedClaudeConfig(interactiveConfigRoot)
    }
    const headlessEnv = {
      ...implementation.env,
      CLAUDE_CONFIG_DIR: headlessConfigRoot,
      ...(implementation.label === 'praxis'
        ? { PRAXIS_HOME: headlessConfigRoot }
        : {}),
    }
    const interactiveEnv = {
      ...implementation.env,
      CLAUDE_CONFIG_DIR: interactiveConfigRoot,
      ...(implementation.label === 'praxis'
        ? { PRAXIS_HOME: interactiveConfigRoot }
        : {}),
    }
    const headlessStart = requests.length
    await execFileAsync(
      implementation.command,
      [
        ...implementation.args,
        '--print',
        '--model',
        'fixture-model',
        '--output-format',
        'json',
        'HEADLESS_INTERACTIVE_PLAN_SURFACE',
      ],
      {
        cwd,
        env: headlessEnv,
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    )
    const headless = requestForMarker(
      requests.slice(headlessStart),
      'HEADLESS_INTERACTIVE_PLAN_SURFACE',
    )
    const interactiveStart = requests.length
    await runTty(
      implementation.command,
      [
        ...implementation.args,
        '--model',
        'fixture-model',
        'INTERACTIVE_PLAN_SURFACE',
      ],
      { env: interactiveEnv },
      `${implementation.label} interactive`,
      implementation.label === 'claude'
        ? [{ waitFor: 'PLAN_SURFACE_READY', input: '', terminate: true }]
        : [{ waitFor: marker, input: '/exit\r' }],
    )
    const interactive = requestForMarker(
      requests.slice(interactiveStart),
      'INTERACTIVE_PLAN_SURFACE',
    )
    assert(headless, `${implementation.label} headless request missing`)
    assert(interactive, `${implementation.label} interactive request missing`)
    observations[implementation.label] = {
      headless: toolMap(headless),
      interactive: toolMap(interactive),
    }
  }
  if (failure) throw failure

  const names = ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']
  for (const name of names) {
    assert(
      !observations.claude.headless.has(name) &&
        !observations.praxis.headless.has(name),
      `${name} must remain interactive-only`,
    )
    const claude = observations.claude.interactive.get(name)
    const praxis = observations.praxis.interactive.get(name)
    assert(
      claude,
      `Claude interactive request omitted ${name}: ${JSON.stringify([...observations.claude.interactive.keys()])}`,
    )
    assert(
      praxis,
      `Praxis interactive request omitted ${name}: ${JSON.stringify([...observations.praxis.interactive.keys()])}`,
    )
    const claudeSchema = normalizedSchema(claude.input_schema)
    const praxisSchema = normalizedSchema(praxis.input_schema)
    assert(
      JSON.stringify(claudeSchema) === JSON.stringify(praxisSchema),
      `${name} schema differs: ${JSON.stringify({ claude: claudeSchema, praxis: praxisSchema })}`,
    )
  }

  const praxis = implementations.find(
    (implementation) => implementation.label === 'praxis',
  )
  assert(praxis, 'Praxis fixture missing')

  const askConfigRoot = join(root, 'praxis-ask-config')
  const askStart = requests.length
  await runTty(
    praxis.command,
    [...praxis.args, '--model', 'fixture-model', 'ASK_USER_ROUND_TRIP'],
    {
      env: {
        ...praxis.env,
        CLAUDE_CONFIG_DIR: askConfigRoot,
        PRAXIS_HOME: askConfigRoot,
      },
    },
    'Praxis AskUserQuestion round trip',
    [
      { waitFor: 'Enter one option number or custom text', input: '1\r' },
      { waitFor: askMarker, input: '/exit\r' },
    ],
  )
  const askMessages = JSON.stringify(
    requests.slice(askStart).map((request) => request.messages),
  )
  assert(
    askMessages.includes('toolu_ask_round_trip') &&
      askMessages.includes('Option A') &&
      askMessages.includes('Which option?'),
    'AskUserQuestion answer did not round-trip through provider messages',
  )

  const planConfigRoot = join(root, 'praxis-plan-config')
  const planStart = requests.length
  const planOutput = await runTty(
    praxis.command,
    [...praxis.args, '--model', 'fixture-model', 'PLAN_MODE_ROUND_TRIP'],
    {
      env: {
        ...praxis.env,
        CLAUDE_CONFIG_DIR: planConfigRoot,
        PRAXIS_HOME: planConfigRoot,
      },
    },
    'Praxis plan-mode round trip',
    [
      { waitFor: '2. Yes, manually approve edits', input: '\u001B[B' },
      { waitFor: '❯ 2. Yes, manually approve edits', input: '\r' },
      { waitFor: planMarker, input: '' },
      { waitFor: 'Try "review this project"', input: '/exit\r' },
    ],
  )
  assert(planOutput.includes(planMarker), 'Plan-mode final response missing')
  const planMessages = JSON.stringify(
    requests.slice(planStart).map((request) => request.messages),
  )
  const planPath = planMessages.match(
    /\/[^"\\]*\/plans\/praxis-([0-9a-f-]{36})\.md/u,
  )
  assert(planPath, 'Plan-mode provider messages omitted native plan path')
  await assert(
    (await readFile(planPath[0], 'utf8')) === '# Plan\n\n1. Ship it.\n',
    'Plan-mode Write did not persist expected plan content',
  )
  const transcript = await readFile(
    resolveDataPlanePaths({
      dataPlane: 'native',
      root: planConfigRoot,
      cwd,
      sessionId: planPath[1],
    }).sessionFile,
    'utf8',
  )
  const permissionModes = transcript
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === 'permission-mode')
    .map((entry) => entry.permissionMode)
  assert(
    JSON.stringify(permissionModes) === JSON.stringify(['plan', 'default']),
    `Plan-mode transcript transitions differ: ${JSON.stringify(permissionModes)}`,
  )
  if (failure) throw failure

  console.log(
    'Interactive plan compatibility passed: positional TTY routing, interactive-only exposure, Claude schema parity, question round-trip, and persisted plan-mode transitions.',
  )
} finally {
  await new Promise((resolve) => provider.close(resolve))
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  })
}
