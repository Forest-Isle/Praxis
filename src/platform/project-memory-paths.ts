import { realpath } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import type { ProjectMemoryDataPlane } from '../core/project-memory.js'
import { resolveProjectIdentity } from './project-identity.js'
import { sanitizeProjectPath } from './project-path-key.js'

export interface ResolveProjectMemoryDirectoryOptions {
  dataPlane: ProjectMemoryDataPlane
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
  dataPlane,
  configRoot,
  cwd,
}: ResolveProjectMemoryDirectoryOptions): Promise<string> {
  const [root, identity] = await Promise.all([
    canonicalPath(configRoot),
    resolveProjectIdentity(cwd),
  ])
  const key = sanitizeProjectPath(identity)
  return dataPlane === 'native'
    ? join(root, 'memory', key)
    : join(root, 'projects', key, 'memory')
}

export function resolveProjectMemoryStatePath(options: {
  dataPlane: ProjectMemoryDataPlane
  configRoot: string
  memoryDirectory: string
}): string {
  return join(
    resolve(options.configRoot),
    options.dataPlane === 'native' ? 'state' : 'praxis',
    'project-memory',
    basename(options.memoryDirectory),
    'cursor.json',
  )
}
