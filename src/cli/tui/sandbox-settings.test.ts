import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { SandboxDependencyCheck } from '@anthropic-ai/sandbox-runtime'

import {
  createTuiSandboxStore,
  type TuiSandboxRuntime,
} from './sandbox-settings.js'

interface SandboxFixture {
  schemaVersion: number
  initialSettings: Record<string, unknown>
  expectedFinalSettings: Record<string, unknown>
  expectedGlobWarnings: string[]
}

const fixturePath = resolve(
  process.cwd(),
  'test/fixtures/native/tui/sandbox-settings.json',
)

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('TUI sandbox settings native fixture', () => {
  it('persists bounded mutations and fails closed without replacing malformed settings', async () => {
    const fixture = JSON.parse(
      await readFile(fixturePath, 'utf8'),
    ) as SandboxFixture
    const root = await mkdtemp(join(tmpdir(), 'praxis-tui-sandbox-'))
    temporaryRoots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const homeDirectory = join(root, 'home')
    const localSettingsPath = join(cwd, '.praxis', 'settings.local.json')
    await Promise.all([
      mkdir(configRoot, { recursive: true }),
      mkdir(join(cwd, '.praxis'), { recursive: true }),
      mkdir(homeDirectory, { recursive: true }),
    ])
    await writeFile(
      localSettingsPath,
      `${JSON.stringify(fixture.initialSettings, null, 2)}\n`,
    )

    const initialized: Array<{
      enabled: boolean
      autoAllowBashIfSandboxed: boolean
      allowUnsandboxedCommands: boolean
      excludedCommands: readonly string[]
    }> = []
    const dependencies: SandboxDependencyCheck = { errors: [], warnings: [] }
    const runtime: TuiSandboxRuntime = {
      async initialize(settings) {
        initialized.push({
          enabled: settings.enabled,
          autoAllowBashIfSandboxed: settings.autoAllowBashIfSandboxed,
          allowUnsandboxedCommands: settings.allowUnsandboxedCommands,
          excludedCommands: [...settings.excludedCommands],
        })
      },
      unavailableReason: () => undefined,
      platformName: () => 'linux',
      dependencyCheck: () => dependencies,
      isSupportedPlatform: () => true,
    }
    const store = createTuiSandboxStore({
      configRoot,
      cwd,
      homeDirectory,
      runtime,
    })

    const initial = await store.load()
    expect(initial.settings.enabled).toBe(false)
    expect(initial.settings.autoAllowBashIfSandboxed).toBe(false)
    expect(initial.globPatternWarnings).toEqual(fixture.expectedGlobWarnings)

    const autoAllow = await store.setMode('auto-allow')
    expect(autoAllow.settings.enabled).toBe(true)
    expect(autoAllow.settings.autoAllowBashIfSandboxed).toBe(true)
    expect(autoAllow.globPatternWarnings).toEqual(fixture.expectedGlobWarnings)

    const regular = await store.setAllowUnsandboxedCommands(false)
    expect(regular.settings.allowUnsandboxedCommands).toBe(false)
    expect(regular.settings.excludedCommands).toEqual(['docker:*'])

    const excluded = await store.exclude(" 'git *' ")
    expect(excluded.pattern).toBe('git *')
    expect(excluded.snapshot.settings.excludedCommands).toEqual([
      'docker:*',
      'git *',
    ])
    const duplicate = await store.exclude(" 'git *' ")
    expect(duplicate.snapshot.settings.excludedCommands).toEqual([
      'docker:*',
      'git *',
    ])

    expect(JSON.parse(await readFile(localSettingsPath, 'utf8'))).toEqual(
      fixture.expectedFinalSettings,
    )
    expect(initialized).toEqual([
      {
        enabled: false,
        autoAllowBashIfSandboxed: false,
        allowUnsandboxedCommands: true,
        excludedCommands: ['docker:*'],
      },
      {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: true,
        excludedCommands: ['docker:*'],
      },
      {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        excludedCommands: ['docker:*'],
      },
      {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        excludedCommands: ['docker:*', 'git *'],
      },
      {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        excludedCommands: ['docker:*', 'git *'],
      },
    ])

    const assertBytesPreserved = async (
      contents: string,
      operation: () => Promise<unknown>,
      message: string,
    ) => {
      await writeFile(localSettingsPath, contents)
      await expect(operation()).rejects.toThrow(message)
      expect(await readFile(localSettingsPath, 'utf8')).toBe(contents)
    }
    await assertBytesPreserved(
      '{"sandbox":{"excludedCommands":[]}}\n',
      () => store.exclude('""'),
      'Please provide a command pattern to exclude',
    )
    await assertBytesPreserved(
      '{"sandbox":{"excludedCommands":[]}}\n',
      () => store.exclude('   '),
      'Please provide a command pattern to exclude',
    )
    await assertBytesPreserved(
      '{"sandbox":null}\n',
      () => store.setMode('regular'),
      'sandbox must be an object',
    )
    await assertBytesPreserved(
      '{"sandbox":{"excludedCommands":[42]}}\n',
      () => store.exclude('git *'),
      'sandbox.excludedCommands must be an array of strings',
    )
  })
})
