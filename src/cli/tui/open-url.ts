import { execFile } from 'node:child_process'

export async function openTuiUrl(url: string): Promise<void> {
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]

  await new Promise<void>((resolvePromise) => {
    execFile(command, args, { timeout: 10_000 }, () => resolvePromise())
  })
}
