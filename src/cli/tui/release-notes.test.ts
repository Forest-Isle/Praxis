import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  CLAUDE_CHANGELOG_URL,
  formatClaudeReleaseNotes,
  loadClaudeReleaseNotes,
  parseClaudeChangelog,
} from './release-notes.js'

describe('Claude release notes', () => {
  const changelog = `# Changelog

## 2.1.10 - 2026-01-02

- Newer note
- Another note

## 2.1.9

- Older note
`

  it('parses markdown releases and formats them oldest first', () => {
    expect(parseClaudeChangelog(changelog)).toEqual([
      ['2.1.9', ['Older note']],
      ['2.1.10', ['Newer note', 'Another note']],
    ])
    expect(formatClaudeReleaseNotes(changelog)).toBe(
      'Version 2.1.9:\n· Older note\n\nVersion 2.1.10:\n· Newer note\n· Another note',
    )
  })

  it('stores a successful fetch in the shared Claude cache', async () => {
    const configRoot = await mkdtemp(join(tmpdir(), 'praxis-notes-'))
    const output = await loadClaudeReleaseNotes({
      configRoot,
      fetcher: async () => new Response(changelog),
    })
    expect(output).toContain('Version 2.1.10:')
    await expect(
      readFile(join(configRoot, 'cache', 'changelog.md'), 'utf8'),
    ).resolves.toBe(changelog)
  })

  it('falls back to cache and then the public changelog link', async () => {
    const configRoot = await mkdtemp(join(tmpdir(), 'praxis-notes-'))
    await writeFile(join(configRoot, 'cached.md'), 'unused')
    const failing = async () => {
      throw new Error('offline')
    }
    expect(
      await loadClaudeReleaseNotes({
        configRoot,
        fetcher: failing,
      }),
    ).toBe(`See the full changelog at: ${CLAUDE_CHANGELOG_URL}`)
  })
})
