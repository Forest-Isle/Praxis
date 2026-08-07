import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import {
  detectClaudeVersion,
  runClaudeJson,
  writeFixture as write,
} from './lib/claude-probe.mjs'

const execFileAsync = promisify(execFile)
const probeRoot = await mkdtemp(join(tmpdir(), 'praxis-conditional-rules-'))
const claudeMarker = 'CONDITIONAL_RULE_ACTIVE_4731'
const claudeRootMarker = 'CONDITIONAL_ROOT_RULE_ACTIVE_5842'
const claudeUserMarker = 'CONDITIONAL_USER_RULE_ACTIVE_6953'
const claudeEditMarker = 'CONDITIONAL_EDIT_RULE_ACTIVE_8064'
const praxisMarker = 'PRAXIS_CONDITIONAL_RULE_ACTIVE_5824'
const praxisRootMarker = 'PRAXIS_CONDITIONAL_ROOT_ACTIVE_7137'
const praxisUserMarker = 'PRAXIS_CONDITIONAL_USER_ACTIVE_8248'
let claudeResumeRequest

const claudeResumeServer = createServer(async (request, response) => {
  let body = ''
  request.setEncoding('utf8')
  for await (const chunk of request) body += chunk
  if (!request.url?.startsWith('/v1/messages')) {
    response.writeHead(404).end()
    return
  }
  claudeResumeRequest = JSON.parse(body)
  const serialized = JSON.stringify(claudeResumeRequest)
  const expectedMarkers = serialized.includes(praxisMarker)
    ? [praxisMarker, praxisRootMarker, praxisUserMarker]
    : [claudeMarker, claudeRootMarker, claudeUserMarker]
  const complete = expectedMarkers.every((marker) =>
    serialized.includes(marker),
  )
  const text = complete
    ? 'CLAUDE_CONDITIONAL_CONTEXT_COMPLETE'
    : 'CLAUDE_CONDITIONAL_CONTEXT_INCOMPLETE'
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_conditional_resume',
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
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(''),
  )
})

function sse(response, payloads) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    `${payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join('')}data: [DONE]\n\n`,
  )
}

const server = createServer(async (request, response) => {
  let body = ''
  request.setEncoding('utf8')
  for await (const chunk of request) body += chunk
  const providerRequest = JSON.parse(body)
  const messages = providerRequest.messages ?? []
  const lastUserIndex = messages.findLastIndex(
    (message) => message.role === 'user',
  )
  const prompt = String(messages[lastUserIndex]?.content ?? '')
  const hasToolResult = messages
    .slice(lastUserIndex + 1)
    .some((message) => message.role === 'tool')
  const actions = [
    ['PRAXIS_POSITIVE_READ', 'Read', { file_path: 'src/app.ts' }],
    ['PRAXIS_NEGATIVE_NONMATCH_READ', 'Read', { file_path: 'docs/guide.md' }],
    [
      'PRAXIS_NEGATIVE_WRITE',
      'Write',
      { file_path: 'src/negative.ts', content: 'export const negative = true' },
    ],
    [
      'PRAXIS_NEGATIVE_EDIT',
      'Edit',
      {
        file_path: 'src/app.ts',
        old_string: 'value = 1',
        new_string: 'value = 2',
      },
    ],
    ['PRAXIS_NEGATIVE_GREP', 'Grep', { pattern: 'export', path: 'src' }],
    ['PRAXIS_NEGATIVE_BASH', 'Bash', { command: 'cat src/app.ts' }],
  ]
  const action = actions.find(([token]) => prompt.includes(token))

  if (action && !hasToolResult) {
    const [, name, input] = action
    sse(response, [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: `call_${String(name).toLowerCase()}_conditional`,
                  type: 'function',
                  function: {
                    name,
                    arguments: JSON.stringify(input),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    ])
    return
  }

  const serialized = JSON.stringify(messages)
  const shouldBeActive =
    prompt.includes('PRAXIS_POSITIVE_READ') ||
    prompt.includes('PRAXIS_POSITIVE_RESUME')
  const markersActive = [
    praxisMarker,
    praxisRootMarker,
    praxisUserMarker,
  ].every((marker) => serialized.includes(marker))
  if (markersActive !== shouldBeActive) {
    response.writeHead(500, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({ error: { message: 'conditional rule state mismatch' } }),
    )
    return
  }
  sse(response, [
    {
      choices: [
        {
          delta: {
            content: 'PRAXIS_CONDITIONAL_PROVIDER_OK_9359',
          },
        },
      ],
    },
  ])
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

function listenClaudeResumeServer() {
  return new Promise((resolve, reject) => {
    claudeResumeServer.once('error', reject)
    claudeResumeServer.listen(0, '127.0.0.1', resolve)
  })
}

function closeClaudeResumeServer() {
  return new Promise((resolve, reject) =>
    claudeResumeServer.close((error) => (error ? reject(error) : resolve())),
  )
}

async function findSessionFile(directory, sessionId) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      const nested = await findSessionFile(path, sessionId)
      if (nested) return nested
    } else if (entry.name === `${sessionId}.jsonl`) {
      return path
    }
  }
  return null
}

async function runClaudeCase(label, prompt, tools, cwd, configRoot) {
  const response = await runClaudeJson(
    [
      '-p',
      '--model',
      'haiku',
      '--max-turns',
      '3',
      '--tools',
      tools,
      '--output-format',
      'json',
      ...(tools ? ['--dangerously-skip-permissions'] : []),
      prompt,
    ],
    cwd,
    configRoot,
  )
  if (response.type !== 'result' || response.is_error) {
    throw new Error(`${label} failed: ${JSON.stringify(response)}`)
  }
  return response
}

function assertMarker(response, expected, marker, label) {
  const active = String(response.result).includes(marker)
  if (active !== expected) {
    throw new Error(`${label} activation was ${active}; expected ${expected}`)
  }
}

function resultRecord(stdout) {
  const records = stdout
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
  const result = records.find((record) => record.type === 'result')
  if (!result || typeof result.sessionId !== 'string') {
    throw new Error(`Praxis CLI emitted no result record: ${stdout}`)
  }
  return result
}

async function readEntries(configRoot, sessionId) {
  const transcriptPath = await findSessionFile(configRoot, sessionId)
  if (!transcriptPath) throw new Error(`Session ${sessionId} was not written`)
  return (await readFile(transcriptPath, 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
}

function assertClaudeToolOutcome(entries, expectedTool, label) {
  const toolCalls = entries.flatMap((entry) =>
    entry.type === 'assistant' && Array.isArray(entry.message?.content)
      ? entry.message.content.filter(
          (block) => block.type === 'tool_use' && block.name === expectedTool,
        )
      : [],
  )
  if (toolCalls.length !== 1) {
    throw new Error(`${label} wrote ${toolCalls.length} ${expectedTool} calls`)
  }
  const toolCallId = toolCalls[0].id
  const toolResults = entries.flatMap((entry) =>
    entry.type === 'user' && Array.isArray(entry.message?.content)
      ? entry.message.content.filter(
          (block) =>
            block.type === 'tool_result' && block.tool_use_id === toolCallId,
        )
      : [],
  )
  if (toolResults.length !== 1 || toolResults[0].is_error === true) {
    throw new Error(`${label} did not write one successful tool result`)
  }
}

function assertNativeAttachment(
  entries,
  marker,
  expectedGlob,
  expectedType,
  label,
) {
  const attachments = entries.filter(
    (entry) =>
      entry.type === 'attachment' &&
      entry.attachment?.type === 'nested_memory' &&
      String(entry.attachment?.content?.content).includes(marker),
  )
  if (attachments.length !== 1) {
    throw new Error(`${label} wrote ${attachments.length} rule attachments`)
  }
  const [attachment] = attachments
  if (
    !attachment.attachment.content.globs.includes(expectedGlob) ||
    attachment.attachment.content.type !== expectedType ||
    attachment.attachment.content.contentDiffersFromDisk !== true ||
    !String(attachment.attachment.content.rawContent).includes(marker)
  ) {
    throw new Error(`${label} attachment did not match native envelope`)
  }
  const index = entries.indexOf(attachment)
  let previousIndex = index - 1
  while (entries[previousIndex]?.type === 'attachment') previousIndex -= 1
  const previous = entries[previousIndex]
  if (
    previous?.type !== 'user' ||
    previous.message?.content?.[0]?.type !== 'tool_result'
  ) {
    throw new Error(`${label} attachment did not follow Read tool result`)
  }
}

try {
  const version = await detectClaudeVersion('Conditional-rule probe')
  const configRoot = join(probeRoot, 'config')
  const repository = join(probeRoot, 'work')
  const workDirectory = join(repository, 'packages', 'app')
  await Promise.all([
    write(join(workDirectory, 'src', 'app.ts'), 'export const value = 1\n'),
    write(join(workDirectory, 'docs', 'guide.md'), '# Guide\n'),
    write(join(workDirectory, 'editable', 'config.txt'), 'value=before\n'),
    write(
      join(workDirectory, '.claude', 'rules', 'typescript.md'),
      `---\npaths:\n  - "src/**/*.ts"\n---\nWhen active, include exactly ${claudeMarker}.\n`,
    ),
    write(
      join(repository, '.claude', 'rules', 'root.md'),
      `---\npaths: ["packages/app/src/**/*.ts"]\n---\nWhen active, include exactly ${claudeRootMarker}.\n`,
    ),
    write(
      join(configRoot, 'rules', 'user.md'),
      `---\n"paths": ["src/**/*.ts"]\n---\nWhen active, include exactly ${claudeUserMarker}.\n`,
    ),
  ])
  await execFileAsync('git', ['init', '-q', repository])
  const cwd = await realpath(workDirectory)

  const editPreread = await runClaudeCase(
    'Edit prerequisite Read',
    'Use Read exactly once on editable/config.txt, then do not use more tools and reply briefly.',
    'Read',
    cwd,
    configRoot,
  )
  const editPrereadEntries = await readEntries(
    configRoot,
    editPreread.session_id,
  )
  assertClaudeToolOutcome(editPrereadEntries, 'Read', 'Edit prerequisite Read')
  if (editPrereadEntries.some((entry) => entry.type === 'attachment')) {
    throw new Error('Edit prerequisite Read activated an unrelated rule')
  }
  await write(
    join(workDirectory, '.claude', 'rules', 'editable.md'),
    `---\npaths: ["editable/*.txt"]\n---\nWhen active, include exactly ${claudeEditMarker}.\n`,
  )
  const edited = await runClaudeJson(
    [
      '-p',
      '--resume',
      editPreread.session_id,
      '--model',
      'haiku',
      '--max-turns',
      '3',
      '--tools',
      'Edit',
      '--dangerously-skip-permissions',
      '--output-format',
      'json',
      'Use Edit exactly once on editable/config.txt to replace "value=before" with "value=after", then do not use more tools and reply briefly.',
    ],
    cwd,
    configRoot,
  )
  if (edited.type !== 'result' || edited.is_error) {
    throw new Error(`Edit failed: ${JSON.stringify(edited)}`)
  }
  const editedEntries = await readEntries(configRoot, editPreread.session_id)
  assertClaudeToolOutcome(editedEntries, 'Edit', 'Edit')
  if (editedEntries.some((entry) => entry.type === 'attachment')) {
    throw new Error('Successful Edit activated a path rule attachment')
  }

  const noPath = await runClaudeCase(
    'no path',
    'Without using tools, reply with every token matching CONDITIONAL_[A-Z0-9_]+ already present in active instructions.',
    '',
    cwd,
    configRoot,
  )
  for (const marker of [
    claudeMarker,
    claudeRootMarker,
    claudeUserMarker,
    claudeEditMarker,
  ]) {
    assertMarker(noPath, false, marker, 'No path')
  }

  const mentioned = await runClaudeCase(
    'mentioned path',
    'Regarding src/app.ts, without using tools reply with every token matching CONDITIONAL_[A-Z0-9_]+ already present in active instructions.',
    '',
    cwd,
    configRoot,
  )
  for (const marker of [claudeMarker, claudeRootMarker, claudeUserMarker]) {
    assertMarker(mentioned, false, marker, 'Mentioned path')
  }

  const nonmatchingRead = await runClaudeCase(
    'nonmatching Read',
    'Use Read exactly once on docs/guide.md, then do not use more tools and reply with every token matching CONDITIONAL_[A-Z0-9_]+ in active instructions.',
    'Read',
    cwd,
    configRoot,
  )
  for (const marker of [claudeMarker, claudeRootMarker, claudeUserMarker]) {
    assertMarker(nonmatchingRead, false, marker, 'Nonmatching Read')
  }
  const nonmatchingReadEntries = await readEntries(
    configRoot,
    nonmatchingRead.session_id,
  )
  assertClaudeToolOutcome(nonmatchingReadEntries, 'Read', 'Nonmatching Read')
  if (nonmatchingReadEntries.some((entry) => entry.type === 'attachment')) {
    throw new Error('Nonmatching Read activated a path rule attachment')
  }

  const matchingRead = await runClaudeCase(
    'matching Read',
    'Use Read exactly once on src/app.ts, then do not use more tools and reply with every token matching CONDITIONAL_[A-Z0-9_]+ in active instructions.',
    'Read',
    cwd,
    configRoot,
  )
  for (const marker of [claudeMarker, claudeRootMarker, claudeUserMarker]) {
    assertMarker(matchingRead, true, marker, 'Matching Read')
  }
  assertMarker(matchingRead, false, claudeEditMarker, 'Matching Read')
  assertClaudeToolOutcome(
    await readEntries(configRoot, matchingRead.session_id),
    'Read',
    'Matching Read',
  )

  for (const [label, prompt, tool] of [
    [
      'Write',
      'Use Write exactly once to create src/written.ts containing "export const written = true", then do not use more tools and reply briefly.',
      'Write',
    ],
    [
      'Grep',
      'Use Grep exactly once to search for "export" in src with output_mode "content", then do not use more tools and reply briefly.',
      'Grep',
    ],
    [
      'Bash',
      'Use Bash exactly once to run "cat src/app.ts", then do not use more tools and reply briefly.',
      'Bash',
    ],
  ]) {
    const response = await runClaudeCase(label, prompt, tool, cwd, configRoot)
    const entries = await readEntries(configRoot, response.session_id)
    assertClaudeToolOutcome(entries, tool, label)
    const attached = entries.some((entry) => entry.type === 'attachment')
    if (attached) throw new Error(`${label} activated a path rule attachment`)
  }

  await listenClaudeResumeServer()
  const claudeResumeAddress = claudeResumeServer.address()
  if (!claudeResumeAddress || typeof claudeResumeAddress === 'string') {
    throw new Error('Conditional Claude resume fixture has no TCP address')
  }
  const claudeResumed = await runClaudeJson(
    [
      '-p',
      '--resume',
      matchingRead.session_id,
      '--model',
      'haiku',
      '--max-turns',
      '1',
      '--tools',
      '',
      '--output-format',
      'json',
      'Without using tools, reply with every token matching CONDITIONAL_[A-Z0-9_]+ already present in active instructions.',
    ],
    cwd,
    configRoot,
    {
      ANTHROPIC_API_KEY: 'fixture-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${claudeResumeAddress.port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  )
  if (
    claudeResumed.result !== 'CLAUDE_CONDITIONAL_CONTEXT_COMPLETE' ||
    !claudeResumeRequest
  ) {
    throw new Error(
      `Claude resume did not receive conditional context: ${JSON.stringify(claudeResumed)}`,
    )
  }
  const claudeResumeSerialized = JSON.stringify(claudeResumeRequest)
  for (const marker of [claudeMarker, claudeRootMarker, claudeUserMarker]) {
    if (!claudeResumeSerialized.includes(marker)) {
      throw new Error(`Claude resume request omitted ${marker}`)
    }
  }
  if (claudeResumeSerialized.includes(claudeEditMarker)) {
    throw new Error('Claude resume request included inactive edit rule')
  }
  assertNativeAttachment(
    await readEntries(configRoot, matchingRead.session_id),
    claudeMarker,
    'src/**/*.ts',
    'Project',
    'Claude',
  )
  assertNativeAttachment(
    await readEntries(configRoot, matchingRead.session_id),
    claudeRootMarker,
    'packages/app/src/**/*.ts',
    'Project',
    'Claude root rule',
  )
  assertNativeAttachment(
    await readEntries(configRoot, matchingRead.session_id),
    claudeUserMarker,
    'src/**/*.ts',
    'User',
    'Claude user rule',
  )

  await write(
    join(cwd, '.claude', 'rules', 'typescript.md'),
    `---\npaths: ["src/**/*.ts"]\n---\nWhen active, include exactly ${praxisMarker}.\n`,
  )
  await Promise.all([
    write(
      join(repository, '.claude', 'rules', 'root.md'),
      `---\npaths: ["packages/app/src/**/*.ts"]\n---\nWhen active, include exactly ${praxisRootMarker}.\n`,
    ),
    write(
      join(configRoot, 'rules', 'user.md'),
      `---\n"paths": ["src/**/*.ts"]\n---\nWhen active, include exactly ${praxisUserMarker}.\n`,
    ),
    write(
      join(configRoot, 'settings.json'),
      JSON.stringify({
        permissions: { allow: ['Read', 'Write', 'Edit', 'Grep', 'Bash'] },
      }),
    ),
  ])
  await listen()
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Conditional-rule provider has no TCP address')
  }
  const environment = {
    ...process.env,
    CLAUDE_CONFIG_DIR: configRoot,
    PRAXIS_API_KEY: 'fixture-key',
    PRAXIS_MODEL: 'fixture-model',
    PRAXIS_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
  }
  const cliPath = join(process.cwd(), 'dist', 'cli.js')
  const runPraxis = async (prompt) => {
    const run = await execFileAsync(
      process.execPath,
      [cliPath, 'run', '--json', prompt],
      { cwd, env: environment },
    )
    return resultRecord(run.stdout)
  }
  const praxisResult = await runPraxis('PRAXIS_POSITIVE_READ')
  await execFileAsync(
    process.execPath,
    [
      cliPath,
      'resume',
      '--json',
      praxisResult.sessionId,
      'PRAXIS_POSITIVE_RESUME',
    ],
    { cwd, env: environment },
  )
  const praxisEntries = await readEntries(configRoot, praxisResult.sessionId)
  assertNativeAttachment(
    praxisEntries,
    praxisMarker,
    'src/**/*.ts',
    'Project',
    'Praxis',
  )
  assertNativeAttachment(
    praxisEntries,
    praxisRootMarker,
    'packages/app/src/**/*.ts',
    'Project',
    'Praxis root rule',
  )
  assertNativeAttachment(
    praxisEntries,
    praxisUserMarker,
    'src/**/*.ts',
    'User',
    'Praxis user rule',
  )

  for (const prompt of [
    'PRAXIS_NEGATIVE_MENTION src/app.ts',
    'PRAXIS_NEGATIVE_NONMATCH_READ',
    'PRAXIS_NEGATIVE_WRITE',
    'PRAXIS_NEGATIVE_EDIT',
    'PRAXIS_NEGATIVE_GREP',
    'PRAXIS_NEGATIVE_BASH',
  ]) {
    const result = await runPraxis(prompt)
    const entries = await readEntries(configRoot, result.sessionId)
    if (entries.some((entry) => entry.type === 'attachment')) {
      throw new Error(`${prompt} wrote a conditional rule attachment`)
    }
  }

  claudeResumeRequest = undefined
  const claudeOpenedPraxis = await runClaudeJson(
    [
      '-p',
      '--resume',
      praxisResult.sessionId,
      '--model',
      'haiku',
      '--max-turns',
      '1',
      '--tools',
      '',
      '--output-format',
      'json',
      'Without using tools, reply with every token matching PRAXIS_CONDITIONAL_[A-Z0-9_]+ already present in active instructions.',
    ],
    cwd,
    configRoot,
    {
      ANTHROPIC_API_KEY: 'fixture-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${claudeResumeAddress.port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  )
  if (
    claudeOpenedPraxis.result !== 'CLAUDE_CONDITIONAL_CONTEXT_COMPLETE' ||
    !claudeResumeRequest
  ) {
    throw new Error(
      `Claude resume of Praxis attachment did not receive conditional context: ${JSON.stringify(claudeOpenedPraxis)}`,
    )
  }
  const claudePraxisSerialized = JSON.stringify(claudeResumeRequest)
  for (const marker of [praxisMarker, praxisRootMarker, praxisUserMarker]) {
    if (!claudePraxisSerialized.includes(marker)) {
      throw new Error(`Claude resume of Praxis attachment omitted ${marker}`)
    }
  }

  console.log(
    `Claude ${version} conditional-rule compatibility passed: Read-only activation, native attachment persistence, Praxis live reload, Praxis resume, and Claude resume`,
  )
} finally {
  if (server.listening) await closeServer()
  if (claudeResumeServer.listening) await closeClaudeResumeServer()
  await rm(probeRoot, { recursive: true })
}
