import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import {
  assertContains,
  detectClaudeVersion,
  runClaudeJson,
  writeFixture,
} from './lib/claude-probe.mjs'

const root = await mkdtemp(join(tmpdir(), 'praxis-hook-compat-'))
const configRoot = join(root, 'config')
const cwd = join(root, 'work')
const hookScript = join(root, 'hook.mjs')
const hookLog = join(root, 'hooks.jsonl')
const execFileAsync = promisify(execFile)
const markers = {
  prompt: 'HOOK_PROMPT_CONTEXT_4187',
  pre: 'HOOK_PRE_CONTEXT_5298',
  post: 'HOOK_POST_CONTEXT_6309',
  updated: 'UPDATED_HOOK_TOOL_7410',
  blocked: 'TOOL_BLOCKED_8521',
  praxisDone: 'PRAXIS_HOOK_DONE_9632',
  sessionEnd: 'SESSION_END_UNPERSISTED_0743',
}

const server = createServer(async (request, response) => {
  let body = ''
  request.setEncoding('utf8')
  for await (const chunk of request) body += chunk
  const providerRequest = JSON.parse(body)
  const serialized = JSON.stringify(providerRequest.messages ?? [])
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  if (serialized.includes(markers.updated)) {
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: markers.praxisDone }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    )
    return
  }
  response.end(
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_hook_compat', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: 'printf ORIGINAL_HOOK_TOOL' }) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
  )
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

async function findSessionFile(directory, sessionId) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      const nested = await findSessionFile(path, sessionId)
      if (nested) return nested
    } else if (entry.name === `${sessionId}.jsonl`) return path
  }
  return null
}

function parseEntries(source) {
  return source
    .trimEnd()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function runPraxisStreamInput(cli, args, input, options) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [cli, ...args],
      options,
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }))
          return
        }
        resolve({ stdout, stderr })
      },
    )
    child.stdin?.end(input)
  })
}

try {
  const version = await detectClaudeVersion('Hook compatibility probe')
  await Promise.all([
    writeFixture(join(cwd, '.keep'), ''),
    writeFixture(
      hookScript,
      `import { appendFile } from 'node:fs/promises'
let input = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) input += chunk
await appendFile(process.argv[2], input.trim() + '\\n')
const event = JSON.parse(input)
if (event.hook_event_name === 'PreToolUse' && event.tool_input.command.includes('BLOCK_TOOL')) {
  console.error('${markers.blocked}')
  process.exit(2)
}
if (event.hook_event_name === 'UserPromptSubmit') console.log('${markers.prompt}')
if (event.hook_event_name === 'PreToolUse') console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...event.tool_input, command: 'printf ${markers.updated}' }, permissionDecision: 'allow', additionalContext: '${markers.pre}' } }))
if (event.hook_event_name === 'PostToolUse') console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '${markers.post}' } }))
if (event.hook_event_name === 'SessionEnd') console.log('${markers.sessionEnd}')
`,
    ),
    writeFixture(
      join(configRoot, 'settings.json'),
      JSON.stringify({
        hooks: Object.fromEntries(
          [
            'SessionStart',
            'UserPromptSubmit',
            'PreToolUse',
            'PostToolUse',
            'Stop',
            'SessionEnd',
          ].map((event) => [
            event,
            [
              {
                ...(event.includes('Tool') ? { matcher: 'Bash' } : {}),
                hooks: [
                  {
                    type: 'command',
                    command: `node ${JSON.stringify(hookScript)} ${JSON.stringify(hookLog)}`,
                  },
                ],
              },
            ],
          ]),
        ),
      }),
    ),
  ])

  const success = await runClaudeJson(
    [
      '-p',
      '--model',
      'haiku',
      '--max-turns',
      '3',
      '--permission-mode',
      'bypassPermissions',
      '--tools',
      'Bash',
      '--output-format',
      'json',
      'Call Bash exactly once with command printf ORIGINAL_HOOK_TOOL, then reply done.',
    ],
    cwd,
    configRoot,
  )
  const successEvents = parseEntries(await readFile(hookLog, 'utf8')).filter(
    (event) => event.session_id === success.session_id,
  )
  const eventNames = successEvents.map((event) => event.hook_event_name)
  if (
    JSON.stringify(eventNames) !==
    JSON.stringify([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'Stop',
      'SessionEnd',
    ])
  ) {
    throw new Error(`Unexpected Claude hook order: ${eventNames.join(', ')}`)
  }
  const pre = successEvents.find(
    (event) => event.hook_event_name === 'PreToolUse',
  )
  const post = successEvents.find(
    (event) => event.hook_event_name === 'PostToolUse',
  )
  if (
    pre?.tool_name !== 'Bash' ||
    pre.tool_input?.command !== 'printf ORIGINAL_HOOK_TOOL' ||
    post?.tool_input?.command !== `printf ${markers.updated}` ||
    post.tool_response?.stdout !== markers.updated
  ) {
    throw new Error('Claude hook input rewrite contract changed')
  }
  const transcript = await readFile(successEvents[0].transcript_path, 'utf8')
  for (const marker of [
    markers.prompt,
    markers.pre,
    markers.post,
    markers.updated,
    '"type":"hook_success"',
    '"type":"hook_additional_context"',
  ]) {
    assertContains(transcript, marker, 'Claude hook transcript')
  }
  if (transcript.includes(markers.sessionEnd)) {
    throw new Error('Claude persisted SessionEnd output in transcript')
  }

  const blocked = await runClaudeJson(
    [
      '-p',
      '--model',
      'haiku',
      '--max-turns',
      '3',
      '--permission-mode',
      'bypassPermissions',
      '--tools',
      'Bash',
      '--output-format',
      'json',
      'Call Bash exactly once with command printf BLOCK_TOOL, then report the tool result.',
    ],
    cwd,
    configRoot,
  )
  assertContains(String(blocked.result), markers.blocked, 'Claude blocked tool')
  const blockedEvents = parseEntries(await readFile(hookLog, 'utf8')).filter(
    (event) => event.session_id === blocked.session_id,
  )
  if (blockedEvents.some((event) => event.hook_event_name === 'PostToolUse')) {
    throw new Error('Claude ran PostToolUse after a blocked PreToolUse')
  }
  const blockedTranscript = await readFile(
    blockedEvents[0].transcript_path,
    'utf8',
  )
  assertContains(
    blockedTranscript,
    markers.blocked,
    'Claude blocked transcript',
  )
  await listen()
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Hook compatibility provider did not bind')
  }
  const cli = join(process.cwd(), 'dist', 'cli.js')
  const praxisEnvironment = {
    ...process.env,
    CLAUDE_CONFIG_DIR: configRoot,
    PRAXIS_DATA_PLANE: 'claude',
    PRAXIS_API_KEY: 'fixture-key',
    PRAXIS_PROVIDER: 'openai',
    PRAXIS_MODEL: 'fixture-model',
    PRAXIS_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
  }
  const { stdout } = await execFileAsync(
    process.execPath,
    [cli, 'run', '--json', 'Run the hook compatibility tool.'],
    {
      cwd,
      env: praxisEnvironment,
      maxBuffer: 4 * 1024 * 1024,
    },
  )
  const praxisResult = stdout
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((record) => record.type === 'result')
  if (!praxisResult?.sessionId) {
    throw new Error(`Praxis emitted no hook result: ${stdout}`)
  }
  assertContains(String(praxisResult.text), markers.praxisDone, 'Praxis hooks')
  const praxisSessionFile = await findSessionFile(
    join(configRoot, 'projects'),
    praxisResult.sessionId,
  )
  if (!praxisSessionFile) throw new Error('Praxis hook transcript is missing')
  const praxisTranscript = await readFile(praxisSessionFile, 'utf8')
  const praxisEvents = parseEntries(await readFile(hookLog, 'utf8')).filter(
    (event) => event.session_id === praxisResult.sessionId,
  )
  if (praxisEvents.at(-1)?.hook_event_name !== 'SessionEnd') {
    throw new Error('Praxis did not execute SessionEnd after its tool loop')
  }
  for (const marker of [
    markers.prompt,
    markers.pre,
    markers.post,
    markers.updated,
    markers.praxisDone,
    '"type":"hook_success"',
    '"type":"hook_additional_context"',
  ]) {
    assertContains(praxisTranscript, marker, 'Praxis hook transcript')
  }
  if (praxisTranscript.includes(markers.sessionEnd)) {
    throw new Error('Praxis persisted SessionEnd output in transcript')
  }
  if (parseEntries(praxisTranscript).at(-1)?.type !== 'last-prompt') {
    throw new Error('Praxis SessionEnd changed the native transcript tail')
  }

  const { stdout: streamStdout } = await execFileAsync(
    process.execPath,
    [
      cli,
      '-p',
      '--verbose',
      '--output-format',
      'stream-json',
      '--include-hook-events',
      'Run the hook compatibility tool.',
    ],
    {
      cwd,
      env: praxisEnvironment,
      maxBuffer: 4 * 1024 * 1024,
    },
  )
  const hookRecords = parseEntries(streamStdout).filter(
    (record) =>
      record.type === 'system' &&
      ['hook_started', 'hook_progress', 'hook_response'].includes(
        record.subtype,
      ),
  )
  const startedIds = new Set(
    hookRecords
      .filter((record) => record.subtype === 'hook_started')
      .map((record) => record.hook_id),
  )
  const responses = hookRecords.filter(
    (record) => record.subtype === 'hook_response',
  )
  if (startedIds.size === 0 || responses.length === 0) {
    throw new Error(`Praxis emitted no hook lifecycle records: ${streamStdout}`)
  }
  for (const response of responses) {
    if (!startedIds.has(response.hook_id)) {
      throw new Error(`Praxis hook response has no start: ${response.hook_id}`)
    }
    if (
      typeof response.output !== 'string' ||
      typeof response.stdout !== 'string' ||
      typeof response.stderr !== 'string' ||
      !['success', 'error', 'cancelled'].includes(response.outcome)
    ) {
      throw new Error(
        `Invalid Praxis hook response: ${JSON.stringify(response)}`,
      )
    }
  }

  const hookLogBeforeMulti = parseEntries(
    await readFile(hookLog, 'utf8'),
  ).length
  await runPraxisStreamInput(
    cli,
    [
      '-p',
      '--verbose',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
    ],
    [
      {
        type: 'user',
        message: { role: 'user', content: 'first lifecycle prompt' },
      },
      {
        type: 'user',
        message: { role: 'user', content: 'second lifecycle prompt' },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
    {
      cwd,
      env: praxisEnvironment,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  )
  const multiPromptEvents = parseEntries(await readFile(hookLog, 'utf8')).slice(
    hookLogBeforeMulti,
  )
  const countMultiPromptEvent = (name) =>
    multiPromptEvents.filter((event) => event.hook_event_name === name).length
  const multiPromptSessionIds = new Set(
    multiPromptEvents.map((event) => event.session_id),
  )
  const [multiPromptSessionId] = multiPromptSessionIds
  const multiPromptStart = multiPromptEvents.find(
    (event) => event.hook_event_name === 'SessionStart',
  )
  const multiPromptEnd = multiPromptEvents.find(
    (event) => event.hook_event_name === 'SessionEnd',
  )
  if (
    multiPromptSessionIds.size !== 1 ||
    typeof multiPromptSessionId !== 'string' ||
    multiPromptSessionId.length === 0 ||
    countMultiPromptEvent('SessionStart') !== 1 ||
    countMultiPromptEvent('UserPromptSubmit') !== 2 ||
    countMultiPromptEvent('SessionEnd') !== 1 ||
    multiPromptStart?.source !== 'startup' ||
    multiPromptEnd?.reason !== 'other'
  ) {
    throw new Error(
      `Unexpected multi-prompt hook lifecycle: ${multiPromptEvents
        .map((event) => event.hook_event_name)
        .join(', ')}`,
    )
  }
  await closeServer()

  const reopened = await runClaudeJson(
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
      `Reply with every exact token matching (?:HOOK|PRAXIS)_[A-Z0-9_]+ from conversation context. Include ${markers.praxisDone}.`,
    ],
    cwd,
    configRoot,
  )
  assertContains(
    String(reopened.result),
    markers.praxisDone,
    'Claude resume of Praxis hooks',
  )

  console.log(
    `Claude ${version} hook compatibility passed: lifecycle order, stream records, stdin envelope, input rewrite, context attachments, exit-2 blocking, Praxis execution, and Claude resume`,
  )
} finally {
  if (server.listening) await closeServer()
  await rm(root, { recursive: true })
}
