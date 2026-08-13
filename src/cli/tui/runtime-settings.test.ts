import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  applyRuntimeSettingDefaults,
  loadRuntimeSettings,
  projectRuntimeSettings,
  runtimeSettingsSystemPrompt,
} from './runtime-settings.js'
import { DEFAULT_CLI_CONTROLS } from '../controls.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('Claude config runtime projection', () => {
  it('projects all 30 captured settings with their native defaults', () => {
    const settings = projectRuntimeSettings({ settings: {}, state: {} })

    expect(Object.keys(settings)).toHaveLength(31)
    expect(settings).toMatchObject({
      tui: 'default',
      autoCompact: true,
      thinking: true,
      checkpoints: true,
      workflows: true,
      permissionMode: 'default',
      gitignore: true,
      theme: 'auto',
      outputStyle: 'default',
      language: 'default',
      model: 'default',
    })
  })

  it('loads settings and state from distinct native locations', async () => {
    const container = await mkdtemp(join(tmpdir(), 'praxis-runtime-settings-'))
    roots.push(container)
    const configRoot = join(container, 'config')
    const statePath = join(container, '.claude.json')
    await mkdir(configRoot)
    await writeFile(
      join(configRoot, 'settings.json'),
      JSON.stringify({
        autoCompactEnabled: false,
        alwaysThinkingEnabled: false,
        permissions: { defaultMode: 'plan' },
        outputStyle: 'Learning',
        language: 'Japanese',
        model: 'opus',
      }),
    )
    await writeFile(
      statePath,
      JSON.stringify({ respectGitignore: false, copyFullResponse: true }),
    )

    await expect(
      loadRuntimeSettings({ configRoot, statePath }),
    ).resolves.toMatchObject({
      autoCompact: false,
      thinking: false,
      permissionMode: 'plan',
      gitignore: false,
      copyFullResponse: true,
      outputStyle: 'Learning',
      language: 'Japanese',
      model: 'opus',
    })
  })

  it('projects output style and language into model-visible instructions', () => {
    const defaults = projectRuntimeSettings({ settings: {}, state: {} })
    expect(runtimeSettingsSystemPrompt(defaults)).toBeUndefined()

    expect(
      runtimeSettingsSystemPrompt({
        ...defaults,
        outputStyle: 'Explanatory',
        language: 'Chinese',
      }),
    ).toBe(
      "Output style: Explanatory. Adapt explanations and initiative to this style.\nRespond in the user's configured language: Chinese.",
    )
  })

  it('applies startup defaults while preserving explicit CLI controls', () => {
    const settings = {
      ...projectRuntimeSettings({ settings: {}, state: {} }),
      model: 'opus',
      permissionMode: 'plan' as const,
      thinking: false,
    }
    expect(
      applyRuntimeSettingDefaults(DEFAULT_CLI_CONTROLS, settings),
    ).toMatchObject({
      model: 'opus',
      permissionMode: 'plan',
      thinking: 'disabled',
    })
    expect(
      applyRuntimeSettingDefaults(
        {
          ...DEFAULT_CLI_CONTROLS,
          model: 'explicit-model',
          permissionMode: 'acceptEdits',
          thinking: 'adaptive',
        },
        settings,
      ),
    ).toMatchObject({
      model: 'explicit-model',
      permissionMode: 'acceptEdits',
      thinking: 'adaptive',
    })
  })

  it('projects every previously interactive setting into a concrete runtime value', () => {
    const settings = projectRuntimeSettings({
      settings: {
        spinnerTipsEnabled: false,
        prefersReducedMotion: true,
        awaySummaryEnabled: false,
        workflowKeywordTriggerEnabled: false,
        verbose: true,
        terminalProgressBarEnabled: false,
        showTurnDuration: false,
        useAutoModeDuringPlan: false,
        editorMode: 'vim',
        askUserQuestionTimeout: '60s',
        autoUpdatesChannel: 'stable',
        preferredNotifChannel: 'terminal_bell',
      },
      state: {
        workflowSizeGuideline: 'small',
        copyFullResponse: true,
        defaultToAgentsView: true,
        leftArrowOpensAgents: false,
        externalEditorContext: true,
        prStatusFooterEnabled: false,
      },
    })
    expect(settings).toMatchObject({
      tips: false,
      reduceMotion: true,
      recap: false,
      workflowKeywordTriggerEnabled: false,
      workflowSizeGuideline: 'small',
      verbose: true,
      progressBar: false,
      turnDuration: false,
      useAutoModeDuringPlan: false,
      copyFullResponse: true,
      defaultToAgentsView: true,
      leftArrowOpensAgents: false,
      autoUpdatesChannel: 'stable',
      notifChannel: 'terminal_bell',
      editor: 'vim',
      askUserQuestionTimeout: '60s',
      externalEditorContext: true,
      prStatus: false,
    })
  })
})
