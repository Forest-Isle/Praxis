import { execFile } from 'node:child_process'

type OpenUrlOptions = { timeout: number; shell: false }
type OpenUrlExecutor = (
  command: string,
  args: string[],
  options: OpenUrlOptions,
  callback: (error?: Error | null) => void,
) => unknown
type OpenUrlDependencies = {
  platform?: NodeJS.Platform
  execFile?: OpenUrlExecutor
}

const defaultExecFile: OpenUrlExecutor = (command, args, options, callback) =>
  execFile(command, args, options, callback)

export async function openTuiUrl(
  url: string,
  dependencies: OpenUrlDependencies = {},
): Promise<void> {
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    throw new Error('TUI URL must be an absolute HTTP(S) URL')
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:')
    throw new Error('TUI URL must be an absolute HTTP(S) URL')

  const canonicalUrl = parsedUrl.href
  const platform = dependencies.platform ?? process.platform
  const command =
    platform === 'darwin'
      ? 'open'
      : platform === 'win32'
        ? 'rundll32.exe'
        : 'xdg-open'
  const args =
    platform === 'win32'
      ? ['url.dll,FileProtocolHandler', canonicalUrl]
      : [canonicalUrl]
  const executor = dependencies.execFile ?? defaultExecFile

  await new Promise<void>((resolvePromise, rejectPromise) => {
    try {
      executor(command, args, { timeout: 10_000, shell: false }, (error) =>
        error == null ? resolvePromise() : rejectPromise(error),
      )
    } catch (error) {
      rejectPromise(error)
    }
  })
}
