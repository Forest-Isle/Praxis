import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { detectClaudeVersion } from './lib/claude-probe.mjs'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-web-compat-'))
const configRoot = join(root, 'config')
const cwd = join(root, 'work')
const requests = []
const outerResponses = []
let messageNumber = 0

const calls = [
  {
    id: 'search-allowed',
    name: 'WebSearch',
    input: {
      query: 'current docs',
      allowed_domains: ['example.com'],
    },
  },
  {
    id: 'search-blocked',
    name: 'WebSearch',
    input: {
      query: 'current release',
      blocked_domains: ['blocked.example'],
    },
  },
  {
    id: 'search-both',
    name: 'WebSearch',
    input: {
      query: 'invalid filters',
      allowed_domains: ['allow.example'],
      blocked_domains: ['block.example'],
    },
  },
  {
    id: 'fetch-public',
    name: 'WebFetch',
    input: {
      url: 'https://example.com/',
      prompt: 'Return the page title',
    },
  },
  {
    id: 'fetch-private',
    name: 'WebFetch',
    input: { url: 'https://localhost/private', prompt: 'read it' },
  },
]

function messageStart(id) {
  messageNumber += 1
  return {
    type: 'message_start',
    message: {
      id: id ?? `msg_web_${messageNumber}`,
      type: 'message',
      role: 'assistant',
      model: 'fixture-model',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  }
}

function toolEvents(call) {
  return [
    messageStart(),
    {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: {},
      },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify(call.input),
      },
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

function textEvents(text) {
  return [
    messageStart(),
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

function searchEvents() {
  return [
    {
      type: 'message_start',
      message: {
        id: `msg_inner_${++messageNumber}`,
        type: 'message',
        role: 'assistant',
        model: 'fixture-model',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 2,
          output_tokens: 0,
          server_tool_use: { web_search_requests: 1 },
        },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'server_tool_use',
        id: 'server_search',
        name: 'web_search',
        input: {},
      },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: '{"query":"fixture"}',
      },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'web_search_tool_result',
        tool_use_id: 'server_search',
        content: [
          {
            type: 'web_search_result',
            url: 'https://example.com/result',
            title: 'Example Result',
            page_age: 'August 5, 2026',
            encrypted_content: 'opaque',
          },
        ],
      },
    },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'text_delta', text: 'SEARCH_SUMMARY' },
    },
    {
      type: 'content_block_delta',
      index: 2,
      delta: {
        type: 'citations_delta',
        citation: {
          type: 'web_search_result_location',
          url: 'https://example.com/result',
          title: 'Example Result',
          cited_text: 'fixture result',
          encrypted_index: 'index',
        },
      },
    },
    { type: 'content_block_stop', index: 2 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 3 },
    },
    { type: 'message_stop' },
  ]
}

function isInnerSearch(body) {
  return body.tools?.some(
    (tool) => tool.name === 'web_search' && tool.type === 'web_search_20250305',
  )
}

function isInnerFetch(body) {
  const messages = JSON.stringify(body.messages ?? [])
  return (
    !body.tools?.length &&
    (messages.includes('Web page content:') ||
      messages.includes('Fetched page data follows as JSON')) &&
    !messages.includes('"type":"tool_result"')
  )
}

const provider = createServer(async (request, response) => {
  if (request.method === 'HEAD') {
    response.writeHead(200).end()
    return
  }
  let source = ''
  request.setEncoding('utf8')
  for await (const chunk of request) source += chunk
  if (!source || !request.url?.startsWith('/v1/messages')) {
    response.writeHead(404).end()
    return
  }
  const body = JSON.parse(source)
  requests.push(body)
  const events = isInnerSearch(body)
    ? searchEvents()
    : isInnerFetch(body)
      ? textEvents('FETCH_SUMMARY')
      : outerResponses.shift()
  if (!events) throw new Error('Web provider response queue exhausted')
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(''),
  )
})

function listen() {
  return new Promise((resolve, reject) => {
    provider.once('error', reject)
    provider.listen(0, '127.0.0.1', resolve)
  })
}

function closeProvider() {
  return new Promise((resolve, reject) =>
    provider.close((error) => (error ? reject(error) : resolve())),
  )
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function queueRun(finalText) {
  outerResponses.push(
    ...calls.map((call) => toolEvents(call)),
    textEvents(finalText),
  )
}

function webDefinitions(request) {
  return request.tools?.filter(
    (tool) => tool.name === 'WebFetch' || tool.name === 'WebSearch',
  )
}

function toolResult(runRequests, id) {
  return runRequests
    .flatMap((request) => request.messages ?? [])
    .flatMap((message) =>
      Array.isArray(message.content) ? message.content : [],
    )
    .find((block) => block.type === 'tool_result' && block.tool_use_id === id)
}

function stableToolResultContent(value) {
  return typeof value === 'string'
    ? value.replace(
        /\n\n<system-reminder>\n<total_tokens>\d+ tokens left<\/total_tokens>\n<\/system-reminder>$/u,
        '',
      )
    : value
}

function assertResults(runRequests, label) {
  const links =
    'Links: [{"title":"Example Result","url":"https://example.com/result"}]\n\nSEARCH_SUMMARY'
  for (const call of calls.slice(0, 2)) {
    const result = toolResult(runRequests, call.id)
    assert(
      stableToolResultContent(result?.content) ===
        `Web search results for query: "${call.input.query}"\n\n${links}\n\n\nREMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.` &&
        result.is_error !== true,
      `${label} ${call.id} result changed: ${JSON.stringify(result)}`,
    )
  }
  const both = toolResult(runRequests, 'search-both')
  assert(
    stableToolResultContent(both?.content) ===
      '<tool_use_error>Error: Cannot specify both allowed_domains and blocked_domains in the same request</tool_use_error>' &&
      both.is_error === true,
    `${label} conflicting filters changed: ${JSON.stringify(both)}`,
  )
  const publicFetch = toolResult(runRequests, 'fetch-public')
  const innerFetchCount = runRequests.filter(isInnerFetch).length
  const publicFetchSucceeded =
    stableToolResultContent(publicFetch?.content) === 'FETCH_SUMMARY' &&
    publicFetch.is_error !== true
  assert(
    publicFetchSucceeded,
    `${label} public WebFetch result changed: ${JSON.stringify(publicFetch)}`,
  )
  assert(
    innerFetchCount === 1,
    `${label} public WebFetch processing request changed`,
  )
  const privateFetch = toolResult(runRequests, 'fetch-private')
  assert(
    stableToolResultContent(privateFetch?.content) === 'Invalid URL' &&
      privateFetch.is_error === true,
    `${label} private WebFetch result changed: ${JSON.stringify(privateFetch)}`,
  )
}

function normalizedInnerRequests(runRequests) {
  return runRequests.filter(isInnerSearch).map((request) => ({
    message: request.messages?.[0]?.content?.[0]?.text,
    tools: request.tools,
    toolChoice: request.tool_choice,
  }))
}

async function runClaude(address, extraArgs, prompt) {
  return execFileAsync(
    'claude',
    [
      '-p',
      '--no-session-persistence',
      ...extraArgs,
      '--model',
      'claude-sonnet-4-5-20250929',
      '--max-turns',
      String(calls.length + 1),
      '--output-format',
      'json',
      prompt,
    ],
    {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configRoot,
        ANTHROPIC_API_KEY: 'fixture-key',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      timeout: 120_000,
    },
  )
}

async function runPraxis(address, extraArgs, prompt) {
  return execFileAsync(
    process.execPath,
    [
      join(process.cwd(), 'dist', 'cli.js'),
      '-p',
      ...extraArgs,
      '--output-format',
      'json',
      '--',
      prompt,
    ],
    {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configRoot,
        PRAXIS_PROVIDER: 'anthropic',
        PRAXIS_API_KEY: 'fixture-key',
        PRAXIS_MODEL: 'fixture-model',
        PRAXIS_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        PRAXIS_ANTHROPIC_WEB_SEARCH: 'true',
      },
      timeout: 120_000,
    },
  )
}

try {
  await Promise.all([
    mkdir(configRoot, { recursive: true }),
    mkdir(cwd, { recursive: true }),
  ])
  await listen()
  const address = provider.address()
  if (!address || typeof address === 'string') throw new Error('no address')

  queueRun('CLAUDE_WEB_DONE')
  const claudeStart = requests.length
  await runClaude(
    address,
    [
      '--settings',
      '{"skipWebFetchPreflight":true}',
      '--dangerously-skip-permissions',
      '--allowedTools',
      'WebFetch(domain:example.com)',
      '--tools',
      'WebFetch,WebSearch',
    ],
    'exercise web tools using https://example.com/',
  )
  const claudeRequests = requests.slice(claudeStart)
  assertResults(claudeRequests, 'Claude')

  queueRun('PRAXIS_WEB_DONE')
  const praxisStart = requests.length
  const sessionId = '99999999-9999-4999-8999-999999999999'
  const praxisExecution = await runPraxis(
    address,
    [
      '--session-id',
      sessionId,
      '--dangerously-skip-permissions',
      '--allowedTools',
      'WebFetch(domain:example.com)',
      '--tools',
      'WebFetch,WebSearch',
    ],
    'exercise web tools using https://example.com/',
  )
  const praxisRequests = requests.slice(praxisStart)
  assertResults(praxisRequests, 'Praxis')
  assert(
    JSON.stringify(webDefinitions(praxisRequests[0])) ===
      JSON.stringify(webDefinitions(claudeRequests[0])),
    `Praxis web definitions differ from Claude: ${JSON.stringify({ praxis: webDefinitions(praxisRequests[0]), claude: webDefinitions(claudeRequests[0]) })}`,
  )
  assert(
    JSON.stringify(normalizedInnerRequests(praxisRequests)) ===
      JSON.stringify(normalizedInnerRequests(claudeRequests)),
    'Praxis native web search request differs from Claude',
  )
  const praxisResult = JSON.parse(praxisExecution.stdout)
  assert(
    praxisResult.session_id === sessionId &&
      praxisResult.result === 'PRAXIS_WEB_DONE' &&
      praxisResult.is_error === false,
    `Praxis web run failed: ${praxisExecution.stdout}`,
  )

  outerResponses.push(textEvents('CLAUDE_RESUMED_PRAXIS_WEB'))
  const resumed = await execFileAsync(
    'claude',
    [
      '-p',
      '--safe-mode',
      '--resume',
      sessionId,
      '--tools=',
      '--model',
      'claude-sonnet-4-5-20250929',
      '--max-turns',
      '1',
      '--output-format',
      'json',
      'resume web session',
    ],
    {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configRoot,
        ANTHROPIC_API_KEY: 'fixture-key',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      timeout: 120_000,
    },
  )
  assert(
    JSON.parse(resumed.stdout).result === 'CLAUDE_RESUMED_PRAXIS_WEB',
    `Claude could not resume Praxis web session: ${resumed.stdout}`,
  )

  outerResponses.push(textEvents('CLAUDE_BARE_DONE'))
  const claudeBareStart = requests.length
  await runClaude(
    address,
    [
      '--bare',
      '--dangerously-skip-permissions',
      '--tools',
      'WebFetch,WebSearch',
    ],
    'bare tools',
  )
  const claudeBare = requests[claudeBareStart]
  outerResponses.push(textEvents('PRAXIS_BARE_DONE'))
  const praxisBareStart = requests.length
  await runPraxis(
    address,
    [
      '--bare',
      '--dangerously-skip-permissions',
      '--tools',
      'WebFetch,WebSearch',
    ],
    'bare tools',
  )
  const praxisBare = requests[praxisBareStart]
  assert(
    (claudeBare?.tools?.length ?? 0) === 0 &&
      (praxisBare?.tools?.length ?? 0) === 0,
    'Bare mode exposed web tools',
  )

  outerResponses.push(textEvents('CLAUDE_SAFE_DONE'))
  const claudeSafeStart = requests.length
  await runClaude(
    address,
    [
      '--safe-mode',
      '--dangerously-skip-permissions',
      '--tools',
      'WebFetch,WebSearch',
    ],
    'safe tools',
  )
  outerResponses.push(textEvents('PRAXIS_SAFE_DONE'))
  const praxisSafeStart = requests.length
  await runPraxis(
    address,
    [
      '--safe-mode',
      '--dangerously-skip-permissions',
      '--tools',
      'WebFetch,WebSearch',
    ],
    'safe tools',
  )
  assert(
    JSON.stringify(webDefinitions(requests[praxisSafeStart])) ===
      JSON.stringify(webDefinitions(requests[claudeSafeStart])),
    'Safe-mode web definitions differ',
  )

  const permissionCall = {
    id: 'fetch-domain-allowed',
    name: 'WebFetch',
    input: { url: 'https://localhost/private', prompt: 'read it' },
  }
  outerResponses.push(
    toolEvents(permissionCall),
    textEvents('CLAUDE_DOMAIN_PERMISSION_DONE'),
  )
  const claudePermissionStart = requests.length
  await runClaude(
    address,
    [
      '--permission-mode',
      'dontAsk',
      '--allowedTools',
      'WebFetch(domain:localhost)',
      '--tools',
      'WebFetch',
    ],
    'domain permission',
  )
  const claudePermissionResult = toolResult(
    requests.slice(claudePermissionStart),
    permissionCall.id,
  )

  outerResponses.push(
    toolEvents(permissionCall),
    textEvents('PRAXIS_DOMAIN_PERMISSION_DONE'),
  )
  const praxisPermissionStart = requests.length
  await runPraxis(
    address,
    [
      '--permission-mode',
      'dontAsk',
      '--allowedTools',
      'WebFetch(domain:localhost)',
      '--tools',
      'WebFetch',
    ],
    'domain permission',
  )
  const praxisPermissionResult = toolResult(
    requests.slice(praxisPermissionStart),
    permissionCall.id,
  )
  for (const [label, result] of [
    ['Claude', claudePermissionResult],
    ['Praxis', praxisPermissionResult],
  ]) {
    assert(
      stableToolResultContent(result?.content) === 'Invalid URL' &&
        result.is_error === true,
      `${label} WebFetch domain permission changed: ${JSON.stringify(result)}`,
    )
  }

  const version = await detectClaudeVersion('Web compatibility probe')
  console.log(
    `Claude ${version} web compatibility passed: exact schemas, safe/bare exposure, native filtered search, links/citations, real Claude and Praxis public fetch, domain permissions, private fetch rejection, persistence, and resume`,
  )
} finally {
  if (provider.listening) await closeProvider()
  await rm(root, { recursive: true, force: true })
}
