import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { ResourceScope } from '../../core/resources.js'
import { writeFileAtomically } from '../../platform/atomic-write.js'
import { resolveDataPlaneRoot } from '../../persistence/data-plane.js'
import { loadNativeSharedResources } from '../../persistence/native-resources.js'
import type { PermissionUpdate } from '../../core/runtime.js'
import {
  permissionRuleStringIsValid,
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from '../../permissions/permission-updates.js'

export type TuiPermissionBehavior = 'allow' | 'ask' | 'deny'

export interface TuiPermissionRule {
  behavior: TuiPermissionBehavior
  rule: string
  scope: ResourceScope
  path: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function configRootPath(): string {
  return resolveDataPlaneRoot()
}

function settingsPath(
  configRoot: string,
  cwd: string,
  scope: ResourceScope,
): string {
  if (scope === 'user') return join(configRoot, 'settings.json')
  return join(
    cwd,
    '.praxis',
    scope === 'local' ? 'settings.local.json' : 'settings.json',
  )
}

export async function loadTuiPermissionRules(
  cwd: string,
  configRoot?: string,
): Promise<readonly TuiPermissionRule[]> {
  const root = configRoot ?? configRootPath()
  const settings = (await loadNativeSharedResources({ root, cwd })).settings
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
  configRoot,
}: {
  cwd: string
  behavior: TuiPermissionBehavior
  rule: string
  scope: ResourceScope
  configRoot?: string
}): Promise<void> {
  if (!permissionRuleStringIsValid(rule))
    throw new Error(`Invalid permission rule: ${rule}`)
  const path = settingsPath(configRoot ?? configRootPath(), cwd, scope)
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

function destinationScope(
  destination: PermissionUpdate['destination'],
): ResourceScope | undefined {
  return destination === 'userSettings'
    ? 'user'
    : destination === 'projectSettings'
      ? 'project'
      : destination === 'localSettings'
        ? 'local'
        : undefined
}

export async function persistTuiPermissionUpdates({
  cwd,
  updates,
  configRoot,
}: {
  cwd: string
  updates: readonly PermissionUpdate[]
  configRoot?: string
}): Promise<void> {
  const root = configRoot ?? configRootPath()
  for (const update of updates) {
    const scope = destinationScope(update.destination)
    if (!scope) continue
    if (update.type === 'addRules') {
      for (const rule of update.rules) {
        await addTuiPermissionRule({
          cwd,
          behavior: update.behavior,
          rule: permissionRuleValueToString(rule),
          scope,
          configRoot: root,
        })
      }
      continue
    }
    const path = settingsPath(root, cwd, scope)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { value: settings, source } = await readSettings(path)
      const permissions = isRecord(settings.permissions)
        ? { ...settings.permissions }
        : {}
      if (update.type === 'setMode') {
        permissions.defaultMode = update.mode
      } else if (
        update.type === 'addDirectories' ||
        update.type === 'removeDirectories'
      ) {
        const existing = permissions.additionalDirectories
        if (existing !== undefined && !Array.isArray(existing)) {
          throw new Error(
            `permissions.additionalDirectories must be an array: ${path}`,
          )
        }
        const directories = Array.isArray(existing)
          ? existing.filter(
              (directory): directory is string => typeof directory === 'string',
            )
          : []
        const changed = new Set(directories)
        for (const directory of update.directories) {
          if (update.type === 'addDirectories') changed.add(directory)
          else changed.delete(directory)
        }
        permissions.additionalDirectories = [...changed]
      } else if (
        update.type === 'replaceRules' ||
        update.type === 'removeRules'
      ) {
        const existing = permissions[update.behavior]
        if (existing !== undefined && !Array.isArray(existing)) {
          throw new Error(
            `permissions.${update.behavior} must be an array: ${path}`,
          )
        }
        const rules = Array.isArray(existing)
          ? existing.filter((rule): rule is string => typeof rule === 'string')
          : []
        const changed = update.rules.map(permissionRuleValueToString)
        if (update.type === 'replaceRules') {
          permissions[update.behavior] = changed
        } else {
          const removed = new Set(changed)
          permissions[update.behavior] = rules.filter(
            (rule) =>
              !removed.has(
                permissionRuleValueToString(
                  permissionRuleValueFromString(rule),
                ),
              ),
          )
        }
      } else {
        const unreachable: never = update
        throw new Error(
          `Unsupported permission update: ${JSON.stringify(unreachable)}`,
        )
      }
      const committed = await writeFileAtomically(
        path,
        `${JSON.stringify({ ...settings, permissions }, null, 2)}\n`,
        { beforeCommit: () => sourceUnchanged(path, source) },
      )
      if (committed) break
      if (attempt === 2)
        throw new Error(`Settings changed concurrently: ${path}`)
    }
  }
}
