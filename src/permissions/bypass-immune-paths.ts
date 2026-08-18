import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

export interface ProtectedWriteOptions {
  homeDirectory: string
  configRoot: string
}

const SSH_CREDENTIAL_BASENAMES = new Set([
  'authorized_keys',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
])
const AWS_CREDENTIAL_BASENAMES = new Set(['credentials'])

function isWithin(candidate: string, root: string): boolean {
  const child = relative(resolve(root), resolve(candidate))
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

function pathRepresentations(path: string): readonly string[] {
  const absolute = resolve(path)
  const representations = new Set<string>([absolute])

  let existing = absolute
  for (;;) {
    try {
      realpathSync(existing)
      break
    } catch {
      const parent = dirname(existing)
      if (parent === existing) return [...representations]
      existing = parent
    }
  }
  try {
    representations.add(
      resolve(realpathSync.native(existing), relative(existing, absolute)),
    )
  } catch {
    // A disappearing or inaccessible path retains its lexical representation.
  }
  try {
    representations.add(realpathSync.native(absolute))
  } catch {
    // Non-existent targets are covered by their deepest existing ancestor.
  }
  return [...representations]
}

function lowerBasename(path: string): string {
  const segments = path.split(/[\\/]+/u).filter(Boolean)
  return (segments.at(-1) ?? '').toLowerCase()
}

/**
 * Returns a human-readable rejection reason when a write to `path` targets a
 * bypass-immune protected credential or configuration file, or undefined when
 * the write is not protected. Reads are never affected.
 */
export function protectedWritePathReason(
  path: string,
  options: ProtectedWriteOptions,
): string | undefined {
  const homeDirectory = resolve(options.homeDirectory)
  const configRoot = resolve(options.configRoot)
  const sshDirectory = resolve(homeDirectory, '.ssh')
  const awsDirectory = resolve(homeDirectory, '.aws')
  const sshDirectories = pathRepresentations(sshDirectory)
  const awsDirectories = pathRepresentations(awsDirectory)
  const configRoots = pathRepresentations(configRoot)

  for (const representation of pathRepresentations(path)) {
    const basename = lowerBasename(representation)
    if (sshDirectories.some((root) => isWithin(representation, root))) {
      return `${sshDirectory} is a protected SSH directory`
    }
    if (awsDirectories.some((root) => isWithin(representation, root))) {
      return `${awsDirectory} is a protected AWS credentials directory`
    }
    if (SSH_CREDENTIAL_BASENAMES.has(basename)) {
      return `${basename} is a protected SSH credential file`
    }
    if (AWS_CREDENTIAL_BASENAMES.has(basename)) {
      return `${basename} is a protected AWS credential file`
    }
    if (basename === '.env' || basename.startsWith('.env.')) {
      return '.env and .env.* files are protected'
    }
    if (
      configRoots.some((root) => isWithin(representation, root)) &&
      (basename === 'settings.json' || basename.endsWith('.jsonl'))
    ) {
      return 'settings.json and .jsonl files in the Claude config root are protected'
    }
  }
  return undefined
}
