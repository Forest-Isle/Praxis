import { spawn } from 'node:child_process'
import { mkdir, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'

import {
  loadClaudeContextResources,
  loadClaudeSettings,
  resolveClaudeProjectMemoryDirectory,
  type ClaudeResourceScope,
  type ClaudeTextResource,
} from '../../compatibility/claude/shared-resources.js'

export interface TuiMemoryFileEntry {
  kind: 'file' | 'folder'
  label: string
  path: string
  displayPath: string
  annotation?: string
  scope: ClaudeResourceScope
  imported?: true
}

export interface TuiMemoryFiles {
  autoMemoryEnabled: boolean
  entries: readonly TuiMemoryFileEntry[]
}

export interface LoadTuiMemoryFilesOptions {
  configRoot: string
  cwd: string
  homeDirectory?: string
}

function isWithin(root: string, path: string): boolean {
  const value = relative(root, path)
  return value === '' || (!value.startsWith('..') && !isAbsolute(value))
}

export function displayTuiMemoryPath(
  path: string,
  cwd: string,
  homeDirectory = homedir(),
): string {
  const absolute = resolve(path)
  const home = resolve(homeDirectory)
  if (isWithin(home, absolute)) {
    const suffix = relative(home, absolute)
    return suffix ? `~/${suffix}` : '~'
  }
  if (isWithin(resolve(cwd), absolute)) {
    const suffix = relative(resolve(cwd), absolute)
    return suffix ? `./${suffix}` : '.'
  }
  return absolute
}

function isMemoryInstruction(resource: ClaudeTextResource): boolean {
  return /^CLAUDE(?:\.local)?\.md$/u.test(basename(resource.path))
}

function importedPaths(
  resource: ClaudeTextResource,
  homeDirectory: string,
): string[] {
  const paths: string[] = []
  let fence: { character: string; length: number } | null = null
  for (const line of resource.content.split(/\r?\n/u)) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/u.exec(line)
    if (fence) {
      if (
        fenceMatch?.[1]?.[0] === fence.character &&
        fenceMatch[1].length >= fence.length &&
        line.slice(fenceMatch[0].length).trim() === ''
      ) {
        fence = null
      }
      continue
    }
    if (fenceMatch?.[1]) {
      fence = {
        character: fenceMatch[1][0] ?? '`',
        length: fenceMatch[1].length,
      }
      continue
    }
    if (/^(?: {4}|\t)/u.test(line)) continue
    const match = /^\s*@([^\s]+)\s*$/u.exec(line)
    if (!match?.[1] || /^https?:\/\//u.test(match[1])) continue
    paths.push(
      match[1].startsWith('~/')
        ? join(homeDirectory, match[1].slice(2))
        : resolve(dirname(resource.path), match[1]),
    )
  }
  return paths
}

async function readable(path: string): Promise<boolean> {
  try {
    await readFile(path, 'utf8')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function importedEntries(
  resource: ClaudeTextResource,
  cwd: string,
  homeDirectory: string,
  sourceDisplayPath: string,
): Promise<TuiMemoryFileEntry[]> {
  const entries: TuiMemoryFileEntry[] = []
  for (const path of importedPaths(resource, homeDirectory)) {
    if (!(await readable(path))) continue
    const canonicalPath = await realpath(path)
    entries.push({
      kind: 'file',
      label: `└ ${displayTuiMemoryPath(canonicalPath, cwd, homeDirectory)}`,
      path: canonicalPath,
      displayPath: displayTuiMemoryPath(canonicalPath, cwd, homeDirectory),
      annotation:
        resource.scope === 'user'
          ? `Saved in ${sourceDisplayPath}`
          : '@-imported',
      scope: resource.scope,
      imported: true,
    })
  }
  return entries
}

function autoMemorySetting(settings: readonly { value: unknown }[]): boolean {
  let enabled = true
  for (const resource of settings) {
    if (
      typeof resource.value === 'object' &&
      resource.value !== null &&
      !Array.isArray(resource.value)
    ) {
      const value = (resource.value as Record<string, unknown>)
        .autoMemoryEnabled
      if (typeof value === 'boolean') enabled = value
    }
  }
  return enabled
}

export async function loadTuiMemoryFiles({
  configRoot,
  cwd,
  homeDirectory = homedir(),
}: LoadTuiMemoryFilesOptions): Promise<TuiMemoryFiles> {
  const [canonicalCwd, canonicalHome] = await Promise.all([
    realpath(cwd),
    realpath(homeDirectory).catch(() => resolve(homeDirectory)),
  ])
  const [context, settings, autoMemoryDirectory] = await Promise.all([
    loadClaudeContextResources({ configRoot, cwd, homeDirectory }),
    loadClaudeSettings({ configRoot, cwd }),
    resolveClaudeProjectMemoryDirectory({ configRoot, cwd, homeDirectory }),
  ])
  const userPath = resolve(configRoot, 'CLAUDE.md')
  const projectResources = context.instructions.filter(
    (resource) => resource.scope !== 'user' && isMemoryInstruction(resource),
  )
  const userResource = context.instructions.find(
    (resource) => resolve(resource.path) === userPath,
  )
  const projectPath = resolve(canonicalCwd, 'CLAUDE.md')
  const entries: TuiMemoryFileEntry[] = [
    {
      kind: 'file',
      label: 'User memory',
      path: userPath,
      displayPath: '~/.claude/CLAUDE.md',
      annotation: 'Saved in ~/.claude/CLAUDE.md',
      scope: 'user',
    },
  ]
  if (userResource) {
    entries.push(
      ...(await importedEntries(
        userResource,
        canonicalCwd,
        canonicalHome,
        '~/.claude/CLAUDE.md',
      )),
    )
  }

  const canonicalProjectResource = projectResources.find(
    (resource) => resolve(resource.path) === projectPath,
  )
  const visibleProjectResources = [
    canonicalProjectResource ?? {
      path: projectPath,
      scope: 'project' as const,
      content: '',
    },
    ...projectResources.filter(
      (resource) => resource !== canonicalProjectResource,
    ),
  ]
  for (const resource of visibleProjectResources) {
    const activeProject = resolve(resource.path) === projectPath
    const displayPath = displayTuiMemoryPath(
      resource.path,
      canonicalCwd,
      canonicalHome,
    )
    entries.push({
      kind: 'file',
      label: activeProject ? 'Project memory' : displayPath,
      path: resource.path,
      displayPath,
      ...(activeProject ? { annotation: 'Saved in ./CLAUDE.md' } : {}),
      scope: resource.scope,
    })
    entries.push(
      ...(await importedEntries(
        resource,
        canonicalCwd,
        canonicalHome,
        displayPath,
      )),
    )
  }

  const autoMemoryEnabled = autoMemorySetting(settings)
  if (autoMemoryEnabled) {
    entries.push({
      kind: 'folder',
      label: 'Open auto-memory folder',
      path: autoMemoryDirectory,
      displayPath: displayTuiMemoryPath(
        autoMemoryDirectory,
        canonicalCwd,
        canonicalHome,
      ),
      scope: 'project',
    })
  }
  return { autoMemoryEnabled, entries }
}

type TuiMemoryFolderLauncher = (
  command: string,
  args: readonly string[],
) => Promise<void>

async function launchTuiMemoryFolder(
  command: string,
  args: readonly string[],
): Promise<void> {
  await new Promise<void>((resolveOpen, reject) => {
    const child = spawn(command, [...args], { stdio: 'ignore' })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolveOpen()
      else
        reject(new Error(`${command} exited with status ${code ?? 'unknown'}`))
    })
  })
}

export async function openTuiMemoryFolder(
  path: string,
  launcher: TuiMemoryFolderLauncher = launchTuiMemoryFolder,
): Promise<void> {
  await mkdir(path, { recursive: true })
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'explorer.exe'
        : 'xdg-open'
  await launcher(command, [path])
}
