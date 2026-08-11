import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  loadClaudeSettings,
  type ClaudeResourceScope,
} from '../../compatibility/claude/shared-resources.js'
import { writeFileAtomically } from '../../platform/atomic-write.js'

export type TuiPermissionBehavior = 'allow' | 'ask' | 'deny'

export interface TuiPermissionRule {
  behavior: TuiPermissionBehavior
  rule: string
  scope: ClaudeResourceScope
  path: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function configRootPath(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
}

function settingsPath(
  configRoot: string,
  cwd: string,
  scope: ClaudeResourceScope,
): string {
  if (scope === 'user') return join(configRoot, 'settings.json')
  return join(
    cwd,
    '.claude',
    scope === 'local' ? 'settings.local.json' : 'settings.json',
  )
}

export async function loadTuiPermissionRules(
  cwd: string,
  configRoot = configRootPath(),
): Promise<readonly TuiPermissionRule[]> {
  const settings = await loadClaudeSettings({ configRoot, cwd })
  return settings.flatMap((resource) => {
    const value = resource.value
    if (!isRecord(value) || !isRecord(value.permissions)) return []
    const permissions = value.permissions
    return (['allow', 'ask', 'deny'] as const).flatMap((behavior) => {
      const values = permissions[behavior]
      if (!Array.isArray(values)) return []
      return values.flatMap((rule) =>
        typeof rule === 'string'
          ? [{ behavior, rule, scope: resource.scope, path: resource.path }]
          : [],
      )
    })
  })
}

async function readSettings(path: string): Promise<{
  value: Record<string, unknown>
  source?: string
}> {
  try {
    const source = await readFile(path, 'utf8')
    const value: unknown = JSON.parse(source)
    if (!isRecord(value))
      throw new Error(`JSON root must be an object: ${path}`)
    return { value, source }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { value: {} }
    if (error instanceof SyntaxError)
      throw new Error(`Invalid JSON: ${path}`, { cause: error })
    throw error
  }
}

async function sourceUnchanged(
  path: string,
  source: string | undefined,
): Promise<boolean> {
  try {
    return (await readFile(path, 'utf8')) === source
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return source === undefined
    throw error
  }
}

export async function addTuiPermissionRule({
  cwd,
  behavior,
  rule,
  scope,
  configRoot = configRootPath(),
}: {
  cwd: string
  behavior: TuiPermissionBehavior
  rule: string
  scope: ClaudeResourceScope
  configRoot?: string
}): Promise<void> {
  if (!/^([A-Za-z][\w-]*)(?:\(.*\))?$/u.test(rule))
    throw new Error(`Invalid permission rule: ${rule}`)
  const path = settingsPath(configRoot, cwd, scope)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { value: settings, source } = await readSettings(path)
    const permissions = isRecord(settings.permissions)
      ? { ...settings.permissions }
      : {}
    const existing = permissions[behavior]
    if (existing !== undefined && !Array.isArray(existing))
      throw new Error(`permissions.${behavior} must be an array: ${path}`)
    const rules = Array.isArray(existing)
      ? existing.filter((value): value is string => typeof value === 'string')
      : []
    permissions[behavior] = rules.includes(rule) ? rules : [...rules, rule]
    const committed = await writeFileAtomically(
      path,
      `${JSON.stringify({ ...settings, permissions }, null, 2)}\n`,
      { beforeCommit: () => sourceUnchanged(path, source) },
    )
    if (committed) return
  }
  throw new Error(`Settings changed concurrently: ${path}`)
}

export async function removeTuiPermissionRule(
  rule: TuiPermissionRule,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { value: settings, source } = await readSettings(rule.path)
    const permissions = settings.permissions
    if (permissions === undefined) return
    if (!isRecord(permissions))
      throw new Error(`permissions must be an object: ${rule.path}`)
    const existing = permissions[rule.behavior]
    if (existing === undefined) return
    if (!Array.isArray(existing))
      throw new Error(
        `permissions.${rule.behavior} must be an array: ${rule.path}`,
      )
    const index = existing.findIndex((value) => value === rule.rule)
    if (index === -1) return
    const nextRules = [...existing]
    nextRules.splice(index, 1)
    const committed = await writeFileAtomically(
      rule.path,
      `${JSON.stringify(
        {
          ...settings,
          permissions: { ...permissions, [rule.behavior]: nextRules },
        },
        null,
        2,
      )}\n`,
      { beforeCommit: () => sourceUnchanged(rule.path, source) },
    )
    if (committed) return
  }
  throw new Error(`Settings changed concurrently: ${rule.path}`)
}
