import { execFile, spawn } from 'node:child_process'

import type { ModelImage } from '../../core/runtime.js'

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_TEXT_BYTES = 8 * 1024 * 1024

export type TuiClipboardContent =
  | { kind: 'image'; image: ModelImage }
  | { kind: 'text'; text: string }
  | { kind: 'empty' }

export type TuiClipboardCommandRunner = (
  command: string,
  args: readonly string[],
  maxBuffer: number,
) => Promise<Buffer>

export type TuiClipboardWriteCommandRunner = (
  command: string,
  args: readonly string[],
  input: string,
) => Promise<void>

const runClipboardCommand: TuiClipboardCommandRunner = (
  command,
  args,
  maxBuffer,
) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { encoding: null, maxBuffer, timeout: 5_000 },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout))
      },
    )
  })

const runClipboardWriteCommand: TuiClipboardWriteCommandRunner = (
  command,
  args,
  input,
) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ['pipe', 'ignore', 'ignore'],
      shell: false,
    })
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('Clipboard command timed out'))
    }, 5_000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timeout)
      if (code === 0) resolve()
      else reject(new Error(`Clipboard command exited with status ${code}`))
    })
    child.stdin.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.stdin.end(input)
  })

async function optionalCommand(
  runner: TuiClipboardCommandRunner,
  command: string,
  args: readonly string[],
  maxBuffer: number,
): Promise<Buffer | null> {
  try {
    return await runner(command, args, maxBuffer)
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
    ) {
      throw new Error('Clipboard content exceeds the supported size limit', {
        cause: error,
      })
    }
    if (error instanceof Error && 'killed' in error && error.killed) {
      throw new Error('Clipboard command timed out', { cause: error })
    }
    return null
  }
}

export function parseMacPngClipboard(output: Buffer): ModelImage {
  const encoded = output.toString('utf8').trim()
  const match = /^«data PNGf([0-9a-f]+)»$/iu.exec(encoded)
  if (!match?.[1] || match[1].length % 2 !== 0) {
    throw new Error('Clipboard returned malformed PNG data')
  }
  const data = Buffer.from(match[1], 'hex')
  if (data.length === 0 || data.length > MAX_IMAGE_BYTES) {
    throw new Error('Clipboard image exceeds the supported size limit')
  }
  return {
    type: 'image',
    mediaType: 'image/png',
    data: data.toString('base64'),
  }
}

function imageContent(data: Buffer): TuiClipboardContent {
  if (data.length === 0) return { kind: 'empty' }
  if (data.length > MAX_IMAGE_BYTES)
    throw new Error('Clipboard image exceeds the supported size limit')
  return {
    kind: 'image',
    image: {
      type: 'image',
      mediaType: 'image/png',
      data: data.toString('base64'),
    },
  }
}

function textContent(data: Buffer | null): TuiClipboardContent {
  if (!data || data.length === 0) return { kind: 'empty' }
  if (data.length > MAX_TEXT_BYTES)
    throw new Error('Clipboard text exceeds the supported size limit')
  const text = data.toString('utf8')
  return text.length > 0 ? { kind: 'text', text } : { kind: 'empty' }
}

export function createTuiClipboardReader(
  options: {
    platform?: NodeJS.Platform
    runner?: TuiClipboardCommandRunner
  } = {},
): () => Promise<TuiClipboardContent> {
  const platform = options.platform ?? process.platform
  const runner = options.runner ?? runClipboardCommand

  return async () => {
    if (platform === 'darwin') {
      const png = await optionalCommand(
        runner,
        'osascript',
        ['-e', 'the clipboard as «class PNGf»'],
        MAX_IMAGE_BYTES * 2 + 256,
      )
      if (png) return { kind: 'image', image: parseMacPngClipboard(png) }
      return textContent(
        await optionalCommand(runner, 'pbpaste', [], MAX_TEXT_BYTES),
      )
    }

    if (platform === 'linux') {
      const image =
        (await optionalCommand(
          runner,
          'wl-paste',
          ['--no-newline', '--type', 'image/png'],
          MAX_IMAGE_BYTES,
        )) ??
        (await optionalCommand(
          runner,
          'xclip',
          ['-selection', 'clipboard', '-target', 'image/png', '-out'],
          MAX_IMAGE_BYTES,
        ))
      if (image?.length) return imageContent(image)
      const text =
        (await optionalCommand(
          runner,
          'wl-paste',
          ['--no-newline', '--type', 'text/plain;charset=utf-8'],
          MAX_TEXT_BYTES,
        )) ??
        (await optionalCommand(
          runner,
          'xclip',
          ['-selection', 'clipboard', '-out'],
          MAX_TEXT_BYTES,
        ))
      return textContent(text)
    }

    if (platform === 'win32') {
      return textContent(
        await optionalCommand(
          runner,
          'powershell.exe',
          ['-NoProfile', '-Command', 'Get-Clipboard -Raw'],
          MAX_TEXT_BYTES,
        ),
      )
    }

    return { kind: 'empty' }
  }
}

export const readTuiClipboard = createTuiClipboardReader()

export function createTuiClipboardWriter(
  options: {
    platform?: NodeJS.Platform
    runner?: TuiClipboardWriteCommandRunner
  } = {},
): (text: string) => Promise<void> {
  const platform = options.platform ?? process.platform
  const runner = options.runner ?? runClipboardWriteCommand

  return async (text) => {
    const commands: readonly [string, readonly string[]][] =
      platform === 'darwin'
        ? [['pbcopy', []]]
        : platform === 'linux'
          ? [
              ['wl-copy', ['--type', 'text/plain;charset=utf-8']],
              ['xclip', ['-selection', 'clipboard', '-in']],
            ]
          : platform === 'win32'
            ? [
                [
                  'powershell.exe',
                  ['-NoProfile', '-Command', '$input | Set-Clipboard'],
                ],
              ]
            : []
    let lastError: unknown
    for (const [command, args] of commands) {
      try {
        await runner(command, args, text)
        return
      } catch (error) {
        lastError = error
      }
    }
    throw new Error('Clipboard is unavailable', { cause: lastError })
  }
}

export const writeTuiClipboard = createTuiClipboardWriter()
