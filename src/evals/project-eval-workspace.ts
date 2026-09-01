import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readdir,
  lstat,
  rm,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
export interface FileManifest {
  files: Record<string, { hash: string; size: number; mode: number }>
  totalBytes: number
}
export const MAX_FILES = 10_000
export const MAX_BYTES = 512 * 1024 * 1024
async function hashFile(path: string) {
  const h = createHash('sha256')
  for await (const chunk of createReadStream(path)) h.update(chunk)
  return h.digest('hex')
}
async function manifest(root: string): Promise<FileManifest> {
  const files: FileManifest['files'] = Object.create(
    null,
  ) as FileManifest['files']
  let fileCount = 0
  let totalBytes = 0
  async function walk(dir: string) {
    for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const p = join(dir, e.name),
        s = await lstat(p)
      if (s.isSymbolicLink() || (!s.isFile() && !s.isDirectory()))
        throw new Error(`Unsupported fixture entry: ${relative(root, p)}`)
      if (e.name === '.git' || e.name === 'node_modules')
        throw new Error(
          `Fixture contains forbidden directory: ${relative(root, p)}`,
        )
      if (s.isDirectory()) await walk(p)
      else {
        if (fileCount >= MAX_FILES || totalBytes + s.size > MAX_BYTES)
          throw new Error('Fixture exceeds manifest limits')
        totalBytes += s.size
        fileCount += 1
        files[relative(root, p).replaceAll('\\', '/')] = {
          hash: await hashFile(p),
          size: s.size,
          mode: s.mode & 0o777,
        }
      }
    }
  }
  await walk(root)
  return { files, totalBytes }
}
async function copyTree(source: string, target: string) {
  for (const e of (await readdir(source, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const from = join(source, e.name),
      to = join(target, e.name),
      s = await lstat(from)
    if (s.isSymbolicLink() || (!s.isFile() && !s.isDirectory()))
      throw new Error(`Unsupported fixture entry: ${relative(source, from)}`)
    if (e.name === '.git' || e.name === 'node_modules')
      throw new Error(
        `Fixture contains forbidden directory: ${relative(source, from)}`,
      )
    if (s.isDirectory()) {
      await mkdir(to)
      await copyTree(from, to)
    } else {
      await copyFile(from, to)
      await chmod(to, s.mode & 0o777)
    }
  }
}
export async function createProjectEvalWorkspace(fixture: string) {
  const fixtureStat = await lstat(fixture)
  if (fixtureStat.isSymbolicLink() || !fixtureStat.isDirectory())
    throw new Error('Fixture root must be a directory')
  if (basename(fixture) === '.git' || basename(fixture) === 'node_modules')
    throw new Error('Fixture root is forbidden')
  const root = await mkdtemp(join(tmpdir(), 'praxis-project-eval-'))
  try {
    const cwd = join(root, 'cwd'),
      config = join(root, 'config'),
      home = join(root, 'home'),
      out = join(root, 'out')
    await Promise.all([mkdir(cwd), mkdir(config), mkdir(home), mkdir(out)])
    const sourceBefore = await manifest(fixture)
    await copyTree(fixture, cwd)
    const before = await manifest(cwd)
    const sourceAfter = await manifest(fixture)
    if (
      JSON.stringify(sourceBefore) !== JSON.stringify(sourceAfter) ||
      JSON.stringify(sourceBefore) !== JSON.stringify(before)
    )
      throw new Error('Fixture changed while creating workspace')
    return { root, cwd, config, home, out, before, sourceBefore, manifest }
  } catch (e) {
    await rm(root, { recursive: true, force: true })
    throw e
  }
}
export async function diffProjectEvalWorkspace(
  before: FileManifest,
  after: FileManifest,
) {
  const added: string[] = [],
    modified: string[] = [],
    deleted: string[] = []
  for (const p of Object.keys(after.files)) {
    if (!Object.hasOwn(before.files, p)) added.push(p)
    else if (JSON.stringify(before.files[p]) !== JSON.stringify(after.files[p]))
      modified.push(p)
  }
  for (const p of Object.keys(before.files))
    if (!Object.hasOwn(after.files, p)) deleted.push(p)
  added.sort()
  modified.sort()
  deleted.sort()
  return {
    added,
    modified,
    deleted,
    changed: [...added, ...modified, ...deleted].sort(),
  }
}
export async function cleanupProjectEvalWorkspace(root: string) {
  await rm(root, { recursive: true, force: true })
}
