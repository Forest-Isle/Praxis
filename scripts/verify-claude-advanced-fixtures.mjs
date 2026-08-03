import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { resolveClaudePaths } from '../dist/compatibility/claude/paths.js'
import {
  parseClaudeVersionOutput,
  selectClaudeSchemaAdapter,
} from '../dist/compatibility/claude/schema.js'
import { ClaudeTranscriptStore } from '../dist/persistence/claude-transcript-store.js'

const execFileAsync = promisify(execFile)
const fixtureDirectory = fileURLToPath(
  new URL('../test/fixtures/claude-code/2.1.208/', import.meta.url),
)

async function write(path, content) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

async function rewriteFixture(name, sessionId, cwd, mutate = (entry) => entry) {
  const source = await readFile(join(fixtureDirectory, name), 'utf8')
  return `${source
    .trimEnd()
    .split('\n')
    .map((line) => {
      const entry = mutate(JSON.parse(line))
      if ('sessionId' in entry) entry.sessionId = sessionId
      if ('cwd' in entry) entry.cwd = cwd
      return JSON.stringify(entry)
    })
    .join('\n')}\n`
}

async function installFixture(
  configRoot,
  probeRoot,
  label,
  fixtureName,
  mutate,
) {
  const workDirectory = join(probeRoot, 'work', label)
  await mkdir(workDirectory, { recursive: true })
  const cwd = await realpath(workDirectory)
  const sessionId = randomUUID()
  const paths = resolveClaudePaths({ configDir: configRoot, cwd, sessionId })
  await write(
    paths.sessionFile,
    await rewriteFixture(fixtureName, sessionId, cwd, mutate),
  )
  return { cwd, sessionId, paths }
}

async function resume(configRoot, fixture, prompt) {
  const { stdout } = await execFileAsync(
    'claude',
    [
      '-p',
      '--resume',
      fixture.sessionId,
      '--model',
      'haiku',
      '--max-turns',
      '1',
      '--tools',
      '',
      '--output-format',
      'json',
      prompt,
    ],
    {
      cwd: fixture.cwd,
      env: { ...process.env, CLAUDE_CONFIG_DIR: configRoot },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
    },
  )
  const response = JSON.parse(stdout)
  if (
    response.type !== 'result' ||
    response.is_error ||
    response.session_id !== fixture.sessionId
  ) {
    throw new Error(`Claude failed to resume advanced fixture: ${stdout}`)
  }
  return String(response.result)
}

function assertContains(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    throw new Error(`${label} did not expose marker ${needle}`)
  }
}

const probeRoot = await mkdtemp(join(tmpdir(), 'praxis-claude-advanced-'))

try {
  const { stdout: versionOutput } = await execFileAsync('claude', ['--version'])
  const version = parseClaudeVersionOutput(versionOutput)
  const schema = selectClaudeSchemaAdapter(version)
  if (version !== '2.1.208' || schema.writeMode !== 'read-write') {
    throw new Error(`Advanced fixture probe does not support Claude ${version}`)
  }

  const configRoot = join(probeRoot, 'config')
  const compact = await installFixture(
    configRoot,
    probeRoot,
    'compact',
    'compact-session.jsonl',
  )
  assertContains(
    await resume(
      configRoot,
      compact,
      'Reply with exactly the marker from the prior compact summary.',
    ),
    'COMPACT_FIXTURE',
    'Claude compact resume',
  )

  const mediaError = await installFixture(
    configRoot,
    probeRoot,
    'media-error',
    'media-error-session.jsonl',
  )
  const mediaStore = new ClaudeTranscriptStore({
    sessionFile: mediaError.paths.sessionFile,
    lockFile: join(probeRoot, 'locks', 'media-error.lock'),
    schema,
  })
  const mediaEntries = (await mediaStore.load()).entries
  const failedToolResult = mediaEntries
    .flatMap((entry) => {
      if (typeof entry.message !== 'object' || entry.message === null) return []
      const content = entry.message.content
      return Array.isArray(content) ? content : []
    })
    .find(
      (block) =>
        typeof block === 'object' &&
        block !== null &&
        block.type === 'tool_result' &&
        block.is_error === true,
    )
  if (
    !failedToolResult ||
    typeof failedToolResult.content !== 'string' ||
    !failedToolResult.content.includes('Exit code 7') ||
    !failedToolResult.content.includes('fixture-error')
  ) {
    throw new Error('Non-zero tool error fixture lost native error semantics')
  }
  const mediaResult = await resume(
    configRoot,
    mediaError,
    'State the prior failed tool exit code and error marker.',
  )
  assertContains(mediaResult, '7', 'Claude non-zero tool error resume')
  assertContains(
    mediaResult,
    'fixture-error',
    'Claude non-zero tool error resume',
  )

  const interrupted = await installFixture(
    configRoot,
    probeRoot,
    'interrupted',
    'interrupted-session.jsonl',
  )
  const interruptedStore = new ClaudeTranscriptStore({
    sessionFile: interrupted.paths.sessionFile,
    lockFile: join(probeRoot, 'locks', 'interrupted.lock'),
    schema,
  })
  const interruptedEntries = (await interruptedStore.load()).entries
  const rejectedTool = interruptedEntries.find(
    (entry) => entry.toolDenialKind === 'user-rejected',
  )
  if (
    rejectedTool?.toolUseResult !== 'User rejected tool use' ||
    !JSON.stringify(interruptedEntries).includes(
      '[Request interrupted by user for tool use]',
    )
  ) {
    throw new Error('Interruption fixture lost native rejection semantics')
  }
  assertContains(
    await resume(
      configRoot,
      interrupted,
      'Reply with exactly INTERRUPTED_RESUME_OK.',
    ),
    'INTERRUPTED_RESUME_OK',
    'Claude interruption resume',
  )

  const sidechain = await installFixture(
    configRoot,
    probeRoot,
    'sidechain',
    'sidechain-layout/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl',
  )
  const sidechainFile = join(
    sidechain.paths.projectRoot,
    sidechain.sessionId,
    'subagents',
    'agent-fixture.jsonl',
  )
  await write(
    sidechainFile,
    await rewriteFixture(
      'sidechain-layout/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/subagents/agent-fixture.jsonl',
      sidechain.sessionId,
      sidechain.cwd,
    ),
  )
  const sidechainStore = new ClaudeTranscriptStore({
    sessionFile: sidechainFile,
    lockFile: join(probeRoot, 'locks', 'sidechain.lock'),
    schema,
  })
  const sidechainEntries = (await sidechainStore.load()).entries
  if (
    sidechainEntries.length !== 2 ||
    sidechainEntries.some(
      (entry) =>
        entry.isSidechain !== true || entry.agentId !== 'agent-fixture',
    )
  ) {
    throw new Error('Claude sidechain fixture does not match subagent layout')
  }
  assertContains(
    await resume(
      configRoot,
      sidechain,
      'Reply with exactly MAIN_SIDECHAIN_FIXTURE.',
    ),
    'MAIN_SIDECHAIN_FIXTURE',
    'Claude main session resume with sidechain layout',
  )

  const generatedSidechainDirectory = join(
    probeRoot,
    'work',
    'generated-sidechain',
  )
  await mkdir(generatedSidechainDirectory, { recursive: true })
  const generatedSidechainCwd = await realpath(generatedSidechainDirectory)
  const { stdout: generatedSidechainStdout } = await execFileAsync(
    'claude',
    [
      '-p',
      '--model',
      'haiku',
      '--max-turns',
      '3',
      '--output-format',
      'json',
      '--allowedTools',
      'Agent',
      '--dangerously-skip-permissions',
      'Use the Agent tool exactly once with subagent_type general-purpose. Ask it to reply with exactly GENERATED_SIDECHAIN_FIXTURE, then report that same marker.',
    ],
    {
      cwd: generatedSidechainCwd,
      env: { ...process.env, CLAUDE_CONFIG_DIR: configRoot },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
    },
  )
  const generatedResponse = JSON.parse(generatedSidechainStdout)
  if (
    generatedResponse.type !== 'result' ||
    generatedResponse.is_error ||
    typeof generatedResponse.session_id !== 'string'
  ) {
    throw new Error('Claude failed to generate a sidechain fixture')
  }
  const generatedPaths = resolveClaudePaths({
    configDir: configRoot,
    cwd: generatedSidechainCwd,
    sessionId: generatedResponse.session_id,
  })
  const generatedSubagentDirectory = join(
    generatedPaths.projectRoot,
    generatedResponse.session_id,
    'subagents',
  )
  const generatedSubagentFiles = (await readdir(generatedSubagentDirectory))
    .filter((name) => name.startsWith('agent-') && name.endsWith('.jsonl'))
    .map((name) => join(generatedSubagentDirectory, name))
  if (generatedSubagentFiles.length === 0) {
    throw new Error('Claude did not generate native subagent JSONL layout')
  }
  const generatedSidechainSources = await Promise.all(
    generatedSubagentFiles.map((path) => readFile(path, 'utf8')),
  )
  assertContains(
    generatedSidechainSources.join('\n'),
    'GENERATED_SIDECHAIN_FIXTURE',
    'Claude-generated sidechain',
  )

  console.log(
    `Claude ${version} advanced fixtures passed: compaction, media/error, interruption, captured sidechain layout, and Claude-generated sidechain`,
  )
} finally {
  await rm(probeRoot, { recursive: true })
}
