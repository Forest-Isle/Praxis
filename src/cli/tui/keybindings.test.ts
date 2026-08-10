import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type { Key } from 'ink'

import {
  claudeKeybindingsTemplate,
  defaultTuiKeybindings,
  ensureTuiKeybindingsFile,
  loadTuiKeybindings,
  resolveTuiKeybinding,
  tuiKeyChord,
} from './keybindings.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

describe('Claude-compatible TUI keybindings file', () => {
  it('serializes the observed Claude Code 2.1.208 template', () => {
    const template = JSON.parse(claudeKeybindingsTemplate()) as {
      $schema: string
      $docs: string
      bindings: Array<{
        context: string
        bindings: Record<string, string>
      }>
    }
    expect(template.$schema).toBe(
      'https://www.schemastore.org/claude-code-keybindings.json',
    )
    expect(template.$docs).toBe('https://code.claude.com/docs/en/keybindings')
    expect(template.bindings).toHaveLength(19)
    expect(claudeKeybindingsTemplate().split('\n')).toHaveLength(273)
    expect(Buffer.byteLength(claudeKeybindingsTemplate())).toBe(7_809)
    expect(
      createHash('sha256').update(claudeKeybindingsTemplate()).digest('hex'),
    ).toBe('487dec2cf74685dfed8379543b9832d342017a452dcc91c9b848dbbaada6ee26')
    expect(
      template.bindings.find(({ context }) => context === 'Chat')?.bindings,
    ).toMatchObject({
      'ctrl+g': 'chat:externalEditor',
      'ctrl+v': 'chat:imagePaste',
      'ctrl+_': 'chat:undo',
    })
  })

  it('creates the shared file once without overwriting user edits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-keybindings-test-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const path = join(configRoot, 'keybindings.json')

    await expect(ensureTuiKeybindingsFile(configRoot)).resolves.toEqual({
      path,
      created: true,
    })
    expect(JSON.parse(await readFile(path, 'utf8'))).toHaveProperty('bindings')
    expect((await stat(path)).mode & 0o777).toBe(0o600)

    await writeFile(path, '{"user":"edit"}\n', 'utf8')
    await expect(ensureTuiKeybindingsFile(configRoot)).resolves.toEqual({
      path,
      created: false,
    })
    await expect(readFile(path, 'utf8')).resolves.toBe('{"user":"edit"}\n')
  })

  it('merges custom chords and honors explicit unbinding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-keybindings-test-'))
    roots.push(root)
    await writeFile(
      join(root, 'keybindings.json'),
      JSON.stringify({
        bindings: [
          {
            context: 'Chat',
            bindings: {
              'ctrl+g': null,
              'ctrl+y': 'chat:externalEditor',
            },
          },
        ],
      }),
    )
    const bindings = await loadTuiKeybindings(root)
    expect(resolveTuiKeybinding(bindings, ['Chat'], 'ctrl+g')).toBeUndefined()
    expect(resolveTuiKeybinding(bindings, ['Chat'], 'ctrl+y')).toBe(
      'chat:externalEditor',
    )
    expect(resolveTuiKeybinding(bindings, ['Chat'], 'ctrl+v')).toBe(
      'chat:imagePaste',
    )
  })

  it('rejects invalid JSON without returning a partial mapping', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-keybindings-test-'))
    roots.push(root)
    await writeFile(join(root, 'keybindings.json'), '{"bindings":', 'utf8')

    await expect(loadTuiKeybindings(root)).rejects.toThrow(
      `Invalid Claude keybindings file: ${join(root, 'keybindings.json')}`,
    )
  })

  it('rejects oversized keybindings files before parsing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-keybindings-test-'))
    roots.push(root)
    const path = join(root, 'keybindings.json')
    await writeFile(path, Buffer.alloc(1024 * 1024 + 1))

    await expect(loadTuiKeybindings(root)).rejects.toThrow(
      `Claude keybindings file exceeds 1048576 bytes: ${path}`,
    )
  })

  it('normalizes Ink input into Claude key chord names', () => {
    const key = (overrides: Partial<Key>): Key =>
      ({
        upArrow: false,
        downArrow: false,
        leftArrow: false,
        rightArrow: false,
        pageDown: false,
        pageUp: false,
        home: false,
        end: false,
        return: false,
        escape: false,
        ctrl: false,
        shift: false,
        tab: false,
        backspace: false,
        delete: false,
        meta: false,
        super: false,
        hyper: false,
        capsLock: false,
        numLock: false,
        ...overrides,
      }) satisfies Key
    expect(tuiKeyChord('\u0007', key({ ctrl: true }))).toBe('ctrl+g')
    expect(tuiKeyChord('', key({ upArrow: true, meta: true }))).toBe('meta+up')
    expect(tuiKeyChord('\t', key({ tab: true, shift: true }))).toBe('shift+tab')
    expect(tuiKeyChord('k', key({ super: true }))).toBe('cmd+k')
    expect(
      resolveTuiKeybinding(defaultTuiKeybindings(), ['Chat'], 'ctrl+g'),
    ).toBe('chat:externalEditor')
  })
})
