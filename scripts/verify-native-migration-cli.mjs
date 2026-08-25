import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = await mkdtemp(join(tmpdir(), 'praxis-native-migration-cli-'))
const nativeRoot = join(root, 'native')
const claudeRoot = join(root, 'claude-sentinel')
const cwdPath = join(root, 'project')
let cwd
const cli = new URL('../dist/cli.js', import.meta.url)
const sessionIds = [randomUUID(), randomUUID()]
const originalBytes = new Map()

function runCli(args) {
  const result = spawnSync(process.execPath, [cli.pathname, ...args], {
    cwd,
    env: {
      ...process.env,
      PRAXIS_HOME: nativeRoot,
      PRAXIS_DATA_PLANE: 'native',
      CLAUDE_CONFIG_DIR: claudeRoot,
      ANTHROPIC_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
    },
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(`CLI failed (${result.status}): ${result.stderr.trim()}`)
  if (result.stderr.trim())
    throw new Error(`unexpected CLI stderr: ${result.stderr.trim()}`)
  return result.stdout
}

function parseJson(output) {
  try {
    const value = JSON.parse(output)
    if (!value || !Array.isArray(value.migrations))
      throw new Error('missing migrations')
    return value.migrations
  } catch (error) {
    throw new Error(
      `invalid CLI JSON output: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

try {
  await mkdir(cwdPath, { recursive: true })
  cwd = await realpath(cwdPath)
  await mkdir(claudeRoot, { recursive: true })
  await writeFile(join(claudeRoot, 'sentinel'), 'untouched\n')
  const [
    { NativeDataPlaneAdapter },
    { createClaudeTranscriptCodec },
    { readNativeTranscript },
  ] = await Promise.all([
    import('../dist/persistence/native-data-plane-adapter.js'),
    import('../dist/compatibility/claude/transcript-codec.js'),
    import('../dist/persistence/native-transcript-reader.js'),
  ])
  const adapter = new NativeDataPlaneAdapter()
  const codec = createClaudeTranscriptCodec({
    version: '2.1.0',
    cwd,
    entrypoint: 'cli-smoke',
  })
  for (const sessionId of sessionIds) {
    const path = adapter.resolvePaths({
      root: nativeRoot,
      cwd,
      sessionId,
    }).sessionFile
    await mkdir(dirname(path), { recursive: true })
    const event = {
      kind: 'messages',
      id: randomUUID(),
      parentId: null,
      sessionId,
      timestamp: '2026-01-01T00:00:00.000Z',
      messages: [{ role: 'user', content: `migration smoke ${sessionId}` }],
    }
    const encoded = codec.encodeLine(event)
    if (!encoded.ok)
      throw new Error(`fixture encoding failed: ${encoded.issue.message}`)
    const bytes = Buffer.from(`${encoded.line}\n`)
    await writeFile(path, bytes)
    originalBytes.set(path, bytes)
  }
  const dryRun = parseJson(
    runCli(['migrate', 'native-transcript', '--all', '--dry-run', '--json']),
  )
  for (const sessionId of sessionIds) {
    const item = dryRun.find((migration) => migration.sessionId === sessionId)
    if (!item || item.status !== 'convertible')
      throw new Error(`dry-run did not report convertible: ${sessionId}`)
  }
  const filesAfterDryRun = await readdir(
    join(
      nativeRoot,
      'sessions',
      adapter
        .resolvePaths({ root: nativeRoot, cwd, sessionId: sessionIds[0] })
        .sessionFile.split('/')
        .at(-2),
    ),
    { withFileTypes: true },
  )
  if (
    filesAfterDryRun.some(
      (entry) =>
        entry.name.includes('migration') || entry.name.includes('legacy'),
    )
  )
    throw new Error('dry-run created migration side effects')

  const migrated = parseJson(
    runCli(['migrate', 'native-transcript', '--all', '--json']),
  )
  for (const sessionId of sessionIds) {
    const path = adapter.resolvePaths({
      root: nativeRoot,
      cwd,
      sessionId,
    }).sessionFile
    const item = migrated.find((migration) => migration.sessionId === sessionId)
    if (!item || item.status !== 'migrated' || !item.legacyPath)
      throw new Error(`migration did not publish: ${sessionId}`)
    if (!(await stat(item.legacyPath)).isFile())
      throw new Error('retained legacy file missing')
    if (
      !Buffer.from(await readFile(item.legacyPath)).equals(
        originalBytes.get(path),
      )
    )
      throw new Error('retained legacy bytes changed')
    if ((await readNativeTranscript(path)).format !== 'native')
      throw new Error('active file is not native')
  }
  const text = runCli(['migrate', 'native-transcript', sessionIds[0]])
  if (!text.includes(sessionIds[0]) || !text.includes('already-migrated'))
    throw new Error('text idempotence output missing')
  const rolledBack = parseJson(
    runCli(['migrate', 'native-transcript', '--all', '--rollback', '--json']),
  )
  for (const sessionId of sessionIds) {
    const path = adapter.resolvePaths({
      root: nativeRoot,
      cwd,
      sessionId,
    }).sessionFile
    const item = rolledBack.find(
      (migration) => migration.sessionId === sessionId,
    )
    if (!item || item.status !== 'rolled-back')
      throw new Error(`rollback did not complete: ${sessionId}`)
    if (!Buffer.from(await readFile(path)).equals(originalBytes.get(path)))
      throw new Error('rollback did not restore legacy bytes')
    if (!(await stat(item.nativePath)).isFile())
      throw new Error('retained native file missing')
  }
  if ((await readFile(join(claudeRoot, 'sentinel'), 'utf8')) !== 'untouched\n')
    throw new Error('Claude sentinel changed')
  console.log('native migration CLI gate passed')
} finally {
  await rm(root, { recursive: true, force: true })
}
