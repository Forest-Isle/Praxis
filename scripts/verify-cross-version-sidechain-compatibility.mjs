import { randomUUID } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveClaudePaths } from '../dist/compatibility/claude/paths.js'
import { parseClaudeVersionOutput } from '../dist/compatibility/claude/schema.js'
import { execFileAsync } from './lib/claude-probe.mjs'

const REFERENCE_VERSION = '2.1.208'
const CROSS_VERSION = '2.1.233'
const referenceBinary = process.env.PRAXIS_CLAUDE_BINARY
const crossBinary = process.env.PRAXIS_CLAUDE_CROSS_VERSION_BINARY
const ROOT_PROMPT = 'CROSS_SIDECHAIN_ROOT_PROMPT'
const CHILD_PROMPT = 'Return CROSS_SIDECHAIN_CHILD_MARKER'
const CHILD_MARKER = 'CROSS_SIDECHAIN_CHILD_MARKER'
const MAIN_MARKER = 'CROSS_SIDECHAIN_MAIN_MARKER'
const CLAUDE_PROMPT = 'CROSS_SIDECHAIN_CLAUDE_PROMPT'
const CLAUDE_ANSWER = 'CROSS_SIDECHAIN_CLAUDE_ANSWER'
const PRAXIS_PROMPT = 'CROSS_SIDECHAIN_PRAXIS_PROMPT'
const PRAXIS_ANSWER = 'CROSS_SIDECHAIN_PRAXIS_ANSWER'
const TOOL_USE_ID = 'cross_sidechain_agent'
const REVERSE_ROOT_PROMPT = 'REVERSE_CROSS_SIDECHAIN_ROOT_PROMPT'
const REVERSE_CHILD_PROMPT = 'Return REVERSE_CROSS_SIDECHAIN_CHILD_MARKER'
const REVERSE_CHILD_MARKER = 'REVERSE_CROSS_SIDECHAIN_CHILD_MARKER'
const REVERSE_MAIN_MARKER = 'REVERSE_CROSS_SIDECHAIN_MAIN_MARKER'
const REVERSE_CLAUDE_PROMPT = 'REVERSE_CROSS_SIDECHAIN_CLAUDE_PROMPT'
const REVERSE_CLAUDE_ANSWER = 'REVERSE_CROSS_SIDECHAIN_CLAUDE_ANSWER'
const REVERSE_PRAXIS_PROMPT = 'REVERSE_CROSS_SIDECHAIN_PRAXIS_PROMPT'
const REVERSE_PRAXIS_ANSWER = 'REVERSE_CROSS_SIDECHAIN_PRAXIS_ANSWER'
const REVERSE_TOOL_USE_ID = 'reverse_cross_sidechain_agent'

if (!referenceBinary) {
  throw new Error(
    'PRAXIS_CLAUDE_BINARY must point to the Claude Code 2.1.208 executable',
  )
}
if (!crossBinary) {
  throw new Error(
    `PRAXIS_CLAUDE_CROSS_VERSION_BINARY must point to the Claude Code ${CROSS_VERSION} executable`,
  )
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function parseJsonLines(output) {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

async function detectVersion(executable, label) {
  let result
  try {
    result = await execFileAsync(executable, ['--version'], {
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
    })
  } catch (error) {
    throw new Error(
      `${label} at ${executable} could not run: ${error.message ?? error}`,
    )
  }
  return parseClaudeVersionOutput(result.stdout)
}

function textEvents(text) {
  return [
    {
      type: 'message_start',
      message: {
        id: `msg_cross_sidechain_${randomUUID().replaceAll('-', '')}`,
        type: 'message',
        role: 'assistant',
        model: 'fixture-model',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
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

function toolEvents({ description, prompt, toolUseId }) {
  const input = {
    description,
    prompt,
    subagent_type: 'general-purpose',
    run_in_background: false,
  }
  return [
    {
      type: 'message_start',
      message: {
        id: `msg_cross_sidechain_${randomUUID().replaceAll('-', '')}`,
        type: 'message',
        role: 'assistant',
        model: 'fixture-model',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: toolUseId,
        name: 'Agent',
        input: {},
      },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ]
}

function hasAgentTool(body) {
  return body.tools?.some((tool) => tool.name === 'Agent') === true
}

function messagesText(body) {
  return JSON.stringify(body.messages ?? [])
}

function eventsPayload(events) {
  return events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('')
}

const requests = []
const malformed = []
const server = createServer(async (request, response) => {
  if (request.method === 'HEAD') {
    response.writeHead(200).end()
    return
  }
  if (!request.url?.startsWith('/v1/messages')) {
    response.writeHead(404).end()
    return
  }

  let source = ''
  request.setEncoding('utf8')
  for await (const chunk of request) source += chunk

  let body
  try {
    body = JSON.parse(source)
  } catch {
    malformed.push(source)
    response.writeHead(400, { 'content-type': 'text/plain' }).end('malformed')
    return
  }
  requests.push(body)

  const count = requests.length
  const serialized = messagesText(body)
  let events
  if (count === 1) {
    assert(hasAgentTool(body), 'Praxis main request omitted Agent tool schema')
    assert(
      serialized.includes(ROOT_PROMPT),
      'Praxis main request omitted root prompt',
    )
    events = toolEvents({
      description: 'Return cross-version sidechain marker',
      prompt: CHILD_PROMPT,
      toolUseId: TOOL_USE_ID,
    })
  } else if (count === 2) {
    assert(
      !hasAgentTool(body),
      'Praxis child request exposed Agent tool schema',
    )
    assert(
      JSON.stringify(body.system).includes('general-purpose subagent'),
      'Praxis child request omitted native subagent context',
    )
    assert(
      serialized.includes(CHILD_PROMPT),
      'Praxis child request omitted child prompt',
    )
    events = textEvents(CHILD_MARKER)
  } else if (count === 3) {
    assert(
      serialized.includes(TOOL_USE_ID) && serialized.includes(CHILD_MARKER),
      'Praxis main continuation omitted Agent result',
    )
    events = textEvents(MAIN_MARKER)
  } else if (count === 4) {
    assert(
      serialized.includes(CHILD_MARKER) &&
        serialized.includes(MAIN_MARKER) &&
        serialized.includes(CLAUDE_PROMPT),
      'Cross-version Claude request omitted Praxis sidechain context',
    )
    events = textEvents(CLAUDE_ANSWER)
  } else if (count === 5) {
    for (const marker of [
      CHILD_MARKER,
      MAIN_MARKER,
      CLAUDE_PROMPT,
      CLAUDE_ANSWER,
      PRAXIS_PROMPT,
    ]) {
      assert(
        serialized.includes(marker),
        `Praxis post-Claude request omitted ${marker}`,
      )
    }
    events = textEvents(PRAXIS_ANSWER)
  } else if (count === 6) {
    assert(hasAgentTool(body), 'Cross-version main request omitted Agent tool')
    assert(
      serialized.includes(REVERSE_ROOT_PROMPT),
      'Cross-version main request omitted reverse root prompt',
    )
    events = toolEvents({
      description: 'Return reverse cross-version sidechain marker',
      prompt: REVERSE_CHILD_PROMPT,
      toolUseId: REVERSE_TOOL_USE_ID,
    })
  } else if (count === 7) {
    assert(
      hasAgentTool(body),
      'Cross-version child request omitted its inherited Agent tool schema',
    )
    assert(
      body.system !== undefined,
      'Cross-version child request omitted system context',
    )
    assert(
      serialized.includes(REVERSE_CHILD_PROMPT),
      'Cross-version child request omitted reverse child prompt',
    )
    events = textEvents(REVERSE_CHILD_MARKER)
  } else if (count === 8) {
    assert(
      serialized.includes(REVERSE_TOOL_USE_ID) &&
        serialized.includes(REVERSE_CHILD_MARKER),
      'Cross-version main continuation omitted Agent result',
    )
    events = textEvents(REVERSE_MAIN_MARKER)
  } else if (count === 9) {
    assert(
      serialized.includes(REVERSE_CHILD_MARKER) &&
        serialized.includes(REVERSE_MAIN_MARKER) &&
        serialized.includes(REVERSE_CLAUDE_PROMPT),
      'Reference Claude request omitted cross-version sidechain context',
    )
    events = textEvents(REVERSE_CLAUDE_ANSWER)
  } else if (count === 10) {
    for (const marker of [
      REVERSE_CHILD_MARKER,
      REVERSE_MAIN_MARKER,
      REVERSE_CLAUDE_PROMPT,
      REVERSE_CLAUDE_ANSWER,
      REVERSE_PRAXIS_PROMPT,
    ]) {
      assert(
        serialized.includes(marker),
        `Praxis reverse post-Claude request omitted ${marker}`,
      )
    }
    events = textEvents(REVERSE_PRAXIS_ANSWER)
  } else {
    throw new Error(`Unexpected provider request ${count}`)
  }

  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(eventsPayload(events))
})

function listen() {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

function closeServer() {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function runClaude(executable, args, cwd, configRoot, environment) {
  const { stdout } = await execFileAsync(executable, args, {
    cwd,
    env: { ...process.env, ...environment, CLAUDE_CONFIG_DIR: configRoot },
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120_000,
  })
  return JSON.parse(stdout)
}

function assertResult(result, sessionId, expected, label) {
  assert(
    result.type === 'result' &&
      result.is_error !== true &&
      result.session_id === sessionId &&
      result.result === expected,
    `${label} returned unexpected result: ${JSON.stringify(result)}`,
  )
}

const root = await mkdtemp(join(tmpdir(), 'praxis-cross-version-sidechain-'))
const configRoot = join(root, 'config')
const cwd = join(root, 'work')

try {
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(configRoot, { recursive: true }),
  ])
  const canonicalCwd = await realpath(cwd)
  const referenceVersion = await detectVersion(
    referenceBinary,
    'reference Claude CLI',
  )
  const crossVersion = await detectVersion(
    crossBinary,
    'cross-version Claude CLI',
  )
  assert(
    referenceVersion === REFERENCE_VERSION,
    `Reference Claude CLI must be ${REFERENCE_VERSION}, got ${referenceVersion}`,
  )
  assert(
    crossVersion === CROSS_VERSION,
    `Cross-version Claude CLI must be ${CROSS_VERSION}, got ${crossVersion}`,
  )

  await listen()
  const address = server.address()
  assert(
    address !== null && typeof address !== 'string',
    'Cross-version sidechain fixture server has no TCP address',
  )
  const claudeEnvironment = {
    ANTHROPIC_API_KEY: 'fixture-key',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
  }
  const praxisEnvironment = {
    PRAXIS_DATA_PLANE: 'claude',
    PRAXIS_PROVIDER: 'anthropic',
    PRAXIS_API_KEY: 'fixture-key',
    PRAXIS_MODEL: 'fixture-model',
    PRAXIS_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
  }
  const praxis = (...args) =>
    execFileAsync(
      process.execPath,
      [join(process.cwd(), 'dist/cli.js'), ...args],
      {
        cwd: canonicalCwd,
        env: {
          ...process.env,
          ...praxisEnvironment,
          CLAUDE_CONFIG_DIR: configRoot,
        },
        maxBuffer: 4 * 1024 * 1024,
        timeout: 120_000,
      },
    )

  const created = await praxis(
    '-p',
    '--output-format=json',
    '--tools',
    'Agent',
    '--',
    ROOT_PROMPT,
  )
  const createdResult = JSON.parse(created.stdout)
  assert(
    createdResult.type === 'result' &&
      createdResult.is_error !== true &&
      createdResult.result === MAIN_MARKER &&
      typeof createdResult.session_id === 'string',
    `Praxis Agent run returned unexpected result: ${created.stdout}`,
  )
  const sessionId = createdResult.session_id
  assert(
    requests.length === 3,
    `Expected three Praxis Agent requests, got ${requests.length}`,
  )

  const paths = resolveClaudePaths({
    configDir: configRoot,
    cwd: canonicalCwd,
    sessionId,
  })
  const subagentsDirectory = join(paths.projectRoot, sessionId, 'subagents')
  const sidechainFiles = await readdir(subagentsDirectory)
  const jsonlNames = sidechainFiles.filter((name) => name.endsWith('.jsonl'))
  const metadataNames = sidechainFiles.filter((name) =>
    name.endsWith('.meta.json'),
  )
  assert(
    jsonlNames.length === 1,
    `Expected one sidechain JSONL, found ${jsonlNames.join(', ')}`,
  )
  assert(
    metadataNames.length === 1,
    `Expected one sidechain metadata file, found ${metadataNames.join(', ')}`,
  )
  const sidechainPath = join(subagentsDirectory, jsonlNames[0])
  const metadataPath = join(subagentsDirectory, metadataNames[0])
  const sidechainBefore = await readFile(sidechainPath, 'utf8')
  const metadataBefore = await readFile(metadataPath, 'utf8')
  const sidechain = parseJsonLines(sidechainBefore)
  assert(
    /^agent-a[0-9a-f]{16}\.jsonl$/u.test(jsonlNames[0]),
    `Invalid native sidechain filename ${jsonlNames[0]}`,
  )
  assert(sidechain.length > 0, 'Native sidechain is empty')
  assert(
    sidechainBefore.includes(CHILD_MARKER) &&
      sidechainBefore.includes('"isSidechain":true'),
    'Native sidechain omitted child marker or sidechain metadata',
  )
  for (const entry of sidechain) {
    assert(entry.isSidechain === true, 'Sidechain entry omitted isSidechain')
    assert(
      entry.sessionId === sessionId,
      'Sidechain entry has the wrong session ID',
    )
    assert(
      entry.version === REFERENCE_VERSION,
      `Sidechain entry has version ${entry.version}, expected ${REFERENCE_VERSION}`,
    )
  }
  const metadata = JSON.parse(metadataBefore)
  assert(
    metadata.agentType === 'general-purpose' &&
      metadata.toolUseId === TOOL_USE_ID &&
      metadata.spawnDepth === 1,
    `Native sidechain metadata is invalid: ${metadataBefore}`,
  )

  const claudeResult = await runClaude(
    crossBinary,
    [
      '-p',
      '--resume',
      sessionId,
      '--model',
      'haiku',
      '--max-turns',
      '1',
      '--tools',
      '',
      '--output-format',
      'json',
      CLAUDE_PROMPT,
    ],
    canonicalCwd,
    configRoot,
    claudeEnvironment,
  )
  assertResult(claudeResult, sessionId, CLAUDE_ANSWER, 'Cross-version Claude')

  const praxisResumed = await praxis(
    '-p',
    '--output-format=json',
    '--resume',
    sessionId,
    '--',
    PRAXIS_PROMPT,
  )
  assertResult(
    JSON.parse(praxisResumed.stdout),
    sessionId,
    PRAXIS_ANSWER,
    'Praxis post-Claude resume',
  )
  assert(
    malformed.length === 0,
    `Malformed provider traffic: ${malformed.join('; ')}`,
  )
  assert(
    requests.length === 5,
    `Expected five provider requests, got ${requests.length}`,
  )
  assert(
    (await readFile(sidechainPath, 'utf8')) === sidechainBefore,
    'Cross-version resume changed sidechain JSONL',
  )
  assert(
    (await readFile(metadataPath, 'utf8')) === metadataBefore,
    'Cross-version resume changed sidechain metadata',
  )

  const mainEntries = parseJsonLines(await readFile(paths.sessionFile, 'utf8'))
  const prompts = [ROOT_PROMPT, CLAUDE_PROMPT, PRAXIS_PROMPT]
  const versions = [REFERENCE_VERSION, crossVersion, REFERENCE_VERSION]
  let lastIndex = -1
  for (let index = 0; index < prompts.length; index += 1) {
    const prompt = prompts[index]
    const entryIndex = mainEntries.findIndex(
      (entry) => entry.type === 'user' && entry.message?.content === prompt,
    )
    assert(
      entryIndex > lastIndex,
      `Main user entry ${prompt} is missing or out of order`,
    )
    lastIndex = entryIndex
    const entry = mainEntries[entryIndex]
    assert(
      entry.sessionId === sessionId,
      `Main user entry ${prompt} has wrong session ID`,
    )
    assert(
      entry.version === versions[index],
      `Main user entry ${prompt} has version ${entry.version}, expected ${versions[index]}`,
    )
  }

  const reverseConfigRoot = join(root, 'reverse-config')
  const reverseCwd = join(root, 'reverse-work')
  await Promise.all([
    mkdir(reverseCwd, { recursive: true }),
    mkdir(reverseConfigRoot, { recursive: true }),
  ])
  const reverseCanonicalCwd = await realpath(reverseCwd)
  const reverseCreated = await runClaude(
    crossBinary,
    [
      '-p',
      '--model',
      'haiku',
      '--tools',
      'Agent',
      '--output-format',
      'json',
      REVERSE_ROOT_PROMPT,
    ],
    reverseCanonicalCwd,
    reverseConfigRoot,
    claudeEnvironment,
  )
  assert(
    reverseCreated.type === 'result' &&
      reverseCreated.is_error !== true &&
      reverseCreated.result === REVERSE_MAIN_MARKER &&
      typeof reverseCreated.session_id === 'string',
    `Cross-version Agent run returned unexpected result: ${JSON.stringify(reverseCreated)}`,
  )
  const reverseSessionId = reverseCreated.session_id
  assert(
    requests.length === 8,
    `Expected eight provider requests after cross-version Agent run, got ${requests.length}`,
  )

  const reversePaths = resolveClaudePaths({
    configDir: reverseConfigRoot,
    cwd: reverseCanonicalCwd,
    sessionId: reverseSessionId,
  })
  const reverseSubagentsDirectory = join(
    reversePaths.projectRoot,
    reverseSessionId,
    'subagents',
  )
  const reverseSidechainFiles = await readdir(reverseSubagentsDirectory)
  const reverseJsonlNames = reverseSidechainFiles.filter((name) =>
    name.endsWith('.jsonl'),
  )
  const reverseMetadataNames = reverseSidechainFiles.filter((name) =>
    name.endsWith('.meta.json'),
  )
  assert(
    reverseJsonlNames.length === 1,
    `Expected one reverse sidechain JSONL, found ${reverseJsonlNames.join(', ')}`,
  )
  assert(
    reverseMetadataNames.length === 1,
    `Expected one reverse sidechain metadata file, found ${reverseMetadataNames.join(', ')}`,
  )
  const reverseSidechainPath = join(
    reverseSubagentsDirectory,
    reverseJsonlNames[0],
  )
  const reverseMetadataPath = join(
    reverseSubagentsDirectory,
    reverseMetadataNames[0],
  )
  const reverseSidechainBefore = await readFile(reverseSidechainPath, 'utf8')
  const reverseMetadataBefore = await readFile(reverseMetadataPath, 'utf8')
  const reverseSidechain = parseJsonLines(reverseSidechainBefore)
  assert(
    /^agent-a[0-9a-f]{16}\.jsonl$/u.test(reverseJsonlNames[0]),
    `Invalid reverse native sidechain filename ${reverseJsonlNames[0]}`,
  )
  assert(reverseSidechain.length > 0, 'Reverse native sidechain is empty')
  assert(
    reverseSidechainBefore.includes(REVERSE_CHILD_MARKER) &&
      reverseSidechainBefore.includes('"isSidechain":true'),
    'Reverse native sidechain omitted child marker or sidechain metadata',
  )
  for (const entry of reverseSidechain) {
    assert(
      entry.isSidechain === true,
      'Reverse sidechain entry omitted isSidechain',
    )
    assert(
      entry.sessionId === reverseSessionId,
      'Reverse sidechain entry has the wrong session ID',
    )
    assert(
      entry.version === crossVersion,
      `Reverse sidechain entry has version ${entry.version}, expected ${crossVersion}`,
    )
  }
  const reverseMetadata = JSON.parse(reverseMetadataBefore)
  assert(
    reverseMetadata.agentType === 'general-purpose' &&
      reverseMetadata.toolUseId === REVERSE_TOOL_USE_ID &&
      reverseMetadata.spawnDepth === 1,
    `Reverse native sidechain metadata is invalid: ${reverseMetadataBefore}`,
  )

  const reverseClaudeResult = await runClaude(
    referenceBinary,
    [
      '-p',
      '--resume',
      reverseSessionId,
      '--model',
      'haiku',
      '--max-turns',
      '1',
      '--tools',
      '',
      '--output-format',
      'json',
      REVERSE_CLAUDE_PROMPT,
    ],
    reverseCanonicalCwd,
    reverseConfigRoot,
    claudeEnvironment,
  )
  assertResult(
    reverseClaudeResult,
    reverseSessionId,
    REVERSE_CLAUDE_ANSWER,
    'Reference Claude reverse resume',
  )

  const reversePraxisResumed = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), 'dist/cli.js'),
      '-p',
      '--output-format=json',
      '--resume',
      reverseSessionId,
      '--',
      REVERSE_PRAXIS_PROMPT,
    ],
    {
      cwd: reverseCanonicalCwd,
      env: {
        ...process.env,
        ...praxisEnvironment,
        CLAUDE_CONFIG_DIR: reverseConfigRoot,
      },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
    },
  )
  assertResult(
    JSON.parse(reversePraxisResumed.stdout),
    reverseSessionId,
    REVERSE_PRAXIS_ANSWER,
    'Praxis reverse post-Claude resume',
  )
  assert(
    requests.length === 10,
    `Expected ten provider requests, got ${requests.length}`,
  )
  assert(
    (await readFile(reverseSidechainPath, 'utf8')) === reverseSidechainBefore,
    'Reference Claude or Praxis changed reverse sidechain JSONL',
  )
  assert(
    (await readFile(reverseMetadataPath, 'utf8')) === reverseMetadataBefore,
    'Reference Claude or Praxis changed reverse sidechain metadata',
  )

  const reverseMainEntries = parseJsonLines(
    await readFile(reversePaths.sessionFile, 'utf8'),
  )
  const reversePrompts = [
    REVERSE_ROOT_PROMPT,
    REVERSE_CLAUDE_PROMPT,
    REVERSE_PRAXIS_PROMPT,
  ]
  const reverseVersions = [crossVersion, REFERENCE_VERSION, REFERENCE_VERSION]
  let reverseLastIndex = -1
  for (let index = 0; index < reversePrompts.length; index += 1) {
    const prompt = reversePrompts[index]
    const entryIndex = reverseMainEntries.findIndex(
      (entry) => entry.type === 'user' && entry.message?.content === prompt,
    )
    assert(
      entryIndex > reverseLastIndex,
      `Reverse main user entry ${prompt} is missing or out of order`,
    )
    reverseLastIndex = entryIndex
    const entry = reverseMainEntries[entryIndex]
    assert(
      entry.sessionId === reverseSessionId,
      `Reverse main user entry ${prompt} has wrong session ID`,
    )
    assert(
      entry.version === reverseVersions[index],
      `Reverse main user entry ${prompt} has version ${entry.version}, expected ${reverseVersions[index]}`,
    )
  }

  console.log(
    `cross-version sidechain compatibility passed: Praxis wrote a native foreground sidechain, Claude ${crossVersion} resumed session ${sessionId}, and Praxis continued with producer versions [${versions.join(', ')}].`,
  )
  console.log(
    `reverse cross-version sidechain compatibility passed: Claude ${crossVersion} wrote a native foreground sidechain, Claude ${REFERENCE_VERSION} resumed session ${reverseSessionId}, and Praxis continued with producer versions [${reverseVersions.join(', ')}].`,
  )
} finally {
  if (server.listening) await closeServer()
  await rm(root, { recursive: true, force: true })
}
