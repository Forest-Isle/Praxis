export function commandShell(platform: NodeJS.Platform = process.platform) {
  if (platform === 'darwin') return '/bin/zsh'
  if (platform === 'linux') return '/bin/bash'
  throw new Error(
    `Praxis command execution is unsupported on platform ${platform}`,
  )
}

export function commandShellArguments(
  command: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === 'darwin') return ['-f', '-c', command]
  if (platform === 'linux') return ['--noprofile', '--norc', '-c', command]
  throw new Error(
    `Praxis command execution is unsupported on platform ${platform}`,
  )
}
