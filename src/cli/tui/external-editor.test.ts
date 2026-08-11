import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  editTuiPrompt,
  openTuiEditorFile,
  resolveTuiEditor,
} from './external-editor.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'praxis-editor-test-'))
  roots.push(root)
  return root
}

async function editorFixture(
  root: string,
  name: string,
  body: string,
): Promise<string> {
  const path = join(root, name)
  await writeFile(path, `#!/bin/sh\n${body}\n`, 'utf8')
  await chmod(path, 0o755)
  return path
}

describe('external TUI editor', () => {
  it('prefers VISUAL and parses quoted executable paths and arguments', () => {
    expect(
      resolveTuiEditor({ VISUAL: 'visual-editor --wait', EDITOR: 'editor' }),
    ).toEqual({
      command: 'visual-editor',
      args: ['--wait'],
      displayName: 'Visual-editor',
    })
    expect(
      resolveTuiEditor({
        EDITOR: '\'/Applications/My Editor/bin/edit tool\' --wait "two words"',
      }),
    ).toEqual({
      command: '/Applications/My Editor/bin/edit tool',
      args: ['--wait', 'two words'],
      displayName: 'Edit tool',
    })
  })

  it('falls back to vi and rejects malformed editor commands', () => {
    expect(resolveTuiEditor({})).toEqual({
      command: 'vi',
      args: [],
      displayName: 'Vi',
    })
    expect(() => resolveTuiEditor({ EDITOR: "'broken" })).toThrow(
      'unterminated quote',
    )
  })

  it('round-trips exact prompt bytes without trimming', async () => {
    const root = await fixtureRoot()
    const editor = await editorFixture(root, 'editor-wrapper', 'exit 0')
    const prompt = '  leading  \n\ntrailing  \n\n'
    await expect(
      editTuiPrompt(prompt, {
        cwd: root,
        environment: { EDITOR: editor },
        tempRoot: root,
      }),
    ).resolves.toEqual({ content: prompt, editorName: 'Editor-wrapper' })
    expect(await readdir(root)).toEqual(['editor-wrapper'])
  })

  it('returns the edited multiline content including trailing blank lines', async () => {
    const root = await fixtureRoot()
    const editor = await editorFixture(
      root,
      'rewrite',
      'printf \'first\\nsecond\\n\\n\' > "$1"',
    )
    await expect(
      editTuiPrompt('original', {
        cwd: root,
        environment: { EDITOR: editor },
        tempRoot: root,
      }),
    ).resolves.toEqual({
      content: 'first\nsecond\n\n',
      editorName: 'Rewrite',
    })
  })

  it('opens an existing shared file without copying or removing it', async () => {
    const root = await fixtureRoot()
    const editor = await editorFixture(
      root,
      'open-existing',
      'printf opened > "$1.opened"',
    )
    const path = join(root, 'keybindings.json')
    await writeFile(path, '{"bindings":[]}\n', 'utf8')

    await expect(
      openTuiEditorFile(path, {
        cwd: root,
        environment: { EDITOR: editor },
      }),
    ).resolves.toEqual({ editorName: 'Open-existing' })
    await expect(readFile(path, 'utf8')).resolves.toBe('{"bindings":[]}\n')
    await expect(readFile(`${path}.opened`, 'utf8')).resolves.toBe('opened')
  })

  it('reports non-zero exits and always removes the prompt file', async () => {
    const root = await fixtureRoot()
    const editor = await editorFixture(root, 'editor-fail', 'exit 7')
    await expect(
      editTuiPrompt('original prompt', {
        cwd: root,
        environment: { EDITOR: editor },
        tempRoot: root,
      }),
    ).rejects.toThrow('Editor-fail quit unexpectedly (exit code 7)')
    expect(await readdir(root)).toEqual(['editor-fail'])
  })
})
