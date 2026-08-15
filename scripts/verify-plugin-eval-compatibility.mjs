import { execFile, spawn, spawnSync } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout } from 'node:timers'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const claudeCli = process.env.PRAXIS_CLAUDE_BINARY ?? 'claude'
const root = await mkdtemp(join(tmpdir(), 'praxis-plugin-eval-'))
const installRoot = join(root, 'install')
const workspace = join(root, 'workspace')
const configRoot = join(root, 'config')
const ambientHome = join(root, 'ambient-home')
const requests = []
let praxisCli = ''
let interruptRequest
const interruptSeen = new Promise((resolve) => {
  interruptRequest = resolve
})

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function write(path, content) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

function sse(response, choices) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    `${choices
      .map((choice) => `data: ${JSON.stringify(choice)}\n\n`)
      .join('')}data: [DONE]\n\n`,
  )
}

function completion(content) {
  return {
    choices: [{ delta: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }
}

function toolCall(id, name, input) {
  return {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id,
              type: 'function',
              function: { name, arguments: JSON.stringify(input) },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }
}

const server = createServer(async (request, response) => {
  let source = ''
  request.setEncoding('utf8')
  for await (const chunk of request) source += chunk
  if (!source) {
    response.writeHead(404).end()
    return
  }
  const body = JSON.parse(source)
  const serialized = JSON.stringify(body)
  requests.push(body)
  if (serialized.includes('You are an eval judge.')) {
    sse(response, [
      completion('{"passed":true,"explanation":"fixture judge passed"}'),
    ])
    return
  }
  if (serialized.includes('SLOW_INTERRUPT')) {
    interruptRequest()
    request.once('close', () => response.destroy())
    return
  }
  const toolResults = body.messages.filter((message) => message.role === 'tool')
  if (toolResults.length === 0) {
    sse(response, [toolCall('call_skill_eval', 'Skill', { skill: 'fixture' })])
    return
  }
  if (toolResults.length === 1) {
    sse(response, [
      toolCall('call_read_eval', 'Read', { file_path: 'fixture.txt' }),
    ])
    return
  }
  if (toolResults.length === 2) {
    sse(response, [
      toolCall('call_bash_eval', 'Bash', {
        command: 'printf %s "$EVAL_MARKER"; printf %s "$AMBIENT_SECRET"',
      }),
    ])
    return
  }
  assert(
    serialized.includes('ISOLATED_ENV'),
    `case EVAL_ environment missing: ${JSON.stringify(toolResults.at(-1))}`,
  )
  assert(
    !serialized.includes('SECRET_VALUE'),
    'ambient secret reached eval tool',
  )
  assert(!serialized.includes(ambientHome), 'ambient HOME reached eval runtime')
  const arm = serialized.includes('PLUGIN_SKILL_MARKER')
    ? 'WITH_PLUGIN_ARM'
    : 'WITHOUT_PLUGIN_ARM'
  sse(response, [completion(`${arm} EVAL_FINISHED`)])
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
    server.closeAllConnections()
  })
}

async function run(args, options = {}) {
  return execFileAsync(process.execPath, [praxisCli, ...args], {
    cwd: workspace,
    env: environment,
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  })
}

async function failure(args, marker, expectedCode = 1) {
  try {
    await run(args)
  } catch (error) {
    const output = `${String(error.stdout ?? '')}${String(error.stderr ?? '')}`
    assert(
      error.code === expectedCode,
      `unexpected exit ${error.code}: ${output}`,
    )
    assert(output.includes(marker), `missing ${marker}: ${output}`)
    return error
  }
  throw new Error(`expected failure: ${args.join(' ')}`)
}

async function filesBelow(path) {
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = join(path, entry.name)
      return entry.isDirectory() ? filesBelow(target) : [target]
    }),
  )
  return nested.flat()
}

await listen()
const address = server.address()
if (!address || typeof address === 'string')
  throw new Error('no server address')
const environment = {
  ...process.env,
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_CONFIG_DIR: configRoot,
  HOME: ambientHome,
  PRAXIS_PROVIDER: 'openai',
  PRAXIS_API_KEY: 'fixture-key',
  PRAXIS_MODEL: 'fixture-model',
  PRAXIS_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
  PRAXIS_PRICING_JSON: JSON.stringify({
    'fixture-model': { inputPerMillionUsd: 1, outputPerMillionUsd: 1 },
    haiku: { inputPerMillionUsd: 1, outputPerMillionUsd: 1 },
  }),
  AMBIENT_SECRET: 'SECRET_VALUE',
}

try {
  await Promise.all([
    mkdir(installRoot, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(configRoot, { recursive: true }),
    mkdir(ambientHome, { recursive: true }),
  ])
  const packed = JSON.parse(
    (
      await execFileAsync(
        'npm',
        ['pack', '--json', '--pack-destination', root],
        {
          cwd: repositoryRoot,
          timeout: 120_000,
        },
      )
    ).stdout,
  )
  const filename = packed[0]?.filename
  assert(typeof filename === 'string', 'npm pack returned no artifact')
  await execFileAsync(
    'npm',
    [
      'install',
      '--prefix',
      installRoot,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      join(root, filename),
    ],
    { timeout: 120_000 },
  )
  praxisCli = join(
    installRoot,
    'node_modules',
    'praxis-agent',
    'dist',
    'cli.js',
  )

  const help = await run(['plugin', 'eval', '--help'])
  for (const option of [
    '--ablation',
    '--allow-tools',
    '--case',
    '--judge-model',
    '--keep-temp',
    '--max-cost-usd',
    '--no-scaffold',
    '--output-dir',
    '--runs',
    '--scaffold',
    '--tag',
    '--threshold',
  ])
    assert(help.stdout.includes(option), `Praxis help missing ${option}`)
  const initHelp = await run(['plugin', 'eval', 'init', '--help'])
  assert(initHelp.stdout.includes('--bare'), 'init help missing --bare')
  assert(
    !initHelp.stdout.includes('--interactive'),
    'init leaked private option',
  )

  const claudeVersion = spawnSync(claudeCli, ['--version'], {
    encoding: 'utf8',
    env: environment,
  })
  if (!claudeVersion.error) {
    assert(
      claudeVersion.stdout.startsWith('2.1.208 '),
      `Unsupported Claude version: ${claudeVersion.stdout}`,
    )
    const claudeHelp = spawnSync(claudeCli, ['plugin', 'eval', '--help'], {
      encoding: 'utf8',
      env: environment,
    })
    assert(claudeHelp.status === 0, 'Claude plugin eval help failed')
    assert(
      claudeHelp.stdout.includes('--ablation'),
      'Claude help surface changed',
    )
  }

  const plugin = join(workspace, 'fixture-plugin')
  await write(
    join(plugin, '.claude-plugin', 'plugin.json'),
    JSON.stringify({
      name: 'fixture-plugin',
      version: '1.0.0',
      description: 'eval fixture',
      author: { name: 'Fixture' },
    }),
  )
  await write(
    join(plugin, 'skills', 'fixture', 'SKILL.md'),
    '---\nname: fixture\ndescription: Fixture eval skill\n---\nPLUGIN_SKILL_MARKER\n',
  )
  const lifecycle = join(plugin, 'evals', 'lifecycle')
  await write(
    join(lifecycle, 'case.yaml'),
    `schema_version: "1.0"\nname: lifecycle\nruns: 1\ncontext:\n  scaffold_script: setup.sh\nexecution:\n  prompt: EXECUTE_CASE\n  allowed_tools: [Skill, Read, Bash]\n  env:\n    EVAL_MARKER: ISOLATED_ENV\ngraders:\n  - type: regex\n    name: final\n    pattern: EVAL_FINISHED\n  - type: regex\n    name: plugin-arm\n    arm: with-only\n    pattern: WITH_PLUGIN_ARM\n  - type: tool_order\n    name: order\n    before: Read\n    after: Bash\n  - type: llm\n    name: quality\n    criteria: Candidate completed fixture eval\n`,
  )
  await write(
    join(lifecycle, 'setup.sh'),
    '#!/bin/bash\ntest "$(cd "$HOME" && pwd -P)" = "$(cd "$(dirname "$PWD")/home" && pwd -P)" || exit 8\nprintf fixture > fixture.txt\n',
  )
  const failing = join(plugin, 'evals', 'failing')
  await write(
    join(failing, 'case.yaml'),
    `schema_version: "1.0"\nname: failing\ncontext:\n  scaffold_script: fail.sh\nexecution:\n  prompt: EXECUTE_CASE\ngraders:\n  - type: regex\n    name: never\n    pattern: impossible\n`,
  )
  await write(
    join(failing, 'fail.sh'),
    '#!/bin/bash\necho SCAFFOLD_FAILED >&2\nexit 9\n',
  )
  const timeout = join(plugin, 'evals', 'timeout')
  await write(
    join(timeout, 'case.yaml'),
    `schema_version: "1.0"\nname: timeout\ncontext:\n  scaffold_script: slow.sh\nexecution:\n  prompt: EXECUTE_CASE\n  timeout_seconds: 1\ngraders:\n  - type: regex\n    name: never\n    pattern: impossible\n`,
  )
  await write(join(timeout, 'slow.sh'), '#!/bin/bash\nsleep 5\n')
  const threshold = join(plugin, 'evals', 'threshold')
  await write(
    join(threshold, 'case.yaml'),
    `schema_version: "1.0"\nname: threshold\nexecution:\n  prompt: EXECUTE_CASE\n  allowed_tools: [Skill, Read, Bash]\n  env:\n    EVAL_MARKER: ISOLATED_ENV\ngraders:\n  - type: regex\n    name: impossible\n    pattern: NEVER_MATCH\n`,
  )
  const slow = join(plugin, 'evals', 'slow')
  await write(
    join(slow, 'case.yaml'),
    `schema_version: "1.0"\nname: slow\nexecution:\n  prompt: SLOW_INTERRUPT\ngraders:\n  - type: regex\n    name: never\n    pattern: impossible\n`,
  )
  const history = join(plugin, 'evals', 'history')
  await write(
    join(history, 'case.yaml'),
    `schema_version: "1.0"\nname: history\ncontext:\n  history_file: history.jsonl\nexecution:\n  allowed_tools: [Skill, Read, Bash]\n  env:\n    EVAL_MARKER: ISOLATED_ENV\ngraders:\n  - type: regex\n    name: final\n    pattern: EVAL_FINISHED\n`,
  )
  await write(
    join(history, 'history.jsonl'),
    `${JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      promptId: '44444444-4444-4444-8444-444444444444',
      type: 'user',
      message: { role: 'user', content: 'HISTORY_MARKER' },
      uuid: '22222222-2222-4222-8222-222222222222',
      timestamp: '2026-08-03T08:00:00.000Z',
      permissionMode: 'default',
      promptSource: 'sdk',
      userType: 'external',
      entrypoint: 'sdk-cli',
      cwd: workspace,
      sessionId: '11111111-1111-4111-8111-111111111111',
      version: '2.1.208',
      gitBranch: 'HEAD',
    })}\n${JSON.stringify({
      parentUuid: '22222222-2222-4222-8222-222222222222',
      isSidechain: false,
      message: {
        id: 'msg_history_fixture',
        type: 'message',
        role: 'assistant',
        model: 'fixture-model',
        content: [{ type: 'text', text: 'history ready' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      type: 'assistant',
      uuid: '33333333-3333-4333-8333-333333333333',
      timestamp: '2026-08-03T08:00:01.000Z',
      userType: 'external',
      entrypoint: 'sdk-cli',
      cwd: workspace,
      sessionId: '11111111-1111-4111-8111-111111111111',
      version: '2.1.208',
      gitBranch: 'HEAD',
    })}\n`,
  )

  const outputDir = join(workspace, 'results-main')
  const lifecycleRun = await run([
    'plugin',
    'eval',
    '--json',
    '--ablation',
    'with-without',
    '--case',
    'lifecycle',
    '--runs',
    '1',
    '--scaffold',
    '--allow-tools',
    'Bash',
    '--output-dir',
    outputDir,
    plugin,
  ])
  const aggregate = JSON.parse(lifecycleRun.stdout)
  const saved = JSON.parse(
    await readFile(join(outputDir, 'aggregate-result.json'), 'utf8'),
  )
  assert(
    JSON.stringify(aggregate) === JSON.stringify(saved),
    'stdout/file aggregate mismatch',
  )
  assert(aggregate.partial === false, 'complete lifecycle marked partial')
  assert(aggregate.cases[0].score === 1, 'with-plugin score failed')
  assert(aggregate.cases[0].score_without === 1, 'without-plugin score failed')
  assert(aggregate.cases[0].delta === 0, 'ablation delta missing')
  assert(aggregate.cases[0].runs[0].judge_cost_usd > 0, 'judge cost missing')
  const trace = await readFile(aggregate.cases[0].runs[0].trace_path, 'utf8')
  assert(
    trace.indexOf('"tool":"Read"') < trace.indexOf('"tool":"Bash"'),
    'trace ordering failed',
  )
  const agentRequests = requests.filter(
    (body) => !JSON.stringify(body).includes('You are an eval judge.'),
  )
  assert(
    agentRequests.some((body) =>
      JSON.stringify(body).includes('PLUGIN_SKILL_MARKER'),
    ),
    'plugin skill missing from provider payload',
  )
  assert(
    agentRequests.some(
      (body) => !JSON.stringify(body).includes('PLUGIN_SKILL_MARKER'),
    ),
    'without-plugin provider arm missing',
  )
  const leakedSessions = (await filesBelow(configRoot)).filter((path) =>
    path.endsWith('.jsonl'),
  )
  assert(leakedSessions.length === 0, 'ephemeral eval leaked a durable session')

  const historyStart = requests.length
  await run([
    'plugin',
    'eval',
    '--json',
    '--case',
    'history',
    '--runs',
    '1',
    plugin,
    '--allow-tools',
    'Bash',
  ])
  assert(
    requests
      .slice(historyStart)
      .some((body) => JSON.stringify(body).includes('HISTORY_MARKER')),
    'history_file did not enter provider context',
  )

  await failure(
    [
      'plugin',
      'eval',
      '--case',
      'threshold',
      '--runs',
      '1',
      plugin,
      '--allow-tools',
      'Bash',
    ],
    'Evaluated 1 case(s)',
  )
  const budget = await failure(
    [
      'plugin',
      'eval',
      '--json',
      '--case',
      'lifecycle',
      '--max-cost-usd',
      '0',
      plugin,
    ],
    '"partial_reason":"cost_ceiling"',
    2,
  )
  assert(
    JSON.parse(budget.stdout).cases[0].runs.length === 0,
    'cost partial ran provider',
  )
  await failure(
    [
      'plugin',
      'eval',
      '--case',
      'failing',
      '--runs',
      '1',
      '--scaffold',
      plugin,
    ],
    'Evaluated 1 case(s)',
  )
  const timeoutStarted = Date.now()
  await failure(
    [
      'plugin',
      'eval',
      '--case',
      'timeout',
      '--runs',
      '1',
      '--scaffold',
      plugin,
    ],
    'Evaluated 1 case(s)',
  )
  assert(
    Date.now() - timeoutStarted < 4_000,
    'scaffold timeout was not bounded',
  )

  const keep = await run([
    'plugin',
    'eval',
    '--json',
    '--case',
    'lifecycle',
    '--runs',
    '1',
    '--scaffold',
    '--allow-tools',
    'Bash',
    '--keep-temp',
    plugin,
  ])
  const retained = JSON.parse(keep.stdout).cases[0].runs[0].temp_root
  assert(typeof retained === 'string', 'keep-temp path missing')
  await stat(retained)
  await rm(retained, { recursive: true, force: true })

  const initRoot = join(workspace, 'init-fixture')
  await mkdir(initRoot)
  await run(['plugin', 'eval', 'init', '--bare', 'starter'], { cwd: initRoot })
  await stat(join(initRoot, 'evals', 'starter', 'prompt.md'))
  await write(
    join(plugin, 'evals', 'escape', 'case.yaml'),
    `schema_version: "1.0"\nname: ../../escape\nexecution:\n  prompt: x\ngraders:\n  - type: regex\n    name: ok\n    pattern: x\n`,
  )
  await failure(
    ['plugin', 'eval', '--case', 'escape', plugin],
    'safe eval identifier',
  )
  await rm(join(plugin, 'evals', 'escape'), { recursive: true, force: true })

  const child = spawn(
    process.execPath,
    [praxisCli, 'plugin', 'eval', '--json', '--case', 'slow', plugin],
    {
      cwd: workspace,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let childOutput = ''
  child.stdout.on('data', (chunk) => (childOutput += chunk))
  child.stderr.on('data', (chunk) => (childOutput += chunk))
  const childExit = new Promise((resolve) => child.once('exit', resolve))
  await Promise.race([
    interruptSeen,
    childExit.then((code) => {
      throw new Error(`interrupt child exited early ${code}: ${childOutput}`)
    }),
  ])
  child.kill('SIGINT')
  const interruptCode = await Promise.race([
    childExit,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`interrupt child did not exit: ${childOutput}`)),
        5_000,
      ),
    ),
  ])
  assert(
    interruptCode === 130,
    `interrupt exit ${interruptCode}: ${childOutput}`,
  )

  process.stdout.write('plugin eval packed lifecycle verified\n')
} finally {
  await closeServer()
  await rm(root, { recursive: true, force: true })
}
