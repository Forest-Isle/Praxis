import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  resolveConfigSettingsLocation,
  saveConfigSetting,
} from './config-settings.js'
import { loadTuiMemoryFiles } from './memory-files.js'
import {
  addTuiPermissionRule,
  loadTuiPermissionRules,
  persistTuiPermissionUpdates,
} from './permission-settings.js'
import { createClaudeStatusLineInput } from './status-line.js'
import { saveTuiThemeSettings } from './theme-settings.js'

const roots: string[] = []
const originalPraxisHome = process.env.PRAXIS_HOME
const originalDataPlane = process.env.PRAXIS_DATA_PLANE

afterEach(async () => {
  if (originalPraxisHome === undefined) delete process.env.PRAXIS_HOME
  else process.env.PRAXIS_HOME = originalPraxisHome
  if (originalDataPlane === undefined) delete process.env.PRAXIS_DATA_PLANE
  else process.env.PRAXIS_DATA_PLANE = originalDataPlane
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function fixture() {
  const container = await mkdtemp(join(tmpdir(), 'praxis-tui-native-'))
  roots.push(container)
  const root = join(container, 'home')
  const cwd = join(container, 'project')
  await Promise.all([mkdir(root, { recursive: true }), mkdir(cwd)])
  process.env.PRAXIS_HOME = root
  delete process.env.PRAXIS_DATA_PLANE
  return { container, root, cwd }
}

describe.sequential('native TUI data plane', () => {
  it('resolves config state and persists settings without touching .claude', async () => {
    const { root, cwd } = await fixture()

    expect(resolveConfigSettingsLocation()).toEqual({
      configRoot: root,
      statePath: join(root, 'state.json'),
    })
    await saveConfigSetting('prStatus', false)
    await addTuiPermissionRule({
      cwd,
      behavior: 'allow',
      rule: 'Read(./src/**)',
      scope: 'local',
    })
    await saveTuiThemeSettings({ theme: 'dark' })

    await expect(loadTuiPermissionRules(cwd)).resolves.toEqual([
      expect.objectContaining({
        behavior: 'allow',
        rule: 'Read(./src/**)',
        path: join(cwd, '.praxis', 'settings.local.json'),
      }),
    ])
    expect(
      JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')),
    ).toEqual({
      theme: 'dark',
    })
    expect(
      JSON.parse(await readFile(join(root, 'state.json'), 'utf8')),
    ).toEqual({ prStatusFooterEnabled: false })
    await expect(access(join(cwd, '.claude'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('honors an explicit native permission target when the environment selects Claude', async () => {
    const { root, cwd } = await fixture()
    process.env.PRAXIS_DATA_PLANE = 'claude'

    await persistTuiPermissionUpdates({
      configRoot: root,
      cwd,
      updates: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
          behavior: 'allow',
          destination: 'localSettings',
        },
      ],
    })

    await expect(
      readFile(join(cwd, '.praxis', 'settings.local.json'), 'utf8'),
    ).resolves.toContain('Bash(npm test:*)')
    await expect(access(join(cwd, '.claude'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('loads native memory paths and reports the native transcript path', async () => {
    const { root, cwd } = await fixture()
    await Promise.all([
      writeFile(join(root, 'PRAXIS.md'), '# User\n'),
      mkdir(join(cwd, '.praxis'), { recursive: true }),
    ])
    await writeFile(join(cwd, '.praxis', 'PRAXIS.md'), '# Project\n')

    const memory = await loadTuiMemoryFiles({
      configRoot: root,
      cwd,
    })
    expect(memory.entries.map((entry) => entry.path)).toContain(
      join(cwd, '.praxis', 'PRAXIS.md'),
    )
    expect(memory.entries[0]?.displayPath).toBe(join(root, 'PRAXIS.md'))

    const status = createClaudeStatusLineInput({
      configRoot: root,
      cwd,
      projectDir: cwd,
      sessionId: '123e4567-e89b-42d3-a456-426614174000',
      version: 'test',
      outputStyle: 'default',
      additionalDirectories: [],
      dataPlane: 'native',
    })
    expect(status.transcript_path).toContain(`${join(root, 'sessions')}/`)
    expect(status.transcript_path).not.toContain('/projects/')
  })
})
