import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  CLAUDE_2_1_208_CONFIG_SETTINGS,
  configSettingDefinition,
  configSettingValue,
  loadConfigSettings,
  saveConfigSetting,
  type ConfigSettingDefinition,
  type ConfigValue,
} from './config-settings.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function root() {
  const value = await mkdtemp(join(tmpdir(), 'praxis-config-settings-'))
  roots.push(value)
  return value
}

function definition(id: string) {
  const value = configSettingDefinition(id)
  if (!value) throw new Error(`Missing test config definition: ${id}`)
  return value
}

describe('Claude 2.1.208 config settings contract', () => {
  it('matches the fixed provider-free PTY catalog and exclusions', async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL(
          '../../../test/fixtures/claude-code/2.1.208/config-dashboard.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as {
      includedNativeKeys: string[]
      excluded: { nativeKey: string }[]
    }

    expect(
      CLAUDE_2_1_208_CONFIG_SETTINGS.map((setting) => setting.nativeKey),
    ).toEqual(fixture.includedNativeKeys)
    expect(fixture.excluded.map((setting) => setting.nativeKey)).toEqual([
      'autoConnectIde',
      'chrome',
    ])
    expect(
      CLAUDE_2_1_208_CONFIG_SETTINGS.some((setting) =>
        fixture.excluded.some(
          (excluded) => excluded.nativeKey === setting.nativeKey,
        ),
      ),
    ).toBe(false)
    expect(
      CLAUDE_2_1_208_CONFIG_SETTINGS.filter(
        (setting) => setting.runtimeStatus === 'integrated',
      ).map((setting) => setting.nativeKey),
    ).toEqual([
      'autoCompact',
      'thinking',
      'checkpoints',
      'workflows',
      'permissionMode',
      'worktreeBaseRef',
      'gitignore',
      'theme',
      'outputStyle',
      'language',
      'model',
    ])
    expect(
      CLAUDE_2_1_208_CONFIG_SETTINGS.filter(
        (setting) => setting.runtimeStatus === 'not-applicable',
      ).map((setting) => setting.nativeKey),
    ).toEqual(['switchModelsOnFlag'])
    expect(
      CLAUDE_2_1_208_CONFIG_SETTINGS.every(
        (setting) => setting.runtimeConsumer.length > 0,
      ),
    ).toBe(true)
  })

  it('matches every captured label, scope, path, domain, and default', async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL(
          '../../../test/fixtures/claude-code/2.1.208/config-dashboard.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as {
      settings: Array<{
        nativeKey: string
        label: string
        scope: string
        path: string[]
        domain: ConfigSettingDefinition['values']
        defaultValue: ConfigValue
      }>
    }
    expect(
      CLAUDE_2_1_208_CONFIG_SETTINGS.map((setting) => ({
        nativeKey: setting.nativeKey,
        label: setting.label,
        scope: setting.scope,
        path: setting.path,
        domain: setting.values,
        defaultValue: setting.defaultValue,
      })),
    ).toEqual(fixture.settings)
  })

  it('loads both native scopes and defaults invalid stored values', async () => {
    const configRoot = await root()
    await writeFile(
      join(configRoot, 'settings.json'),
      JSON.stringify({
        autoCompactEnabled: false,
        permissions: { defaultMode: 'plan' },
        editorMode: 'unsupported',
      }),
    )
    await writeFile(
      join(configRoot, 'state.json'),
      JSON.stringify({
        respectGitignore: false,
        workflowSizeGuideline: 'small',
      }),
    )

    const snapshot = await loadConfigSettings(configRoot)
    expect(configSettingValue(snapshot, definition('autoCompact'))).toBe(false)
    expect(configSettingValue(snapshot, definition('permissionMode'))).toBe(
      'plan',
    )
    expect(configSettingValue(snapshot, definition('gitignore'))).toBe(false)
    expect(
      configSettingValue(snapshot, definition('workflowSizeGuideline')),
    ).toBe('small')
    expect(configSettingValue(snapshot, definition('editor'))).toBe('normal')
  })

  it('atomically mutates nested settings and state while preserving unknown keys', async () => {
    const configRoot = await root()
    await writeFile(
      join(configRoot, 'settings.json'),
      '{"permissions":{"allow":["Read"]},"unknown":{"keep":true}}\n',
    )
    await writeFile(
      join(configRoot, 'state.json'),
      '{"projects":{"/work":{"trusted":true}},"unknownState":7}\n',
    )

    await saveConfigSetting('permissionMode', 'plan', configRoot)
    await saveConfigSetting('gitignore', false, configRoot)

    expect(
      JSON.parse(await readFile(join(configRoot, 'settings.json'), 'utf8')),
    ).toEqual({
      permissions: { allow: ['Read'], defaultMode: 'plan' },
      unknown: { keep: true },
    })
    expect(
      JSON.parse(await readFile(join(configRoot, 'state.json'), 'utf8')),
    ).toEqual({
      projects: { '/work': { trusted: true } },
      unknownState: 7,
      respectGitignore: false,
    })
  })

  it('persists the Claude-compatible TUI renderer key in settings.json', async () => {
    const configRoot = await root()
    await writeFile(
      join(configRoot, 'settings.json'),
      '{"theme":"dark","tui":"default","unknown":true}\n',
    )

    await saveConfigSetting('tui', 'fullscreen', configRoot)

    expect(
      JSON.parse(await readFile(join(configRoot, 'settings.json'), 'utf8')),
    ).toEqual({ theme: 'dark', tui: 'fullscreen', unknown: true })
  })

  it('persists an explicit provider model ID outside the config picker aliases', async () => {
    const configRoot = await root()
    await saveConfigSetting('model', 'provider/model-custom', configRoot)
    expect(
      JSON.parse(await readFile(join(configRoot, 'settings.json'), 'utf8')),
    ).toMatchObject({ model: 'provider/model-custom' })
  })

  it('uses an explicit Claude state path independently of the config root', async () => {
    const container = await root()
    const configRoot = join(container, 'config')
    const statePath = join(container, 'claude-state.json')
    const location = { configRoot, statePath }

    await saveConfigSetting('gitignore', false, location)
    await saveConfigSetting('autoCompact', false, location)

    expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({
      respectGitignore: false,
    })
    expect(
      JSON.parse(await readFile(join(configRoot, 'settings.json'), 'utf8')),
    ).toEqual({ autoCompactEnabled: false })
  })

  it('serializes concurrent per-key mutations without losing either update', async () => {
    const configRoot = await root()
    await writeFile(
      join(configRoot, 'settings.json'),
      '{"permissions":{"allow":["Read"]}}\n',
    )

    await Promise.all([
      saveConfigSetting('autoCompact', false, configRoot),
      saveConfigSetting('verbose', true, configRoot),
      saveConfigSetting('permissionMode', 'acceptEdits', configRoot),
    ])

    expect(
      JSON.parse(await readFile(join(configRoot, 'settings.json'), 'utf8')),
    ).toEqual({
      permissions: { allow: ['Read'], defaultMode: 'acceptEdits' },
      autoCompactEnabled: false,
      verbose: true,
    })
  })

  it('fails closed on malformed shared files and never replaces them', async () => {
    const configRoot = await root()
    const settingsPath = join(configRoot, 'settings.json')
    const statePath = join(configRoot, 'state.json')
    await writeFile(settingsPath, '[]\n')
    await writeFile(statePath, '{')

    await expect(loadConfigSettings(configRoot)).rejects.toThrow()
    await expect(
      saveConfigSetting('autoCompact', false, configRoot),
    ).rejects.toThrow()
    await expect(
      saveConfigSetting('gitignore', false, configRoot),
    ).rejects.toThrow()
    await expect(readFile(settingsPath, 'utf8')).resolves.toBe('[]\n')
    await expect(readFile(statePath, 'utf8')).resolves.toBe('{')
  })

  it('preflights both scopes before mutating either shared file', async () => {
    const configRoot = await root()
    const settingsPath = join(configRoot, 'settings.json')
    await writeFile(settingsPath, '{"unknown":true}\n')
    await writeFile(join(configRoot, 'state.json'), '[]\n')

    await expect(
      saveConfigSetting('autoCompact', false, configRoot),
    ).rejects.toThrow('JSON root must be an object')
    await expect(readFile(settingsPath, 'utf8')).resolves.toBe(
      '{"unknown":true}\n',
    )
  })

  it('rejects a non-object intermediate instead of replacing it', async () => {
    const configRoot = await root()
    const settingsPath = join(configRoot, 'settings.json')
    await writeFile(settingsPath, '{"permissions":[]}')

    await expect(
      saveConfigSetting('permissionMode', 'plan', configRoot),
    ).rejects.toThrow('crosses a non-object')
    await expect(readFile(settingsPath, 'utf8')).resolves.toBe(
      '{"permissions":[]}',
    )
  })

  it('retries when either shared scope changes after validation', async () => {
    const configRoot = await root()
    const statePath = join(configRoot, 'state.json')
    await writeFile(join(configRoot, 'settings.json'), '{"existing":true}\n')
    await writeFile(statePath, '{"respectGitignore":true}\n')
    let injected = false

    await saveConfigSetting('autoCompact', false, configRoot, {
      async afterValidation() {
        if (injected) return
        injected = true
        await writeFile(
          statePath,
          '{"respectGitignore":false,"external":"preserved"}\n',
        )
      },
    })

    await expect(loadConfigSettings(configRoot)).resolves.toMatchObject({
      settings: { existing: true, autoCompactEnabled: false },
      state: { respectGitignore: false, external: 'preserved' },
    })
  })

  it('rejects symlinked settings and state files without replacing them', async () => {
    const configRoot = await root()
    const outside = await root()
    const outsideSettings = join(outside, 'settings.json')
    const outsideState = join(outside, 'state.json')
    await writeFile(outsideSettings, '{"keep":"settings"}\n')
    await writeFile(outsideState, '{"keep":"state"}\n')
    await symlink(outsideSettings, join(configRoot, 'settings.json'))
    await writeFile(join(configRoot, 'state.json'), '{}\n')

    await expect(loadConfigSettings(configRoot)).rejects.toThrow(
      'must be a regular file',
    )
    await expect(
      saveConfigSetting('autoCompact', false, configRoot),
    ).rejects.toThrow('must be a regular file')
    await expect(readFile(outsideSettings, 'utf8')).resolves.toBe(
      '{"keep":"settings"}\n',
    )

    await rm(join(configRoot, 'settings.json'))
    await writeFile(join(configRoot, 'settings.json'), '{}\n')
    await rm(join(configRoot, 'state.json'))
    await symlink(outsideState, join(configRoot, 'state.json'))
    await expect(loadConfigSettings(configRoot)).rejects.toThrow(
      'must be a regular file',
    )
    await expect(
      saveConfigSetting('gitignore', false, configRoot),
    ).rejects.toThrow('must be a regular file')
    await expect(readFile(outsideSettings, 'utf8')).resolves.toBe(
      '{"keep":"settings"}\n',
    )
    await expect(readFile(outsideState, 'utf8')).resolves.toBe(
      '{"keep":"state"}\n',
    )
  })

  it('uses one canonical lease for aliased config roots', async () => {
    const container = await root()
    const configRoot = join(container, 'config')
    const alias = join(container, 'alias')
    await mkdir(configRoot)
    await symlink(configRoot, alias)

    await Promise.all([
      saveConfigSetting('autoCompact', false, configRoot),
      saveConfigSetting('verbose', true, alias),
    ])

    await expect(loadConfigSettings(configRoot)).resolves.toMatchObject({
      settings: { autoCompactEnabled: false, verbose: true },
    })
  })

  it('rejects unknown keys and values before touching disk', async () => {
    const configRoot = await root()
    await expect(
      saveConfigSetting('autoConnectIde', true, configRoot),
    ).rejects.toThrow('Unknown Claude config setting')
    await expect(
      saveConfigSetting('permissionMode', 'root', configRoot),
    ).rejects.toThrow('Invalid value')
    await expect(
      saveConfigSetting('language', 'x'.repeat(257), configRoot),
    ).rejects.toThrow('Invalid value')
    await expect(saveConfigSetting('language', '', configRoot)).rejects.toThrow(
      'Invalid value',
    )
  })
})
