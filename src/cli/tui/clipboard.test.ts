import { describe, expect, it, vi } from 'vitest'

import {
  createTuiClipboardReader,
  parseMacPngClipboard,
  type TuiClipboardCommandRunner,
} from './clipboard.js'

describe('TUI clipboard', () => {
  it('parses the native macOS PNG clipboard representation', () => {
    expect(parseMacPngClipboard(Buffer.from('«data PNGf89504E47»\n'))).toEqual({
      type: 'image',
      mediaType: 'image/png',
      data: Buffer.from('89504e47', 'hex').toString('base64'),
    })
    expect(() => parseMacPngClipboard(Buffer.from('not png'))).toThrow(
      'malformed PNG data',
    )
  })

  it('prefers a macOS image and falls back to text', async () => {
    const imageRunner = vi.fn<TuiClipboardCommandRunner>(async (command) => {
      if (command === 'osascript') return Buffer.from('«data PNGf89504E47»')
      throw new Error('unexpected fallback')
    })
    await expect(
      createTuiClipboardReader({
        platform: 'darwin',
        runner: imageRunner,
      })(),
    ).resolves.toEqual({
      kind: 'image',
      image: {
        type: 'image',
        mediaType: 'image/png',
        data: Buffer.from('89504e47', 'hex').toString('base64'),
      },
    })

    const textRunner = vi.fn<TuiClipboardCommandRunner>(async (command) => {
      if (command === 'osascript') throw new Error('no image')
      return Buffer.from('clipboard text')
    })
    await expect(
      createTuiClipboardReader({
        platform: 'darwin',
        runner: textRunner,
      })(),
    ).resolves.toEqual({ kind: 'text', text: 'clipboard text' })
  })

  it('uses Linux image and text clipboard fallbacks', async () => {
    const image = Buffer.from('png')
    const runner = vi.fn<TuiClipboardCommandRunner>(async (command, args) => {
      if (command === 'wl-paste' && args.includes('image/png')) return image
      throw new Error('unavailable')
    })
    await expect(
      createTuiClipboardReader({ platform: 'linux', runner })(),
    ).resolves.toEqual({
      kind: 'image',
      image: {
        type: 'image',
        mediaType: 'image/png',
        data: image.toString('base64'),
      },
    })
  })

  it('does not hide clipboard command timeouts as empty content', async () => {
    const timeout = Object.assign(new Error('timed out'), { killed: true })
    await expect(
      createTuiClipboardReader({
        platform: 'darwin',
        runner: async () => {
          throw timeout
        },
      })(),
    ).rejects.toThrow('Clipboard command timed out')
  })
})
