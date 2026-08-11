import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { loadTuiThemeSettings, saveTuiThemeSettings } from './theme-settings.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

it('loads the shared Claude theme and defaults unknown values to auto', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-tui-theme-'))
  roots.push(root)
  await writeFile(join(root, 'settings.json'), '{"theme":"dark-ansi"}\n')

  await expect(loadTuiThemeSettings(root)).resolves.toEqual({
    theme: 'dark-ansi',
    syntaxHighlightingDisabled: false,
  })
  await writeFile(join(root, 'settings.json'), '{"theme":"custom"}\n')
  await expect(loadTuiThemeSettings(root)).resolves.toEqual({
    theme: 'auto',
    syntaxHighlightingDisabled: false,
  })
})

it('atomically saves a theme while preserving unrelated shared settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-tui-theme-'))
  roots.push(root)
  await writeFile(
    join(root, 'settings.json'),
    '{"theme":"dark","permissions":{"allow":["Read"]}}\n',
  )

  await expect(
    saveTuiThemeSettings({ theme: 'light-daltonized' }, root),
  ).resolves.toEqual({
    theme: 'light-daltonized',
    syntaxHighlightingDisabled: false,
  })

  expect(
    JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')),
  ).toEqual({
    theme: 'light-daltonized',
    syntaxHighlightingDisabled: false,
    permissions: { allow: ['Read'] },
  })
})

it('merges concurrent per-key updates from shared clients', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-tui-theme-'))
  roots.push(root)
  await writeFile(
    join(root, 'settings.json'),
    '{"theme":"dark","syntaxHighlightingDisabled":false}\n',
  )

  const [themeCommit, syntaxCommit] = await Promise.all([
    saveTuiThemeSettings({ theme: 'light' }, root),
    saveTuiThemeSettings({ syntaxHighlightingDisabled: true }, root),
  ])

  expect(themeCommit.theme).toBe('light')
  expect(syntaxCommit.syntaxHighlightingDisabled).toBe(true)
  await expect(loadTuiThemeSettings(root)).resolves.toEqual({
    theme: 'light',
    syntaxHighlightingDisabled: true,
  })
})

it('rejects malformed shared settings instead of replacing them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-tui-theme-'))
  roots.push(root)
  const path = join(root, 'settings.json')
  await writeFile(path, '[]\n')

  await expect(saveTuiThemeSettings({ theme: 'dark' }, root)).rejects.toThrow(
    'JSON root must be an object',
  )
  await expect(readFile(path, 'utf8')).resolves.toBe('[]\n')
})
