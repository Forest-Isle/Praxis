import { realpath } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import { resolveProjectIdentity } from './project-identity.js'
import { sanitizeProjectPath } from './project-path-key.js'

export interface ResolveProjectMemoryDirectoryOptions {
  dataPlane?: 'native'
  configRoot: string
  cwd: string
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolve(path)
    throw error
  }
}

export async function resolveProjectMemoryDirectory({
  dataPlane: _dataPlane,
  configRoot,
  cwd,
}: ResolveProjectMemoryDirectoryOptions): Promise<string> {
  void _dataPlane
  const [root, identity] = await Promise.all([
    canonicalPath(configRoot),
    resolveProjectIdentity(cwd),
  ])
  const key = sanitizeProjectPath(identity)
  return join(root, 'memory', key)
}

export function resolveProjectMemoryStatePath(options: {
  dataPlane: 'native'
  configRoot: string
  memoryDirectory: string
}): string {
  return join(
    resolve(options.configRoot),
    'state',
    'project-memory',
    basename(options.memoryDirectory),
    'cursor.json',
  )
}
