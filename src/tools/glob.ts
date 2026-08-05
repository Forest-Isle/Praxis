import { lstat, opendir } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'

import { minimatch } from 'minimatch'

const MAX_RESULTS = 100

export interface GlobFilesOptions {
  root: string
  displayRoot: string
  absoluteRoot: string
  pattern: string
  signal?: AbortSignal
}

interface GlobMatch {
  path: string
  mtimeMs: number
  order: number
}

function abortError(): DOMException {
  return new DOMException('Tool execution aborted', 'AbortError')
}

function portablePath(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/')
}

function compareMatches(left: GlobMatch, right: GlobMatch): number {
  return left.mtimeMs - right.mtimeMs || left.order - right.order
}

function insertOldest(matches: GlobMatch[], candidate: GlobMatch): void {
  let low = 0
  let high = matches.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    const current = matches[middle]
    if (current && compareMatches(current, candidate) <= 0) low = middle + 1
    else high = middle
  }
  matches.splice(low, 0, candidate)
  if (matches.length > MAX_RESULTS) matches.pop()
}

export async function globFiles(options: GlobFilesOptions): Promise<string> {
  const pattern = portablePath(options.pattern)
  const absolutePattern = isAbsolute(options.pattern)
  const matchBase = !absolutePattern && !pattern.includes('/')
  const matches: GlobMatch[] = []
  const directories = ['']
  let matchCount = 0
  let order = 0

  while (directories.length > 0) {
    if (options.signal?.aborted) throw abortError()
    const relativeDirectory = directories.pop() ?? ''
    const directory = await opendir(join(options.root, relativeDirectory))
    for await (const entry of directory) {
      if (options.signal?.aborted) throw abortError()
      const relativePath = join(relativeDirectory, entry.name)
      if (entry.isDirectory()) {
        directories.push(relativePath)
        continue
      }
      if (!entry.isFile()) continue

      const portableRelativePath = portablePath(relativePath)
      const absolutePath = portablePath(
        resolve(options.absoluteRoot, relativePath),
      )
      if (
        pattern !== '' &&
        !minimatch(
          absolutePattern ? absolutePath : portableRelativePath,
          pattern,
          { dot: true, matchBase, noext: true },
        )
      ) {
        continue
      }

      let metadata
      try {
        metadata = await lstat(join(options.root, relativePath))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      if (!metadata.isFile()) continue
      const displayPath = absolutePattern
        ? absolutePath
        : portablePath(join(options.displayRoot, relativePath))
      insertOldest(matches, {
        path: displayPath,
        mtimeMs: metadata.mtimeMs,
        order,
      })
      matchCount += 1
      order += 1
    }
  }

  if (matchCount === 0) return 'No files found'
  const content = matches.map((match) => match.path).join('\n')
  return matchCount > MAX_RESULTS
    ? `${content}\n(Showing ${MAX_RESULTS} of ${matchCount} matching files; ${matchCount - MAX_RESULTS} more are not listed. Narrow the pattern or path to see the rest.)`
    : content
}
