import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { resolveNativePaths } from '../native/paths.js'
import type { ModelProvider } from '../core/runtime.js'
import { ModelPricingRegistry, usageCostUsd } from '../core/usage.js'
import { ClaudeCostStateStore } from '../persistence/claude-cost-state-store.js'
import { ClaudeSessionService } from './session-service.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('ClaudeSessionService cost lifecycle', () => {
  it('admits and records a priced terminal one-million-token model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-session-cost-lifecycle-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    await mkdir(cwd, { recursive: true })
    const statePath = join(root, '.claude.json')
    const sessionId = '21212121-2121-4121-8121-212121212121'
    const model = 'claude-sonnet-5[1m]'
    const projectIdentity = await realpath(cwd)
    const store = new ClaudeCostStateStore({ statePath, projectIdentity })
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: false },
      model,
      async *complete() {
        yield { type: 'text-delta', delta: 'fixture answer' }
        yield { type: 'usage', usage: { inputTokens: 1000, outputTokens: 500 } }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      pricing: new ModelPricingRegistry(),
      maxBudgetUsd: 0.01,
      sessionPersistence: true,
      costStateStore: store,
    })

    await service.run('hello', undefined, sessionId)

    const snapshot = await service.costSnapshot(sessionId)
    expect(snapshot.hasUnknownModelCost).toBe(false)
    expect(snapshot.totalCostUsd).toBeCloseTo(0.007)
    await service.close()
  })

  it('restores and saves the native state project slot with a persisted transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-session-cost-lifecycle-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    await mkdir(cwd, { recursive: true })
    const statePath = join(root, '.claude.json')
    const sessionId = '20202020-2020-4020-8020-202020202020'
    const model = 'fixture-cost-model'
    const projectIdentity = await realpath(cwd)

    // Seed unrelated native data that must survive the cost save: a foreign
    // top-level field, a foreign project record, and foreign keys inside the
    // target project record.
    await writeFile(
      statePath,
      JSON.stringify({
        version: 9,
        projects: {
          'other-project': { keep: true },
          [projectIdentity]: {
            displayName: 'My Project',
            customKey: 'untouched',
          },
        },
      }),
    )

    const store = new ClaudeCostStateStore({ statePath, projectIdentity })
    const pricing = new ModelPricingRegistry({
      [model]: { inputPerMillionUsd: 1, outputPerMillionUsd: 2 },
    })
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: false },
      model,
      async *complete() {
        yield { type: 'text-delta', delta: 'fixture answer' }
        yield { type: 'usage', usage: { inputTokens: 1000, outputTokens: 500 } }
      },
    }
    const service = new ClaudeSessionService({
      configRoot,
      cwd,
      claudeVersion: '2.1.208',
      provider,
      pricing,
      sessionPersistence: true,
      costStateStore: store,
    })

    const run = await service.run('hello', undefined, sessionId)
    expect(run.sessionId).toBe(sessionId)

    const snapshot = await service.costSnapshot(sessionId)
    const expectedCostUsd = usageCostUsd(
      { inputTokens: 1000, outputTokens: 500 },
      { inputPerMillionUsd: 1, outputPerMillionUsd: 2 },
    )
    expect(snapshot.hasUnknownModelCost).toBe(false)
    expect(snapshot.totalCostUsd).toBe(expectedCostUsd)
    expect(snapshot.modelUsage[model]).toEqual({
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUsd: expectedCostUsd,
    })

    await service.close()
    const afterFirstClose = await readFile(statePath, 'utf8')
    await service.close()
    const afterSecondClose = await readFile(statePath, 'utf8')
    expect(afterSecondClose).toBe(afterFirstClose)

    const parsed = JSON.parse(afterSecondClose) as {
      version: number
      projects: Record<string, Record<string, unknown>>
    }
    expect(parsed.version).toBe(9)
    expect(parsed.projects['other-project']).toEqual({ keep: true })
    const project = parsed.projects[projectIdentity]
    if (project === undefined) {
      throw new Error(
        `expected native state to contain project ${projectIdentity}`,
      )
    }
    expect(project.displayName).toBe('My Project')
    expect(project.customKey).toBe('untouched')
    expect(project.lastSessionId).toBe(sessionId)
    expect(project.lastCost).toBe(snapshot.totalCostUsd)
    expect(project.lastAPIDuration).toBe(snapshot.apiDurationMs)
    expect(project.lastAPIDurationWithoutRetries).toBe(
      snapshot.apiDurationWithoutRetriesMs,
    )
    expect(project.lastToolDuration).toBe(snapshot.toolDurationMs)
    expect(project.lastLinesAdded).toBe(snapshot.linesAdded)
    expect(project.lastLinesRemoved).toBe(snapshot.linesRemoved)
    expect(project.lastTotalInputTokens).toBe(1000)
    expect(project.lastTotalOutputTokens).toBe(500)
    expect(project.lastModelUsage).toEqual({
      [model]: {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: snapshot.totalCostUsd,
      },
    })

    const { sessionFile } = resolveNativePaths({
      configDir: configRoot,
      cwd,
      sessionId,
    })
    await expect(stat(sessionFile)).resolves.toMatchObject({
      isFile: expect.any(Function),
    })

    const reopened = new ClaudeCostStateStore({ statePath, projectIdentity })
    const restored = await reopened.load(sessionId)
    if (restored === null) {
      throw new Error(
        'expected a fresh store to restore the persisted session cost state',
      )
    }
    expect(restored.sessionId).toBe(snapshot.sessionId)
    expect(restored.totalCostUsd).toBe(snapshot.totalCostUsd)
    expect(restored.apiDurationMs).toBe(snapshot.apiDurationMs)
    expect(restored.apiDurationWithoutRetriesMs).toBe(
      snapshot.apiDurationWithoutRetriesMs,
    )
    expect(restored.toolDurationMs).toBe(snapshot.toolDurationMs)
    expect(restored.linesAdded).toBe(snapshot.linesAdded)
    expect(restored.linesRemoved).toBe(snapshot.linesRemoved)
    expect(restored.modelUsage).toEqual(snapshot.modelUsage)
    expect(restored.wallDurationMs).toBeGreaterThanOrEqual(
      snapshot.wallDurationMs,
    )
  })
})
