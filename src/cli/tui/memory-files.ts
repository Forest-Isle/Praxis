import { spawn } from 'node:child_process'
import { mkdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, relative, resolve } from 'node:path'

import {
  loadClaudeContextResources,
  loadClaudeSettings,
  resolveClaudeProjectMemoryDirectory,
  type ClaudeResourceScope,
  type ClaudeTextResource,
} from '../../compatibility/claude/shared-resources.js'
import { sanitizeClaudeProjectPath } from '../../compatibility/claude/paths.js'
import type { DataPlane } from '../../persistence/data-plane.js'
import {
  loadNativeContextResources,
  loadNativeSharedResources,
} from '../../persistence/native-resources.js'

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
  dataPlane?: DataPlane
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
  if (isWithin(resolve(cwd), absolute)) {
    const suffix = relative(resolve(cwd), absolute)
    return suffix ? `./${suffix}` : '.'
  }
  if (isWithin(home, absolute)) {
    const suffix = relative(home, absolute)
    return suffix ? `~/${suffix}` : '~'
  }
  return absolute
}

function isMemoryInstruction(resource: ClaudeTextResource): boolean {
  return /^(?:CLAUDE(?:\.local)?|PRAXIS)\.md$/u.test(basename(resource.path))
}

function importedEntries(
  resource: ClaudeTextResource,
  instructions: readonly ClaudeTextResource[],
  cwd: string,
  homeDirectory: string,
  sourceDisplayPath: string,
): TuiMemoryFileEntry[] {
  return instructions
    .filter(
      (candidate) =>
        candidate.importRoot !== undefined &&
        resolve(candidate.importRoot) === resolve(resource.path),
    )
    .map((candidate) => ({
      kind: 'file',
      label: `└ ${displayTuiMemoryPath(candidate.path, cwd, homeDirectory)}`,
      path: candidate.path,
      displayPath: displayTuiMemoryPath(candidate.path, cwd, homeDirectory),
      annotation:
        resource.scope === 'user'
          ? `Saved in ${sourceDisplayPath}`
          : '@-imported',
      scope: resource.scope,
      imported: true as const,
    }))
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
  dataPlane = 'claude',
}: LoadTuiMemoryFilesOptions): Promise<TuiMemoryFiles> {
  const [canonicalCwd, canonicalHome] = await Promise.all([
    realpath(cwd),
    realpath(homeDirectory).catch(() => resolve(homeDirectory)),
  ])
  const [context, settings, autoMemoryDirectory] =
    dataPlane === 'native'
      ? await Promise.all([
          loadNativeContextResources({ root: configRoot, cwd }),
          loadNativeSharedResources({ root: configRoot, cwd }).then(
            (resources) => resources.settings,
          ),
          Promise.resolve(
            resolve(configRoot, 'memory', sanitizeClaudeProjectPath(cwd)),
          ),
        ])
      : await Promise.all([
          loadClaudeContextResources({ configRoot, cwd, homeDirectory }),
          loadClaudeSettings({ configRoot, cwd }),
          resolveClaudeProjectMemoryDirectory({
            configRoot,
            cwd,
            homeDirectory,
          }),
        ])
  const instructionName = dataPlane === 'native' ? 'PRAXIS.md' : 'CLAUDE.md'
  const userPath = resolve(configRoot, instructionName)
  const projectResources = context.instructions.filter(
    (resource) =>
      resource.importedFrom === undefined &&
      resource.scope !== 'user' &&
      isMemoryInstruction(resource),
  )
  const userResource = context.instructions.find(
    (resource) =>
      resource.importedFrom === undefined &&
      resolve(resource.path) === userPath,
  )
  const projectPath =
    dataPlane === 'native'
      ? resolve(canonicalCwd, '.praxis', 'PRAXIS.md')
      : resolve(canonicalCwd, 'CLAUDE.md')
  const userDisplayPath =
    dataPlane === 'native'
      ? displayTuiMemoryPath(userPath, canonicalCwd, canonicalHome)
      : '~/.claude/CLAUDE.md'
  const entries: TuiMemoryFileEntry[] = [
    {
      kind: 'file',
      label: 'User memory',
      path: userPath,
      displayPath: userDisplayPath,
      annotation: `Saved in ${userDisplayPath}`,
      scope: 'user',
    },
  ]
  if (userResource) {
    entries.push(
      ...importedEntries(
        userResource,
        context.instructions,
        canonicalCwd,
        canonicalHome,
        userDisplayPath,
      ),
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
      ...(activeProject
        ? {
            annotation:
              dataPlane === 'native'
                ? 'Saved in ./.praxis/PRAXIS.md'
                : 'Saved in ./CLAUDE.md',
          }
        : {}),
      scope: resource.scope,
    })
    entries.push(
      ...importedEntries(
        resource,
        context.instructions,
        canonicalCwd,
        canonicalHome,
        displayPath,
      ),
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
