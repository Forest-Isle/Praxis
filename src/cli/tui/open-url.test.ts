import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { openTuiUrl } from './open-url.js'

type OpenUrlFixture = {
  schemaVersion: number
  accepted: Array<{
    platform: NodeJS.Platform
    url: string
    canonicalUrl: string
    command: string
    args: string[]
    options: { timeout: number; shell: false }
  }>
  rejected: Array<{ url: string; error: string }>
}

describe('openTuiUrl native fixture', () => {
  it('validates URLs and invokes each platform opener without a shell', async () => {
    const fixture = JSON.parse(
      await readFile(
        resolve(process.cwd(), 'test/fixtures/native/tui/open-url.json'),
        'utf8',
      ),
    ) as OpenUrlFixture
    expect(fixture.schemaVersion).toBe(1)
    for (const accepted of fixture.accepted) {
      const executor = vi.fn((_command, _args, _options, callback) =>
        callback(null),
      )
      await openTuiUrl(accepted.url, {
        platform: accepted.platform,
        execFile: executor,
      })
      expect(executor).toHaveBeenCalledOnce()
      expect(executor).toHaveBeenCalledWith(
        accepted.command,
        accepted.args,
        accepted.options,
        expect.any(Function),
      )
      expect(executor.mock.calls[0]?.[1]).toEqual(accepted.args)
      expect(executor.mock.calls[0]?.[1]?.at(-1)).toBe(accepted.canonicalUrl)
    }
    for (const rejected of fixture.rejected) {
      const executor = vi.fn()
      await expect(
        openTuiUrl(rejected.url, { platform: 'linux', execFile: executor }),
      ).rejects.toThrow(rejected.error)
      expect(executor).not.toHaveBeenCalled()
    }
    const executorError = new Error('launcher failed')
    const firstAccepted = fixture.accepted[0]
    if (!firstAccepted) throw new Error('Fixture has no accepted URL')
    const executor = vi.fn((_command, _args, _options, callback) =>
      callback(executorError),
    )
    await expect(
      openTuiUrl(firstAccepted.url, {
        platform: firstAccepted.platform,
        execFile: executor,
      }),
    ).rejects.toBe(executorError)
  })
})
