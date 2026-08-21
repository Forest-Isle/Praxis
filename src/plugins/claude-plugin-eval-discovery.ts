import { readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { minimatch } from 'minimatch'

import { readClaudeInstalledPlugins } from './claude-plugin-marketplace.js'
import {
  loadClaudePluginEvalCase,
  resolveContainedPath,
  type ClaudePluginEvalCase,
} from './claude-plugin-eval-schema.js'
import { readPluginRegistry } from './claude-plugin-runtime.js'

const IGNORED = new Set(['node_modules', '.git', '.claude', 'results'])
const MAX_DEPTH = 16

export interface ResolvedEvalPlugin {
  name: string
  path: string
}
export interface EvalDiscoveryResult {
  root: string
  cases: ClaudePluginEvalCase[]
  plugins: ResolvedEvalPlugin[]
  warnings: string[]
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function discoveryRoot(
  target: string,
  cwd: string,
  configRoot: string,
): Promise<{ root: string; plugins: ResolvedEvalPlugin[] }> {
  const local = resolve(cwd, target)
  if (await exists(local)) {
    const path = await realpath(local)
    const info = await stat(path)
    const root = info.isFile() ? dirname(path) : path
    return {
      root,
      plugins: (await pluginAt(root))
        ? [{ name: basename(root), path: root }]
        : [],
    }
  }
  const installed = await readClaudeInstalledPlugins(configRoot, cwd)
  const localRegistry = await readPluginRegistry(configRoot)
  const all = [
    ...installed.map((item) => ({ name: item.id, path: item.installPath })),
    ...localRegistry.map((item) => ({ name: item.name, path: item.path })),
  ]
  const exact = all.filter(
    (item) => item.name === target || item.name.split('@')[0] === target,
  )
  if (exact.length > 1)
    throw new Error(
      `Ambiguous plugin ${target}: ${exact.map((item) => item.name).join(', ')}`,
    )
  if (exact.length === 0) throw new Error(`No readable eval root for ${target}`)
  const selected = exact[0]
  if (!selected) throw new Error(`No readable eval root for ${target}`)
  return {
    root: await realpath(selected.path),
    plugins: [{ name: selected.name, path: await realpath(selected.path) }],
  }
}

async function pluginAt(dir: string): Promise<boolean> {
  return (
    (await exists(join(dir, 'plugin.json'))) ||
    (await exists(join(dir, '.claude-plugin', 'plugin.json')))
  )
}

async function walk(
  dir: string,
  insideEvals: boolean,
  depth: number,
  found: Set<string>,
): Promise<void> {
  if (depth > MAX_DEPTH)
    throw new Error(`Eval discovery exceeds maximum depth ${MAX_DEPTH}: ${dir}`)
  if (
    insideEvals &&
    ((await exists(join(dir, 'case.yaml'))) ||
      (await exists(join(dir, 'prompt.md'))))
  ) {
    found.add(dir)
    return
  }
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || IGNORED.has(entry.name)) continue
    await walk(
      join(dir, entry.name),
      insideEvals || entry.name === 'evals',
      depth + 1,
      found,
    )
  }
}

async function nearestPlugin(
  caseDir: string,
  root: string,
): Promise<ResolvedEvalPlugin | undefined> {
  let current = caseDir
  while (current === root || current.startsWith(`${root}/`)) {
    if (await pluginAt(current))
      return { name: basename(current), path: current }
    if (current === root) break
    current = dirname(current)
  }
  return undefined
}

export async function discoverClaudePluginEvals(options: {
  target: string
  cwd: string
  configRoot: string
  evalDir?: string
  caseGlob?: string
  tags?: readonly string[]
  ablation?: 'none' | 'with-without'
}): Promise<EvalDiscoveryResult> {
  const resolved = await discoveryRoot(
    options.target,
    options.cwd,
    options.configRoot,
  )
  const direct = await stat(resolved.root)
  const found = new Set<string>()
  if (
    direct.isDirectory() &&
    ((await exists(join(resolved.root, 'case.yaml'))) ||
      (await exists(join(resolved.root, 'prompt.md'))))
  )
    found.add(resolved.root)
  else if (options.evalDir) {
    const evalRoot = await resolveContainedPath(
      resolved.root,
      resolve(resolved.root, options.evalDir),
      'Eval directory',
    )
    await walk(evalRoot, true, 0, found)
  } else
    await walk(resolved.root, basename(resolved.root) === 'evals', 0, found)
  const loaded = await Promise.all(
    [...found].sort().map(loadClaudePluginEvalCase),
  )
  const cases = loaded.filter(
    (item) =>
      (!options.caseGlob ||
        minimatch(item.name, options.caseGlob, { matchBase: false })) &&
      (!options.tags?.length ||
        options.tags.some((tag) => item.tags.includes(tag))),
  )
  const counts = new Map<string, number>()
  for (const item of cases)
    counts.set(item.name, (counts.get(item.name) ?? 0) + 1)
  for (const [name, count] of counts)
    if (count > 1) throw new Error(`Duplicate eval case name: ${name}`)
  const plugins = new Map(resolved.plugins.map((item) => [item.path, item]))
  for (const item of cases) {
    if (item.plugins?.length) {
      for (const path of item.plugins) {
        const contained = await resolveContainedPath(
          resolved.root,
          resolve(item.dir, path),
          'Plugin path',
        )
        if (!(await pluginAt(contained)))
          throw new Error(`Plugin path is not a plugin: ${path}`)
        plugins.set(contained, { name: basename(contained), path: contained })
      }
    } else {
      const detected = await nearestPlugin(item.dir, resolved.root)
      if (detected) plugins.set(detected.path, detected)
    }
  }
  if (options.ablation === 'with-without' && plugins.size === 0)
    throw new Error('with-without ablation requires a resolved plugin')
  return {
    root: resolved.root,
    cases,
    plugins: [...plugins.values()],
    warnings: [],
  }
}
