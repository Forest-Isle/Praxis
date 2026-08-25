import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  ] = await Promise.all([
    import(new URL('./persistence/native-data-plane-adapter.js', output)),
    import(new URL('./persistence/native-transcript-codec.js', output)),
    import(new URL('./persistence/native-transcript-store.js', output)),
  ])
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'praxis-native-deletion-'))
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
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
  console.log('native deletion gate passed')
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
