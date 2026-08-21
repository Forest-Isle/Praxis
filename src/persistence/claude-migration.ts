import { randomUUID } from 'node:crypto'
import {
  cp,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
} from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'

const COPY_DIRECTORIES = [
  { source: 'projects', destination: 'sessions' },
  { source: 'tasks', destination: 'tasks' },
  { source: 'file-history', destination: 'file-history' },
] as const

interface MigrationOperation {
  label: string
  source: string
  destination: string
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}

async function assertSourceTree(path: string): Promise<void> {
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink()) {
    throw new Error(`Praxis migration refuses symbolic link source: ${path}`)
  }
  if (!metadata.isDirectory()) return
  const entries = await readdir(path)
  await Promise.all(entries.map((entry) => assertSourceTree(join(path, entry))))
}

async function sourceDirectory(path: string): Promise<boolean> {
  let metadata
  try {
    metadata = await lstat(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
  if (metadata.isSymbolicLink()) {
    throw new Error(`Praxis migration refuses symbolic link source: ${path}`)
  }
  if (!metadata.isDirectory()) {
    throw new Error(`Praxis migration source must be a directory: ${path}`)
  }
  await assertSourceTree(path)
  return true
}

async function migrationOperations(
  sourceRoot: string,
  destinationRoot: string,
): Promise<MigrationOperation[]> {
  const operations: MigrationOperation[] = []
  for (const mapping of COPY_DIRECTORIES) {
    const source = join(sourceRoot, mapping.source)
    if (!(await sourceDirectory(source))) continue
    operations.push({
      label: mapping.source,
      source,
      destination: join(destinationRoot, mapping.destination),
    })
  }
  const projects = join(sourceRoot, 'projects')
  if (await exists(projects)) {
    const entries = await readdir(projects, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const source = join(projects, entry.name, 'memory')
      if (!(await sourceDirectory(source))) continue
      operations.push({
        label: 'memory',
        source,
        destination: join(destinationRoot, 'memory', entry.name),
      })
    }
  }
  return operations
}

async function missingDirectories(path: string): Promise<string[]> {
  const missing: string[] = []
  let current = path
  while (!(await exists(current))) {
    missing.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return missing
}

function commonAncestor(left: string, right: string): string {
  let candidate = resolve(left)
  const target = resolve(right)
  for (;;) {
    const child = relative(candidate, target)
    if (child === '' || (!child.startsWith('..') && !isAbsolute(child))) {
      return candidate
    }
    const parent = dirname(candidate)
    if (parent === candidate) return parent
    candidate = parent
  }
}

function pathContains(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate))
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

async function physicalPath(path: string): Promise<string> {
  const absolute = resolve(path)
  let existing = absolute
  for (;;) {
    try {
      await lstat(existing)
      break
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
      const parent = dirname(existing)
      if (parent === existing) break
      existing = parent
    }
  }
  return resolve(await realpath(existing), relative(existing, absolute))
}

async function assertDestinationAncestors(
  path: string,
  boundary: string,
): Promise<void> {
  const ancestors: string[] = []
  let current = resolve(path)
  for (;;) {
    ancestors.push(current)
    if (current === boundary) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  for (const ancestor of ancestors.reverse()) {
    let metadata
    try {
      metadata = await lstat(ancestor)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue
      throw error
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(
        `Praxis migration refuses symbolic link destination: ${ancestor}`,
      )
    }
  }
}

export async function migrateClaudeData(options: {
  sourceRoot: string
  destinationRoot: string
}): Promise<readonly string[]> {
  const sourceRoot = resolve(options.sourceRoot)
  const destinationRoot = resolve(options.destinationRoot)
  if (
    pathContains(sourceRoot, destinationRoot) ||
    pathContains(destinationRoot, sourceRoot)
  ) {
    throw new Error('Claude source and Praxis destination must not overlap')
  }
  const [physicalSourceRoot, physicalDestinationRoot] = await Promise.all([
    physicalPath(sourceRoot),
    physicalPath(destinationRoot),
  ])
  if (
    pathContains(physicalSourceRoot, physicalDestinationRoot) ||
    pathContains(physicalDestinationRoot, physicalSourceRoot)
  ) {
    throw new Error('Claude source and Praxis destination must not overlap')
  }
  if (
    (await exists(sourceRoot)) &&
    (await lstat(sourceRoot)).isSymbolicLink()
  ) {
    throw new Error(
      `Praxis migration refuses symbolic link source: ${sourceRoot}`,
    )
  }
  const destinationBoundary = commonAncestor(sourceRoot, destinationRoot)
  await assertDestinationAncestors(destinationRoot, destinationBoundary)
  const operations = await migrationOperations(sourceRoot, destinationRoot)
  await Promise.all(
    operations.map((operation) =>
      assertDestinationAncestors(operation.destination, destinationBoundary),
    ),
  )
  for (const operation of operations) {
    if (await exists(operation.destination)) {
      throw new Error(
        `Praxis migration destination already exists: ${operation.destination}`,
      )
    }
  }
  if (operations.length === 0) return []

  const stagingRoot = join(
    dirname(destinationRoot),
    `.${basename(destinationRoot)}.migration-${randomUUID()}`,
  )
  const published: string[] = []
  const createdDirectories = new Set<string>()
  try {
    await mkdir(stagingRoot, { recursive: false })
    for (const [index, operation] of operations.entries()) {
      await cp(operation.source, join(stagingRoot, String(index)), {
        recursive: true,
        errorOnExist: true,
      })
    }
    for (const [index, operation] of operations.entries()) {
      const parent = dirname(operation.destination)
      for (const path of await missingDirectories(parent)) {
        createdDirectories.add(path)
      }
      await mkdir(parent, { recursive: true })
      await rename(join(stagingRoot, String(index)), operation.destination)
      published.push(operation.destination)
    }
  } catch (error) {
    await Promise.all(
      published.map((path) => rm(path, { recursive: true, force: true })),
    )
    for (const path of [...createdDirectories].sort(
      (left, right) => right.length - left.length,
    )) {
      await rmdir(path).catch((cleanupError) => {
        if (!['ENOENT', 'ENOTEMPTY'].includes(errorCode(cleanupError) ?? '')) {
          throw cleanupError
        }
      })
    }
    throw error
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
  return [...new Set(operations.map((operation) => operation.label))]
}
