import { describe, expect, it, vi } from 'vitest'

import type { WorkspaceTrustInventory } from '../security/workspace-trust.js'
import {
  createWorkspaceTrustDecisionCache,
  promptWorkspaceTrust,
} from './workspace-trust-prompt.js'

const inventory: WorkspaceTrustInventory = {
  canonicalPath: '/workspace/project',
  fingerprint: 'a'.repeat(64),
  origins: [
    {
      kind: 'hook',
      scope: 'project',
      path: '/workspace/project/.praxis/settings.json',
      label: 'SessionStart',
    },
    {
      kind: 'mcp',
      scope: 'local',
      path: '/workspace/project/.praxis/mcp.local.json',
      label: 'database',
    },
  ],
}

async function* input(...values: string[]): AsyncIterable<string> {
  yield* values
}

describe('workspace trust prompt', () => {
  it('caches acceptance and rejection by canonical path plus fingerprint', async () => {
    const decide = vi.fn(async () => false)
    const cached = createWorkspaceTrustDecisionCache(decide)
    await expect(cached(inventory)).resolves.toBe(false)
    await expect(cached(inventory)).resolves.toBe(false)
    await expect(
      cached({ ...inventory, fingerprint: 'b'.repeat(64) }),
    ).resolves.toBe(false)
    await expect(
      cached({ ...inventory, canonicalPath: '/workspace/other' }),
    ).resolves.toBe(false)
    expect(decide).toHaveBeenCalledTimes(3)
  })

  it('does not cache a failed decision attempt', async () => {
    const decide = vi
      .fn<(value: WorkspaceTrustInventory) => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('prompt failed'))
      .mockResolvedValueOnce(true)
    const cached = createWorkspaceTrustDecisionCache(decide)
    await expect(cached(inventory)).rejects.toThrow('prompt failed')
    await expect(cached(inventory)).resolves.toBe(true)
    expect(decide).toHaveBeenCalledTimes(2)
  })

  it.each(['y', 'Y', 'yes', ' YES '])('accepts explicit %j', async (answer) => {
    await expect(
      promptWorkspaceTrust(inventory, {
        input: input(answer),
        output: () => {},
      }),
    ).resolves.toBe(true)
  })

  it.each(['', 'n', 'no', 'later', 'yes please'])(
    'rejects non-acceptance %j',
    async (answer) => {
      await expect(
        promptWorkspaceTrust(inventory, {
          input: input(answer),
          output: () => {},
        }),
      ).resolves.toBe(false)
    },
  )

  it('defaults to reject on EOF', async () => {
    await expect(
      promptWorkspaceTrust(inventory, { input: input(), output: () => {} }),
    ).resolves.toBe(false)
  })

  it('shows only canonical origin metadata and sanitizes terminal controls', async () => {
    const output: string[] = []
    const firstOrigin = inventory.origins[0]
    if (!firstOrigin) throw new Error('Missing workspace trust origin fixture')
    await promptWorkspaceTrust(
      {
        ...inventory,
        canonicalPath: '/workspace/\u001b[31m\u202eproject',
        origins: [
          {
            ...firstOrigin,
            label: 'SessionStart\u0007',
          },
        ],
      },
      { input: input('no'), output: (text) => output.push(text) },
    )
    const rendered = output.join('')
    expect(rendered).toContain('/workspace/?[31m?project')
    expect(rendered).toContain('hook (project)')
    expect(rendered).toContain('SessionStart?')
    expect(rendered).toContain('[y/N]')
    expect(rendered).not.toContain('\u001b')
    expect(rendered).not.toContain(inventory.fingerprint)
  })

  it('defaults to reject when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      promptWorkspaceTrust(inventory, {
        input: input('yes'),
        output: () => {},
        signal: controller.signal,
      }),
    ).resolves.toBe(false)
  })

  it('defaults to reject when a pending read is aborted', async () => {
    const controller = new AbortController()
    const waiting: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<string>>(() => {}),
        }
      },
    }
    const result = promptWorkspaceTrust(inventory, {
      input: waiting,
      output: () => {},
      signal: controller.signal,
    })
    controller.abort()
    await expect(result).resolves.toBe(false)
  })
})
