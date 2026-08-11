import { describe, expect, it, vi } from 'vitest'

import {
  createTuiOsc52ClipboardWriter,
  createTuiClipboardReader,
  createTuiClipboardWriter,
  parseMacPngClipboard,
  type TuiClipboardCommandRunner,
  type TuiClipboardWriteCommandRunner,
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

  it('writes text through native clipboard commands with Linux fallback', async () => {
    const calls: string[] = []
    const runner = vi.fn<TuiClipboardWriteCommandRunner>(
      async (command, args, input) => {
        calls.push(`${command}:${args.join(' ')}:${input}`)
        if (command === 'wl-copy') throw new Error('unavailable')
      },
    )
    await expect(
      createTuiClipboardWriter({ platform: 'linux', runner })('answer'),
    ).resolves.toBeUndefined()
    expect(calls).toEqual([
      'wl-copy:--type text/plain;charset=utf-8:answer',
      'xclip:-selection clipboard -in:answer',
    ])
  })

  it('fails clearly when the platform has no clipboard writer', async () => {
    await expect(
      createTuiClipboardWriter({ platform: 'aix' })('answer'),
    ).rejects.toThrow('Clipboard is unavailable')
  })

  it('writes bounded UTF-8 text through OSC 52', async () => {
    const sequences: string[] = []
    const writer = createTuiOsc52ClipboardWriter((sequence) =>
      sequences.push(sequence),
    )

    await expect(writer('SIDE ✓')).resolves.toBeUndefined()
    expect(sequences).toEqual([
      `\u001B]52;c;${Buffer.from('SIDE ✓').toString('base64')}\u0007`,
    ])

    sequences.length = 0
    await expect(writer('a'.repeat(8 * 1024 * 1024 + 1))).rejects.toThrow(
      'exceeds the supported size limit',
    )
    expect(sequences).toEqual([])
  })
})
