export function commandShell(platform: NodeJS.Platform = process.platform) {
  if (platform === 'darwin') return '/bin/zsh'
  if (platform === 'linux') return '/bin/bash'
  throw new Error(
    `Praxis command execution is unsupported on platform ${platform}`,
  )
}
