import { describe, expect, it } from 'vitest'

import {
  conversationExportPath,
  conversationExportText,
  defaultConversationExportFilename,
  writeConversationExport,
} from './conversation-export.js'

describe('conversation export', () => {
  it('formats the complete local transcript as readable terminal text', () => {
    const text = conversationExportText(
      {
        version: '0.2.0',
        cwd: '/workspace',
        model: 'fixture-model',
        effort: 'medium',
      },
      [
        { kind: 'user', text: 'Inspect this' },
        { kind: 'thinking', text: 'Checking the files' },
        { kind: 'assistant', text: 'Done' },
        { kind: 'shell', callId: 'shell-1', command: 'git status' },
        {
          kind: 'shell-result',
          callId: 'shell-1',
          stdout: 'clean',
          stderr: '',
          isError: false,
        },
      ],
    )

    expect(text).toContain('Praxis Code v0.2.0')
    expect(text).toContain('Welcome back!')
    expect(text).toContain('fixture-model · medium effort')
    expect(text).toContain('/workspace')
    expect(text).toContain('Tips for getting started: Run /init to create a CLAUDE.md file with instructions for Claude')
    expect(text).toContain("What's new: Subagent forking on by default")
    expect(text).toContain('❯ Inspect this')
    expect(text).toContain('✻ Checking the files')
    expect(text).toContain('⏺ Done')
    expect(text).toContain('! git status\n  ⎿ clean')
  })

  it('creates the same timestamp-shaped default used by the save prompt', () => {
    expect(
      defaultConversationExportFilename(new Date(2026, 7, 11, 10, 27, 33)),
    ).toBe('2026-08-11-102733-praxis-conversation.txt')
  })

  it('keeps saved exports inside the current working directory', () => {
    expect(conversationExportPath('/workspace', 'conversation.txt')).toBe(
      '/workspace/conversation.txt',
    )
    expect(() =>
      conversationExportPath('/workspace', '../outside.txt'),
    ).toThrow('Export filename must stay within the current directory')
    expect(() =>
      conversationExportPath('/workspace', '/tmp/outside.txt'),
    ).toThrow('Export filename must stay within the current directory')
    expect(() =>
      conversationExportPath('/workspace', 'nested/conversation.txt'),
    ).toThrow('Export filename must stay within the current directory')
  })

  it('creates a new regular file without following an existing symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-export-'))
    try {
      const outside = join(root, 'outside.txt')
      const exportPath = join(root, 'conversation.txt')
      await writeFile(outside, 'unchanged', 'utf8')
      await symlink(outside, exportPath)

      await expect(
        writeConversationExport(exportPath, 'export'),
      ).rejects.toMatchObject({ code: 'EEXIST' })
      expect(await readFile(outside, 'utf8')).toBe('unchanged')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
