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

  await saveTuiThemeSettings(
    { theme: 'light-daltonized', syntaxHighlightingDisabled: true },
    root,
  )

  expect(
    JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')),
  ).toEqual({
    theme: 'light-daltonized',
    syntaxHighlightingDisabled: true,
    permissions: { allow: ['Read'] },
  })
})

it('rejects malformed shared settings instead of replacing them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-tui-theme-'))
  roots.push(root)
  const path = join(root, 'settings.json')
  await writeFile(path, '[]\n')

  await expect(
    saveTuiThemeSettings(
      { theme: 'dark', syntaxHighlightingDisabled: false },
      root,
    ),
  ).rejects.toThrow('JSON root must be an object')
  await expect(readFile(path, 'utf8')).resolves.toBe('[]\n')
})
