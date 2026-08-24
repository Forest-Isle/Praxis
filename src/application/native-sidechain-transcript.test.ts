import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { NativeSidechainTranscript } from './native-sidechain-transcript.js'

const roots: string[] = []
const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const agentId = 'a0123456789abcdef'
const metadata = {
  agentType: 'general-purpose',
  description: 'Inspect',
  toolUseId: 'call_agent',
  spawnDepth: 1,
  cwd: '/tmp',
  promptId: '11111111-1111-4111-8111-111111111111',
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'praxis-native-sidechain-test-'))
  roots.push(root)
  const directory = join(root, 'subagents')
  return {
    root,
    paths: {
      sessionId,
      agentId,
      directory,
      transcriptFile: join(directory, `agent-${agentId}.jsonl`),
      metadataFile: join(directory, `agent-${agentId}.meta.json`),
    },
  }
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('NativeSidechainTranscript', () => {
  it('writes canonical native root and strict metadata', async () => {
    const { paths } = await setup()
    const store = new NativeSidechainTranscript(paths)
    await store.create('Inspect this.', metadata)
    expect(JSON.parse(await readFile(paths.metadataFile, 'utf8'))).toEqual(
      metadata,
    )
    const source = await readFile(paths.transcriptFile, 'utf8')
    expect(source).toContain('"schema":"praxis.transcript"')
    expect(source).not.toContain('isSidechain')
    expect((await store.loadReadOnly()).records).toHaveLength(1)
    await expect(store.metadata()).resolves.toEqual(metadata)
  })

  it('rejects mismatched paths and metadata without mutation', async () => {
    const { paths } = await setup()
    expect(
      () =>
        new NativeSidechainTranscript({
          ...paths,
          transcriptFile: join(paths.directory, 'other.jsonl'),
        }),
    ).toThrow(/paths do not match/)
  })

  it('rolls metadata back when transcript already exists', async () => {
    const { paths } = await setup()
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.transcriptFile, 'legacy\n')
    const store = new NativeSidechainTranscript(paths)
    await expect(store.create('Inspect this.', metadata)).rejects.toThrow()
    await expect(readFile(paths.metadataFile)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
