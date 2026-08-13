import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import {
  applyFileReference,
  applyMentionReference,
  fileReferenceAtCursor,
  filterTuiFileEntries,
  filterTuiMentionEntries,
  loadTuiFileEntries,
} from './file-picker.js'

const roots: string[] = []
const execFileAsync = promisify(execFile)

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

  it('mixes matching agents with files and applies Claude agent syntax', () => {
    const entries = filterTuiMentionEntries(
      [
        { path: '.claude/agents/reviewer.md', directory: false },
        { path: 'alpha.ts', directory: false },
      ],
      [
        {
          name: 'reviewer',
          description: 'Reviews code for subtle regressions.',
        },
      ],
      'rev',
    )
    expect(entries).toEqual([
      {
        kind: 'file',
        path: '.claude/agents/reviewer.md',
        directory: false,
      },
      {
        kind: 'agent',
        name: 'reviewer',
        description: 'Reviews code for subtle regressions.',
      },
    ])

    const reference = fileReferenceAtCursor('ask @rev later', 8)
    if (!reference) throw new Error('expected an active mention reference')
    const agentEntry = entries[1]
    if (!agentEntry) throw new Error('expected a matching agent entry')
    expect(
      applyMentionReference('ask @rev later', 8, reference, agentEntry),
    ).toEqual({ text: 'ask @"reviewer (agent)" later', cursor: 23 })
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

  it('can include gitignored paths when the shared setting disables filtering', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-file-picker-ignore-'))
    roots.push(root)
    await writeFile(join(root, '.gitignore'), 'ignored.txt\n')
    await writeFile(join(root, 'ignored.txt'), '')
    await execFileAsync('git', ['init', root])

    expect(await loadTuiFileEntries(root)).not.toContainEqual({
      path: 'ignored.txt',
      directory: false,
    })
    expect(
      await loadTuiFileEntries(root, { respectGitignore: false }),
    ).toContainEqual({ path: 'ignored.txt', directory: false })
  })
})
