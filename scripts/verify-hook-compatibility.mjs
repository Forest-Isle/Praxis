import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
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
  taskPrompt: 'TASK_HOOK_PROMPT_1854',
  taskCreated: 'TASK_CREATED_CONTEXT_2965',
  taskCompleted: 'TASK_COMPLETED_CONTEXT_3076',
  taskDone: 'TASK_HOOK_DONE_4187',
  permissionPrompt: 'PERMISSION_DENIED_PROMPT_5298',
  permissionDone: 'PERMISSION_DENIED_DONE_6309',
  permissionRetry:
    'The PermissionDenied hook indicated this command is now approved. You may retry it if you would like.',
  fileChanged: 'FILE_CHANGED_DYNAMIC_7410',
  environmentPrompt: 'SESSION_ENV_PROMPT_8521',
  environmentValue: 'SESSION_ENV_VALUE_9632',
  environmentDone: 'SESSION_ENV_DONE_0743',
  praxisFilePrompt: 'PRAXIS_FILE_WATCH_PROMPT_1854',
  praxisFileDone: 'PRAXIS_FILE_WATCH_DONE_2965',
}

const server = createServer(async (request, response) => {
  let body = ''
  request.setEncoding('utf8')
  for await (const chunk of request) body += chunk
  const providerRequest = JSON.parse(body)
  const serialized = JSON.stringify(providerRequest.messages ?? [])
  const requestSerialized = JSON.stringify(providerRequest)
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  if (requestSerialized.includes('Praxis permission auto-mode classifier')) {
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: '{"behavior":"deny","reason":"compat classifier denied"}' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    )
    return
  }
  if (serialized.includes(markers.permissionPrompt)) {
    if (serialized.includes(markers.permissionRetry)) {
      response.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: markers.permissionDone }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      )
      return
    }
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_permission_denied', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: 'printf AUTO_DENIED' }) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
    )
    return
  }
  if (serialized.includes(markers.environmentPrompt)) {
    if (serialized.includes(markers.environmentValue)) {
      response.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: markers.environmentDone }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      )
      return
    }
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_session_env', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: 'printenv HOOK_SESSION_ENV' }) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
    )
    return
  }
  if (serialized.includes(markers.praxisFilePrompt)) {
    if (serialized.includes('call_praxis_file_watch')) {
      response.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: markers.praxisFileDone }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      )
      return
    }
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_praxis_file_watch', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: 'rm -f dynamic.env; printf one > .env; sleep 1; printf two > .env; sleep 1; rm .env; sleep 1; printf dynamic > dynamic.env; sleep 1' }) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
    )
    return
  }
  if (serialized.includes(markers.taskPrompt)) {
    if (serialized.includes(markers.taskCompleted)) {
      response.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: markers.taskDone }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      )
      return
    }
    const tool = serialized.includes(markers.taskCreated)
      ? {
          id: 'call_task_complete',
          name: 'TaskUpdate',
          input: { taskId: '1', status: 'completed' },
        }
      : {
          id: 'call_task_create',
          name: 'TaskCreate',
          input: {
            subject: 'Hook compatibility task',
            description: 'Prove TaskCreated and TaskCompleted attachments',
          },
        }
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: tool.id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.input) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
    )
    return
  }
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
      `import { appendFile, writeFile } from 'node:fs/promises'
let input = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) input += chunk
const event = JSON.parse(input)
await appendFile(process.argv[2], JSON.stringify({ ...event, claude_env_file: process.env.CLAUDE_ENV_FILE }) + '\\n')
if (event.hook_event_name === 'PreToolUse' && event.tool_input.command.includes('BLOCK_TOOL')) {
  console.error('${markers.blocked}')
  process.exit(2)
}
if (event.hook_event_name === 'UserPromptSubmit') console.log('${markers.prompt}')
if (event.hook_event_name === 'SessionStart') await writeFile(process.env.CLAUDE_ENV_FILE, 'export HOOK_SESSION_ENV=${markers.environmentValue}\\n')
if (event.hook_event_name === 'PreToolUse' && event.tool_input.command.includes('ORIGINAL_HOOK_TOOL')) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...event.tool_input, command: 'printf ${markers.updated}' }, permissionDecision: 'allow', additionalContext: '${markers.pre}' } }))
if (event.hook_event_name === 'PreToolUse' && event.tool_input.command.includes('printf one > .env')) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }))
if (event.hook_event_name === 'PostToolUse') console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '${markers.post}' } }))
if (event.hook_event_name === 'TaskCreated') console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'TaskCreated', additionalContext: '${markers.taskCreated}' } }))
if (event.hook_event_name === 'TaskCompleted') console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'TaskCompleted', additionalContext: '${markers.taskCompleted}' } }))
if (event.hook_event_name === 'PermissionDenied') console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionDenied', retry: true } }))
if (event.hook_event_name === 'FileChanged' && process.argv[3] === 'dynamic') {
  await writeFile(process.env.CLAUDE_ENV_FILE, 'export FILE_CHANGED_TOKEN=${markers.fileChanged}\\n')
  console.log(JSON.stringify({ systemMessage: 'file environment refreshed', hookSpecificOutput: { hookEventName: 'FileChanged', watchPaths: [${JSON.stringify(join(cwd, 'dynamic.env'))}] } }))
}
if (event.hook_event_name === 'SessionEnd') console.log('${markers.sessionEnd}')
`,
    ),
    writeFixture(
      join(configRoot, 'settings.json'),
      JSON.stringify({
        hooks: {
          ...Object.fromEntries(
            [
              'SessionStart',
              'UserPromptSubmit',
              'PreToolUse',
              'PostToolUse',
              'TaskCreated',
              'TaskCompleted',
              'PermissionDenied',
              'Stop',
              'SessionEnd',
            ].map((event) => [
              event,
              [
                {
                  ...([
                    'PreToolUse',
                    'PostToolUse',
                    'PermissionDenied',
                  ].includes(event)
                    ? { matcher: 'Bash' }
                    : {}),
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
          FileChanged: [
            {
              matcher: '.env',
              hooks: [
                {
                  type: 'command',
                  command: `node ${JSON.stringify(hookScript)} ${JSON.stringify(hookLog)}`,
                },
              ],
            },
            {
              hooks: [
                {
                  type: 'command',
                  command: `node ${JSON.stringify(hookScript)} ${JSON.stringify(hookLog)} dynamic`,
                },
              ],
            },
          ],
        },
        autoMode: {
          allow: [],
          soft_deny: [],
          hard_deny: [],
          environment: [],
          classifyAllShell: true,
        },
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

  const claudeEnvironment = await runClaudeJson(
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
      `Call Bash exactly once with command printenv HOOK_SESSION_ENV, then reply with the tool output and ${markers.environmentPrompt}.`,
    ],
    cwd,
    configRoot,
  )
  assertContains(
    String(claudeEnvironment.result),
    markers.environmentValue,
    'Claude CLAUDE_ENV_FILE injection',
  )

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

  const watched = await runClaudeJson(
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
      'Call Bash exactly once with command `printf one > .env; sleep 1; printf two > .env; sleep 1; rm .env; sleep 1; printf dynamic > dynamic.env; sleep 1`, then reply done.',
    ],
    cwd,
    configRoot,
  )
  const watchedEvents = parseEntries(await readFile(hookLog, 'utf8')).filter(
    (event) =>
      event.session_id === watched.session_id &&
      event.hook_event_name === 'FileChanged',
  )
  const watchedTransitions = watchedEvents.map((event) => ({
    file: basename(event.file_path),
    event: event.event,
  }))
  for (const expected of [
    { file: '.env', event: 'add' },
    { file: '.env', event: 'change' },
    { file: '.env', event: 'unlink' },
    { file: 'dynamic.env', event: 'add' },
  ]) {
    if (
      !watchedTransitions.some(
        (actual) =>
          actual.file === expected.file && actual.event === expected.event,
      )
    ) {
      throw new Error(
        `Claude FileChanged transition missing ${JSON.stringify(expected)}: ${JSON.stringify(watchedTransitions)}`,
      )
    }
  }
  if (
    watchedEvents.some(
      (event) =>
        typeof event.claude_env_file !== 'string' ||
        !event.claude_env_file.includes('filechanged-hook-'),
    )
  ) {
    throw new Error('Claude FileChanged omitted CLAUDE_ENV_FILE')
  }
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

  const { stdout: taskStdout } = await execFileAsync(
    process.execPath,
    [cli, 'run', '--json', markers.taskPrompt],
    {
      cwd,
      env: praxisEnvironment,
      maxBuffer: 4 * 1024 * 1024,
    },
  )
  const taskResult = parseEntries(taskStdout).find(
    (record) => record.type === 'result',
  )
  if (!taskResult?.sessionId) {
    throw new Error(`Praxis emitted no task hook result: ${taskStdout}`)
  }
  assertContains(String(taskResult.text), markers.taskDone, 'Praxis task hooks')
  const taskSessionFile = await findSessionFile(
    join(configRoot, 'projects'),
    taskResult.sessionId,
  )
  if (!taskSessionFile)
    throw new Error('Praxis task hook transcript is missing')
  const taskTranscript = await readFile(taskSessionFile, 'utf8')
  for (const marker of [markers.taskCreated, markers.taskCompleted]) {
    assertContains(taskTranscript, marker, 'Praxis task hook transcript')
  }
  const taskHookEvents = parseEntries(await readFile(hookLog, 'utf8')).filter(
    (event) => event.session_id === taskResult.sessionId,
  )
  if (
    taskHookEvents.filter((event) => event.hook_event_name === 'TaskCreated')
      .length !== 1 ||
    taskHookEvents.filter((event) => event.hook_event_name === 'TaskCompleted')
      .length !== 1
  ) {
    throw new Error(
      `Unexpected Praxis task hook lifecycle: ${taskHookEvents
        .map((event) => event.hook_event_name)
        .join(', ')}`,
    )
  }

  const { stdout: permissionStdout } = await execFileAsync(
    process.execPath,
    [
      cli,
      'run',
      '--json',
      '--permission-mode',
      'auto',
      markers.permissionPrompt,
    ],
    {
      cwd,
      env: praxisEnvironment,
      maxBuffer: 4 * 1024 * 1024,
    },
  )
  const permissionResult = parseEntries(permissionStdout).find(
    (record) => record.type === 'result',
  )
  if (!permissionResult?.sessionId) {
    throw new Error(
      `Praxis emitted no PermissionDenied result: ${permissionStdout}`,
    )
  }
  assertContains(
    String(permissionResult.text),
    markers.permissionDone,
    'Praxis PermissionDenied hook retry',
  )
  const permissionSessionFile = await findSessionFile(
    join(configRoot, 'projects'),
    permissionResult.sessionId,
  )
  if (!permissionSessionFile) {
    throw new Error('Praxis PermissionDenied transcript is missing')
  }
  const permissionTranscript = await readFile(permissionSessionFile, 'utf8')
  assertContains(
    permissionTranscript,
    markers.permissionRetry,
    'Praxis PermissionDenied retry transcript',
  )
  const permissionHookEvents = parseEntries(
    await readFile(hookLog, 'utf8'),
  ).filter((event) => event.session_id === permissionResult.sessionId)
  const permissionDenied = permissionHookEvents.filter(
    (event) => event.hook_event_name === 'PermissionDenied',
  )
  if (
    permissionDenied.length !== 1 ||
    permissionDenied[0]?.tool_name !== 'Bash' ||
    permissionDenied[0]?.reason !== 'compat classifier denied'
  ) {
    throw new Error(
      `Unexpected Praxis PermissionDenied lifecycle: ${JSON.stringify(permissionDenied)}`,
    )
  }

  const { stdout: environmentStdout } = await execFileAsync(
    process.execPath,
    [
      cli,
      'run',
      '--json',
      '--permission-mode',
      'bypassPermissions',
      markers.environmentPrompt,
    ],
    {
      cwd,
      env: praxisEnvironment,
      maxBuffer: 4 * 1024 * 1024,
    },
  )
  const environmentResult = parseEntries(environmentStdout).find(
    (record) => record.type === 'result',
  )
  if (!environmentResult?.sessionId) {
    throw new Error(
      `Praxis emitted no session env result: ${environmentStdout}`,
    )
  }
  assertContains(
    String(environmentResult.text),
    markers.environmentDone,
    'Praxis session hook environment',
  )
  const environmentHook = parseEntries(await readFile(hookLog, 'utf8')).find(
    (event) =>
      event.session_id === environmentResult.sessionId &&
      event.hook_event_name === 'SessionStart',
  )
  if (
    typeof environmentHook?.claude_env_file !== 'string' ||
    !environmentHook.claude_env_file.startsWith(
      join(configRoot, 'praxis', 'session-env', environmentResult.sessionId),
    )
  ) {
    throw new Error(
      `Praxis CLAUDE_ENV_FILE escaped its private sidecar: ${JSON.stringify(environmentHook)}`,
    )
  }

  const { stdout: praxisFileStdout } = await execFileAsync(
    process.execPath,
    [
      cli,
      'run',
      '--json',
      '--permission-mode',
      'bypassPermissions',
      markers.praxisFilePrompt,
    ],
    {
      cwd,
      env: praxisEnvironment,
      maxBuffer: 4 * 1024 * 1024,
    },
  )
  const praxisFileResult = parseEntries(praxisFileStdout).find(
    (record) => record.type === 'result',
  )
  if (!praxisFileResult?.sessionId) {
    throw new Error(`Praxis emitted no FileChanged result: ${praxisFileStdout}`)
  }
  assertContains(
    String(praxisFileResult.text),
    markers.praxisFileDone,
    'Praxis FileChanged lifecycle',
  )
  const praxisFileEvents = parseEntries(await readFile(hookLog, 'utf8')).filter(
    (event) =>
      event.session_id === praxisFileResult.sessionId &&
      event.hook_event_name === 'FileChanged',
  )
  const praxisTransitions = praxisFileEvents.map((event) => ({
    file: basename(event.file_path),
    event: event.event,
  }))
  for (const expected of [
    { file: '.env', event: 'add' },
    { file: '.env', event: 'change' },
    { file: '.env', event: 'unlink' },
    { file: 'dynamic.env', event: 'add' },
  ]) {
    if (
      !praxisTransitions.some(
        (actual) =>
          actual.file === expected.file && actual.event === expected.event,
      )
    ) {
      throw new Error(
        `Praxis FileChanged transition missing ${JSON.stringify(expected)}: ${JSON.stringify(praxisTransitions)}`,
      )
    }
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
  const reopenedTask = await runClaudeJson(
    [
      '-p',
      '--resume',
      taskResult.sessionId,
      '--model',
      'haiku',
      '--max-turns',
      '1',
      '--tools',
      '',
      '--output-format',
      'json',
      `Reply with ${markers.taskCreated}, ${markers.taskCompleted}, and ${markers.taskDone}.`,
    ],
    cwd,
    configRoot,
  )
  for (const marker of [
    markers.taskCreated,
    markers.taskCompleted,
    markers.taskDone,
  ]) {
    assertContains(
      String(reopenedTask.result),
      marker,
      'Claude task hook resume',
    )
  }
  const reopenedPermission = await runClaudeJson(
    [
      '-p',
      '--resume',
      permissionResult.sessionId,
      '--model',
      'haiku',
      '--max-turns',
      '1',
      '--tools',
      '',
      '--output-format',
      'json',
      `Reply with ${markers.permissionRetry} and ${markers.permissionDone}.`,
    ],
    cwd,
    configRoot,
  )
  for (const marker of [markers.permissionRetry, markers.permissionDone]) {
    assertContains(
      String(reopenedPermission.result),
      marker,
      'Claude PermissionDenied hook resume',
    )
  }

  console.log(
    `Claude ${version} hook compatibility passed: lifecycle order, stream records, stdin envelope, input rewrite, context attachments, task and PermissionDenied retry attachments, environment exports, watched-file transitions, exit-2 blocking, Praxis execution, and Claude resume`,
  )
} finally {
  if (server.listening) await closeServer()
  await rm(root, { recursive: true })
}
