import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  applyFileReference,
  fileReferenceAtCursor,
  filterTuiFileEntries,
  loadTuiFileEntries,
} from './file-picker.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('TUI file picker', () => {
  it('finds and replaces the active @ reference at a code-point cursor', () => {
    const reference = fileReferenceAtCursor('review @src/ag later', 14)
    expect(reference).toEqual({ start: 7, query: 'src/ag' })
    if (!reference) throw new Error('expected an active file reference')
    expect(
      applyFileReference('review @src/ag later', 14, reference, 'src/agent.ts'),
    ).toEqual({ text: 'review @src/agent.ts later', cursor: 20 })
  })

  it('filters paths case-insensitively with prefix matches first', () => {
    expect(
      filterTuiFileEntries(
        [
          { path: 'docs/src-note.md', directory: false },
          { path: 'src/', directory: true },
          { path: 'src/agent.ts', directory: false },
        ],
        'src',
      ).map(({ path }) => path),
    ).toEqual(['src/', 'src/agent.ts', 'docs/src-note.md'])
  })

  it('loads bounded workspace files and their parent directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-file-picker-'))
    roots.push(root)
    await mkdir(join(root, 'src', 'deep'), { recursive: true })
    await writeFile(join(root, 'alpha.ts'), '')
    await writeFile(join(root, 'src', 'deep', 'agent.ts'), '')

    expect(await loadTuiFileEntries(root)).toEqual([
      { path: 'alpha.ts', directory: false },
      { path: 'src/', directory: true },
      { path: 'src/deep/', directory: true },
      { path: 'src/deep/agent.ts', directory: false },
    ])
  })
})
