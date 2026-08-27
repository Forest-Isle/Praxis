import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Buffer } from 'node:buffer'
const output = new URL('../dist-native/', import.meta.url)

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? filesBelow(path) : [path]
    }),
  )
  return nested.flat()
}

const outputPath = output.pathname
const cliPath = new URL('../dist/cli.js', import.meta.url).pathname
try {
  const emitted = await filesBelow(outputPath)
  if (
    emitted.some((path) =>
      path.replaceAll('\\', '/').includes('compatibility/claude'),
    )
  )
    throw new Error('native output contains a Claude compatibility module')
  for (const path of emitted) {
    if (!/\.(?:map|d\.ts)$/.test(path)) continue
    const source = await readFile(path, 'utf8')
    if (source.includes('compatibility/claude'))
      throw new Error(
        `native declaration/source map references Claude compatibility: ${path}`,
      )
  }

  const [
    { NativeDataPlaneAdapter },
    { createNativeTranscriptCodec },
    { NativeTranscriptStore },
    { NativeSessionTranscript },
  ] = await Promise.all([
    import(new URL('./persistence/native-data-plane-adapter.js', output)),
    import(new URL('./persistence/native-transcript-codec.js', output)),
    import(new URL('./persistence/native-transcript-store.js', output)),
    import(new URL('./application/native-session-transcript.js', output)),
  ])
  const temporaryRoot = await realpath(
    await mkdtemp(join(tmpdir(), 'praxis-native-deletion-')),
  )
  try {
    const adapter = new NativeDataPlaneAdapter()
    const paths = adapter.resolvePaths({
      root: temporaryRoot,
      cwd: temporaryRoot,
      sessionId: '00000000-0000-4000-8000-000000000001',
    })
    const codec = createNativeTranscriptCodec()
    const event = {
      kind: 'messages',
      id: 'native-deletion-event',
      parentId: null,
      sessionId: '00000000-0000-4000-8000-000000000001',
      timestamp: '2026-01-01T00:00:00.000Z',
      messages: [{ role: 'user', content: 'native smoke' }],
    }
    const encoded = codec.encodeLine(event)
    if (!encoded.ok)
      throw new Error(`native encoding failed: ${encoded.issue.message}`)
    const decoded = codec.decodeLine(encoded.line)
    if (!decoded.ok || decoded.record.event.id !== event.id)
      throw new Error('native encode/decode smoke failed')
    const store = new NativeTranscriptStore({
      transcriptFile: paths.sessionFile,
      lockFile: `${paths.sessionFile}.lock`,
    })
    const snapshot = await store.load()
    if (snapshot.records.length !== 0)
      throw new Error('new native store was not empty')
    await mkdir(paths.projectRoot, { recursive: true })
    await writeFile(paths.sessionFile, `${encoded.line}\n`)
    const loaded = await store.load()
    if (loaded.records.length !== 1 || loaded.records[0]?.event.id !== event.id)
      throw new Error('native store smoke failed')

    const runCli = (args) => {
      const result = spawnSync(process.execPath, [cliPath, ...args], {
        cwd: temporaryRoot,
        env: {
          ...process.env,
          PRAXIS_HOME: temporaryRoot,
          PRAXIS_DATA_PLANE: 'native',
          PRAXIS_EXPERIMENTAL_NATIVE_TRANSCRIPT_WRITES: '1',
          CLAUDE_CONFIG_DIR: join(temporaryRoot, 'claude-sentinel'),
          ANTHROPIC_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
          CLAUDE_CODE_SIMPLE: '1',
        },
        encoding: 'utf8',
      })
      if (result.status !== 0)
        throw new Error(
          `native CLI ${args.join(' ')} failed: ${result.stderr.trim()} ${result.stdout.trim()}`,
        )
      if (result.stderr.trim())
        throw new Error(`native CLI emitted stderr: ${result.stderr.trim()}`)
      return result.stdout
    }
    const listed = JSON.parse(runCli(['sessions', '--json']))
    if (!listed.sessions.some((item) => item.sessionId === event.sessionId))
      throw new Error('native CLI sessions did not list the native transcript')
    const inspected = JSON.parse(runCli(['inspect', '--json', event.sessionId]))
    if (inspected.session?.sessionId !== event.sessionId)
      throw new Error('native CLI inspect did not return the native transcript')
    if (
      Buffer.from(runCli(['export', event.sessionId])).toString() !==
      `${encoded.line}\n`
    )
      throw new Error('native CLI export changed native transcript bytes')
    const forked = runCli(['fork', event.sessionId]).trim()
    if (!/^[-0-9a-f]{36}$/u.test(forked))
      throw new Error('native CLI fork did not return a session id')

    const sessionId = '00000000-0000-4000-8000-000000000002'
    const sessionPaths = adapter.resolvePaths({
      root: temporaryRoot,
      cwd: temporaryRoot,
      sessionId,
    })
    const sessionStore = new NativeTranscriptStore({
      transcriptFile: sessionPaths.sessionFile,
      lockFile: `${sessionPaths.sessionFile}.lock`,
    })
    const transcript = new NativeSessionTranscript({
      sessionId,
      store: sessionStore,
      createId: (() => {
        let index = 0
        return () => `native-session-${++index}`
      })(),
      now: () => '2026-01-01T00:00:00.000Z',
    })
    await transcript.withLease({ kind: 'start' }, async (lease) => {
      await lease.appendMessages({
        messages: [
          { role: 'user', content: 'native prompt' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'tool-1', name: 'Read', input: {} }],
          },
        ],
      })
      await lease.beginToolExecution('tool-1')
      await lease.appendToolCompletion({
        callId: 'tool-1',
        result: { content: 'native tool result', isError: false },
      })
    })
    const resumed = new NativeSessionTranscript({
      sessionId,
      store: sessionStore,
      createId: () => 'native-session-resume',
      now: () => '2026-01-01T00:00:01.000Z',
    })
    await resumed.withLease({ kind: 'resume' }, async (lease) => {
      if (lease.activeMessages().length !== 3)
        throw new Error('native session resume smoke failed')
    })

    const interruptedId = '00000000-0000-4000-8000-000000000004'
    const interruptedPaths = adapter.resolvePaths({
      root: temporaryRoot,
      cwd: temporaryRoot,
      sessionId: interruptedId,
    })
    const interrupted = new NativeSessionTranscript({
      sessionId: interruptedId,
      store: new NativeTranscriptStore({
        transcriptFile: interruptedPaths.sessionFile,
        lockFile: `${interruptedPaths.sessionFile}.lock`,
      }),
      createId: (() => {
        let index = 0
        return () => `native-interrupted-${++index}`
      })(),
      now: () => '2026-01-01T00:00:03.000Z',
    })
    await interrupted.withLease({ kind: 'start' }, async (lease) => {
      await lease.appendMessages({
        messages: [
          { role: 'user', content: 'interrupt me' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'tool-interrupted', name: 'Read', input: {} }],
          },
        ],
      })
      await lease.beginToolExecution('tool-interrupted')
    })
    const interruptedResume = new NativeSessionTranscript({
      sessionId: interruptedId,
      store: new NativeTranscriptStore({
        transcriptFile: interruptedPaths.sessionFile,
        lockFile: `${interruptedPaths.sessionFile}.lock`,
      }),
    })
    await interruptedResume.withLease({ kind: 'resume' }, async (lease) => {
      if (lease.interruption().kind !== 'indeterminate-tools')
        throw new Error('native interruption recovery smoke failed')
    })

    const compactedId = '00000000-0000-4000-8000-000000000005'
    const compactedPaths = adapter.resolvePaths({
      root: temporaryRoot,
      cwd: temporaryRoot,
      sessionId: compactedId,
    })
    const compacted = new NativeSessionTranscript({
      sessionId: compactedId,
      store: new NativeTranscriptStore({
        transcriptFile: compactedPaths.sessionFile,
        lockFile: `${compactedPaths.sessionFile}.lock`,
      }),
      now: () => '2026-01-01T00:00:04.000Z',
    })
    await compacted.withLease({ kind: 'start' }, async (lease) => {
      await lease.appendMessages({
        messages: [{ role: 'user', content: 'before compaction' }],
      })
      await lease.appendCompaction({
        summary: 'compacted native context',
        trigger: 'manual',
        preTokens: 100,
        postTokens: 20,
        durationMs: 1,
        preservedMessages: [{ role: 'user', content: 'preserved context' }],
      })
    })
    await compacted.withLease({ kind: 'resume' }, async (lease) => {
      const messages = lease.activeMessages()
      if (!messages.some((message) => message.content === 'preserved context'))
        throw new Error('native compaction resume smoke failed')
    })
    const forkId = '00000000-0000-4000-8000-000000000003'
    const forkPaths = adapter.resolvePaths({
      root: temporaryRoot,
      cwd: temporaryRoot,
      sessionId: forkId,
    })
    const forkStore = new NativeTranscriptStore({
      transcriptFile: forkPaths.sessionFile,
      lockFile: `${forkPaths.sessionFile}.lock`,
    })
    await resumed.forkTo(
      new NativeSessionTranscript({
        sessionId: forkId,
        store: forkStore,
        createId: () => 'native-fork',
        now: () => '2026-01-01T00:00:02.000Z',
      }),
    )
    if ((await forkStore.load()).records.length !== 3)
      throw new Error('native session fork smoke failed')
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
  console.log('native deletion gate passed')
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
