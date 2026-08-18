import { realpathSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'

export interface BypassImmuneWriteOptions {
  homeDirectory: string
  configRoot: string
}

const SECRET_BASENAMES: ReadonlySet<string> = new Set([
  'authorized_keys',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  'credentials',
])

function canonicalize(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

function isWithin(root: string, target: string): boolean {
  const relativePath = relative(resolve(root), resolve(target))
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  )
}

export function bypassImmuneWriteReason(
  path: string,
  options: BypassImmuneWriteOptions,
): string | undefined {
  const resolvedPath = canonicalize(path)
  const homeDirectory = canonicalize(options.homeDirectory)
  const configRoot = canonicalize(options.configRoot)

  const sshDirectory = join(homeDirectory, '.ssh')
  if (isWithin(sshDirectory, resolvedPath)) {
    return `path '${resolvedPath}' is inside the SSH key directory '${sshDirectory}'`
  }

  const awsDirectory = join(homeDirectory, '.aws')
  if (isWithin(awsDirectory, resolvedPath)) {
    return `path '${resolvedPath}' is inside the AWS credential directory '${awsDirectory}'`
  }

  const fileName = basename(resolvedPath)
  const normalizedName = fileName.toLocaleLowerCase()
  if (SECRET_BASENAMES.has(normalizedName)) {
    return `path basename '${fileName}' is a protected secret file`
  }
  if (normalizedName === '.env' || normalizedName.startsWith('.env.')) {
    return `path basename '${fileName}' is a protected environment file`
  }
  if (
    isWithin(configRoot, resolvedPath) &&
    (normalizedName === 'settings.json' || normalizedName.endsWith('.jsonl'))
  ) {
    return `path '${resolvedPath}' is inside the Claude/Praxis config directory '${configRoot}'`
  }

  return undefined
}
