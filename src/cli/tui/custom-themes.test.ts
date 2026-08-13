import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it } from 'vitest'

import {
  createTuiCustomTheme,
  deleteTuiCustomTheme,
  loadTuiCustomThemes,
  updateTuiCustomTheme,
  validateCustomThemeName,
} from './custom-themes.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

it('creates, edits, resets, and deletes a Claude-compatible custom theme sidecar', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-custom-theme-'))
  roots.push(root)
  const theme = await createTuiCustomTheme({
    name: 'Ocean Night',
    base: 'dark',
    configRoot: root,
  })
  expect(theme).toMatchObject({
    name: 'Ocean Night',
    slug: 'ocean-night',
    base: 'dark',
    overrides: {},
  })
  const path = join(root, 'themes', 'ocean-night.json')
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
    name: 'Ocean Night',
    base: 'dark',
    overrides: {},
  })

  const edited = await updateTuiCustomTheme(theme, 'claude', '#00aaff', root)
  expect(edited.overrides).toEqual({ claude: '#00aaff' })
  const reset = await updateTuiCustomTheme(edited, 'claude', undefined, root)
  expect(reset.overrides).toEqual({})
  await deleteTuiCustomTheme(reset, root)
  await expect(loadTuiCustomThemes(root)).resolves.toEqual([])
})

it('serializes concurrent token mutations under one local lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-custom-theme-'))
  roots.push(root)
  const theme = await createTuiCustomTheme({
    name: 'Ocean',
    base: 'dark',
    configRoot: root,
  })
  await Promise.all([
    updateTuiCustomTheme(theme, 'claude', '#00aaff', root),
    updateTuiCustomTheme(theme, 'error', 'ansi:red', root),
  ])
  await expect(loadTuiCustomThemes(root)).resolves.toEqual([
    expect.objectContaining({
      overrides: { claude: '#00aaff', error: 'ansi:red' },
    }),
  ])
})

it('rejects malformed names, colors, schemas, and filename/name mismatches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-custom-theme-'))
  roots.push(root)
  expect(() => validateCustomThemeName('../escape')).toThrow('Theme name')
  await expect(
    createTuiCustomTheme({
      name: 'Bad',
      base: 'auto' as never,
      configRoot: root,
    }),
  ).rejects.toThrow('Invalid custom theme base')
  const theme = await createTuiCustomTheme({
    name: 'Safe',
    base: 'light',
    configRoot: root,
  })
  await expect(
    updateTuiCustomTheme(theme, 'claude', 'red', root),
  ).rejects.toThrow('Invalid theme color')
  await writeFile(
    join(root, 'themes', 'wrong.json'),
    '{"name":"Different","base":"dark","overrides":{}}\n',
  )
  await expect(loadTuiCustomThemes(root)).rejects.toThrow(
    'Custom theme filename must match its name',
  )
})
