import { readFile, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp } from 'node:fs/promises'

import { loadClaudeContextResources } from '../dist/compatibility/claude/shared-resources.js'
import {
  detectClaudeVersion,
  execFileAsync,
  writeFixture,
} from './lib/claude-probe.mjs'

const contract = JSON.parse(
  await readFile(
    fileURLToPath(
      new URL(
        '../test/fixtures/claude-code/2.1.208/memory-import-contract.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
)
const root = await mkdtemp(join(tmpdir(), 'praxis-memory-import-compat-'))
const configRoot = join(root, 'config')
const cwd = join(root, 'project')
const requests = []

function assert(value, message) {
  if (!value) throw new Error(message)
}

function count(source, marker) {
  return source.split(marker).length - 1
}

function assertContract(source, label) {
  let previous = -1
  for (const marker of contract.orderedMarkers) {
    const index = source.indexOf(marker)
    assert(index > previous, `${label} lost ordered marker ${marker}`)
    assert(count(source, marker) === 1, `${label} duplicated marker ${marker}`)
    previous = index
  }
  for (const marker of contract.excludedMarkers) {
    assert(
      !source.includes(marker),
      `${label} exposed excluded marker ${marker}`,
    )
  }
}

function responseEvents(model) {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_memory_import_fixture',
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
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'MEMORY_IMPORT_OK' },
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

const server = createServer(async (request, response) => {
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
  const capturedRequest = JSON.parse(source)
  requests.push(capturedRequest)
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    responseEvents(capturedRequest.model)
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(''),
  )
})

await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})

try {
  const version = await detectClaudeVersion('Memory import probe')
  assert(version === contract.version, `Unexpected contract version ${version}`)
  await Promise.all([
    writeFixture(
      join(configRoot, 'CLAUDE.md'),
      [
        'USER_ROOT_108 inline @inline.md after',
        '@direct.md',
        '@reload.md',
        '@escaped\\ space.md',
        '@raw space.md',
        '@"quoted space.md"',
        '@<angle space.md>',
        '@missing.md',
        '@direct.md',
        '`@inline-code.md`',
        '    @indented.md',
        '```md',
        '@fenced.md',
        '```',
        '@cycle-a.md',
      ].join('\n'),
    ),
    writeFixture(join(configRoot, 'inline.md'), 'USER_INLINE_108'),
    writeFixture(
      join(configRoot, 'direct.md'),
      'USER_DIRECT_108\n@recursive.md',
    ),
    writeFixture(join(configRoot, 'recursive.md'), 'USER_RECURSIVE_108'),
    writeFixture(join(configRoot, 'reload.md'), 'RELOAD_BEFORE_108'),
    writeFixture(join(configRoot, 'escaped space.md'), 'USER_SPACE_108'),
    writeFixture(join(configRoot, 'raw space.md'), 'RAW_SPACE_108'),
    writeFixture(join(configRoot, 'quoted space.md'), 'QUOTED_SPACE_108'),
    writeFixture(join(configRoot, 'angle space.md'), 'ANGLE_SPACE_108'),
    writeFixture(join(configRoot, 'inline-code.md'), 'INLINE_CODE_108'),
    writeFixture(join(configRoot, 'indented.md'), 'INDENTED_CODE_108'),
    writeFixture(join(configRoot, 'fenced.md'), 'FENCED_CODE_108'),
    writeFixture(join(configRoot, 'cycle-a.md'), 'CYCLE_A_108\n@cycle-b.md'),
    writeFixture(join(configRoot, 'cycle-b.md'), 'CYCLE_B_108\n@cycle-a.md'),
    writeFixture(
      join(cwd, 'CLAUDE.md'),
      'PROJECT_ROOT_108 inline @project-inline.md\n@depth-1.md',
    ),
    writeFixture(join(cwd, 'project-inline.md'), 'PROJECT_INLINE_108'),
    ...Array.from({ length: 5 }, (_, index) =>
      writeFixture(
        join(cwd, `depth-${index + 1}.md`),
        `DEPTH_${index + 1}_108${index < 4 ? `\n@depth-${index + 2}.md` : ''}`,
      ),
    ),
  ])
  const canonicalCwd = await realpath(cwd)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  const claudeEnvironment = {
    ...process.env,
    CLAUDE_CONFIG_DIR: configRoot,
    ANTHROPIC_API_KEY: 'fixture-key',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
  }
  const claude = await execFileAsync(
    process.env.PRAXIS_CLAUDE_BINARY ?? 'claude',
    ['-p', '--output-format', 'json', '--tools=', 'MEMORY_IMPORT_PROBE'],
    {
      cwd: canonicalCwd,
      env: claudeEnvironment,
      timeout: 30_000,
    },
  )
  const claudeResult = JSON.parse(claude.stdout)
  assert(
    claudeResult.result === 'MEMORY_IMPORT_OK',
    'Claude memory import probe did not complete',
  )
  assert(requests[0], 'Claude memory import probe captured no request')
  assertContract(JSON.stringify(requests[0]), 'Claude 2.1.208 request')
  assert(
    JSON.stringify(requests[0]).includes('RELOAD_BEFORE_108'),
    'Claude initial request lost imported reload marker',
  )

  const reloadPath = join(configRoot, 'reload.md')
  await writeFixture(reloadPath, 'RELOAD_AFTER_108')
  const claudeResume = await execFileAsync(
    process.env.PRAXIS_CLAUDE_BINARY ?? 'claude',
    [
      '-p',
      '--resume',
      claudeResult.session_id,
      '--output-format',
      'json',
      '--tools=',
      'MEMORY_IMPORT_RESUME',
    ],
    { cwd: canonicalCwd, env: claudeEnvironment, timeout: 30_000 },
  )
  assert(
    JSON.parse(claudeResume.stdout).result === 'MEMORY_IMPORT_OK',
    'Claude memory import resume did not complete',
  )
  assert(
    JSON.stringify(requests[1]).includes('RELOAD_AFTER_108') &&
      !JSON.stringify(requests[1]).includes('RELOAD_BEFORE_108'),
    'Claude next request did not reload the edited import',
  )

  await writeFixture(reloadPath, 'RELOAD_BEFORE_108')
  const praxisEnvironment = {
    ...process.env,
    ...(process.env.PRAXIS_CLAUDE_BINARY
      ? {
          PATH: `${dirname(process.env.PRAXIS_CLAUDE_BINARY)}${delimiter}${
            process.env.PATH ?? ''
          }`,
        }
      : {}),
    CLAUDE_CONFIG_DIR: configRoot,
    PRAXIS_PROVIDER: 'anthropic',
    PRAXIS_API_KEY: 'fixture-key',
    PRAXIS_MODEL: 'claude-sonnet-4-5-20250929',
    PRAXIS_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    PRAXIS_MAX_OUTPUT_TOKENS: '4096',
  }
  const praxisCli = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
  const praxisRun = await execFileAsync(
    process.execPath,
    [
      praxisCli,
      '-p',
      '--output-format',
      'json',
      '--tools=',
      'PRAXIS_MEMORY_IMPORT_PROBE',
    ],
    { cwd: canonicalCwd, env: praxisEnvironment, timeout: 30_000 },
  )
  const praxisResult = JSON.parse(praxisRun.stdout)
  assert(
    praxisResult.result === 'MEMORY_IMPORT_OK',
    'Praxis memory import probe did not complete',
  )
  assertContract(JSON.stringify(requests[2]), 'Praxis initial provider request')
  await writeFixture(reloadPath, 'RELOAD_AFTER_108')
  const praxisResume = await execFileAsync(
    process.execPath,
    [
      praxisCli,
      '-p',
      '--resume',
      praxisResult.session_id,
      '--output-format',
      'json',
      '--tools=',
      'PRAXIS_MEMORY_IMPORT_RESUME',
    ],
    { cwd: canonicalCwd, env: praxisEnvironment, timeout: 30_000 },
  )
  assert(
    JSON.parse(praxisResume.stdout).result === 'MEMORY_IMPORT_OK',
    'Praxis memory import resume did not complete',
  )
  assert(
    JSON.stringify(requests[3]).includes('RELOAD_AFTER_108') &&
      !JSON.stringify(requests[3]).includes('RELOAD_BEFORE_108'),
    'Praxis next provider request did not reload the edited import',
  )

  const praxis = await loadClaudeContextResources({
    configRoot,
    cwd: canonicalCwd,
    homeDirectory: root,
  })
  assert(
    praxis.instructions
      .map(({ content }) => content)
      .join('\n')
      .includes('RELOAD_AFTER_108'),
    'Praxis resolver lost the edited import',
  )
  await writeFixture(reloadPath, 'RELOAD_BEFORE_108')
  const initialPraxisContext = await loadClaudeContextResources({
    configRoot,
    cwd: canonicalCwd,
    homeDirectory: root,
  })
  assertContract(
    initialPraxisContext.instructions.map(({ content }) => content).join('\n'),
    'Praxis shared context',
  )
  console.log(
    'Memory import compatibility passed: pinned Claude/Praxis inline, recursive, escaped-space, dedupe/cycle, code, missing, depth, and next-turn reload boundaries match',
  )
} finally {
  await new Promise((resolve) => server.close(resolve))
  await rm(root, { recursive: true, force: true })
}
