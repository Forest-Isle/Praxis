import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import type { JsonResource } from '../core/resources.js'
import { writeFileAtomically } from '../platform/atomic-write.js'
import { ExclusiveFileLease } from '../platform/exclusive-file-lease.js'

const MISSING_FINGERPRINT = 'missing'
const TRUST_VERSION = 1
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u

export interface WorkspaceTrustOrigin {
  readonly kind: 'hook' | 'mcp' | 'provider'
  readonly scope: 'project' | 'local'
  readonly path: string
  readonly label: string
}

export interface WorkspaceTrustInventory {
  readonly canonicalPath: string
  readonly fingerprint: string
  readonly origins: readonly WorkspaceTrustOrigin[]
}

export type WorkspaceTrustStatus = 'not-required' | 'trusted' | 'untrusted'

export interface WorkspaceTrustAssessment extends WorkspaceTrustInventory {
  readonly status: WorkspaceTrustStatus
}

interface WorkspaceTrustRecord {
  readonly version: typeof TRUST_VERSION
  readonly fingerprint: string
  readonly acceptedAt: string
}

interface StateRead {
  readonly content: string | null
  readonly fingerprint: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function canonicalizeWorkspaceTrust(
  value: unknown,
  ancestors: Set<object> = new Set(),
): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('Workspace trust config contains a non-JSON number')
    return JSON.stringify(value)
  }
  if (typeof value !== 'object')
    throw new TypeError('Workspace trust config contains a non-JSON value')
  if (ancestors.has(value))
    throw new TypeError('Workspace trust config contains a cycle')

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return `[${value
        .map((item) => canonicalizeWorkspaceTrust(item, ancestors))
        .join(',')}]`
    }
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalizeWorkspaceTrust(
            (value as Record<string, unknown>)[key],
            ancestors,
          )}`,
      )
      .join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

function executableMap(
  resource: JsonResource,
  kind: 'hook' | 'mcp',
): Record<string, unknown> | null {
  if (!isRecord(resource.value)) return null
  const key = kind === 'hook' ? 'hooks' : 'mcpServers'
  const value = resource.value[key]
  return isRecord(value) && Object.keys(value).length > 0 ? value : null
}

function providerSelectionMap(
  resource: JsonResource,
): Record<string, unknown> | null {
  if (
    (resource.scope !== 'project' && resource.scope !== 'local') ||
    !isRecord(resource.value)
  )
    return null
  const value = resource.value
  const selection = Object.fromEntries(
    ['provider', 'providerProfile', 'model']
      .filter((key) => Object.prototype.hasOwnProperty.call(value, key))
      .map((key) => [key, value[key]]),
  )
  return Object.keys(selection).length > 0 ? selection : null
}

export function hasWorkspaceProviderSelection(
  resources: readonly JsonResource[],
): boolean {
  return resources.some((resource) => providerSelectionMap(resource) !== null)
}

export function hasWorkspaceHooks(resource: JsonResource): boolean {
  return executableMap(resource, 'hook') !== null
}

export function hasWorkspaceMcpServers(resource: JsonResource): boolean {
  return executableMap(resource, 'mcp') !== null
}

export function allowedWorkspaceHookSettings(
  resources: readonly JsonResource[],
  trusted: boolean,
): JsonResource[] {
  if (trusted) return [...resources]
  return resources.filter(
    (resource) => resource.scope === 'user' || !hasWorkspaceHooks(resource),
  )
}

export function allowedWorkspaceMcpResources(
  resources: readonly JsonResource[],
  trusted: boolean,
): JsonResource[] {
  if (trusted) return [...resources]
  return resources.filter(
    (resource) =>
      resource.scope === 'user' || !hasWorkspaceMcpServers(resource),
  )
}

async function resolvedResourcePath(
  canonicalPath: string,
  requestedWorkspace: string,
  path: string,
): Promise<string> {
  if (path.startsWith('<')) return path
  const absolute = isAbsolute(path)
    ? resolve(path)
    : resolve(requestedWorkspace, path)
  const workspaceRelative = relative(requestedWorkspace, absolute)
  if (
    workspaceRelative === '' ||
    (!workspaceRelative.startsWith('..') && !isAbsolute(workspaceRelative))
  ) {
    const canonicalSource = resolve(canonicalPath, workspaceRelative)
    try {
      return await realpath(canonicalSource)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return canonicalSource
      }
      throw error
    }
  }
  try {
    return await realpath(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return absolute
    throw error
  }
}

export async function workspaceTrustInventory(options: {
  cwd: string
  settings?: readonly JsonResource[]
  mcp?: readonly JsonResource[]
}): Promise<WorkspaceTrustInventory> {
  const canonicalPath = await realpath(options.cwd)
  const requestedWorkspace = resolve(options.cwd)
  const origins: WorkspaceTrustOrigin[] = []
  const fingerprintEntries: unknown[] = []

  const collect = async (
    resources: readonly JsonResource[],
    kind: 'hook' | 'mcp',
  ): Promise<void> => {
    for (const resource of resources) {
      if (resource.scope === 'user') continue
      const entries = executableMap(resource, kind)
      if (!entries) continue
      const path = await resolvedResourcePath(
        canonicalPath,
        requestedWorkspace,
        resource.path,
      )
      for (const [label, config] of Object.entries(entries)) {
        const entry = {
          kind,
          scope: resource.scope,
          path,
          label,
          config,
          ...(kind === 'hook' && resource.environment !== undefined
            ? { environment: resource.environment }
            : {}),
        }
        fingerprintEntries.push(entry)
        origins.push({ kind, scope: resource.scope, path, label })
      }
    }
  }

  await collect(options.settings ?? [], 'hook')
  await collect(options.mcp ?? [], 'mcp')

  for (const resource of options.settings ?? []) {
    if (resource.scope === 'user') continue
    const selection = providerSelectionMap(resource)
    if (!selection) continue
    const path = await resolvedResourcePath(
      canonicalPath,
      requestedWorkspace,
      resource.path,
    )
    const entry = {
      kind: 'provider' as const,
      scope: resource.scope,
      path,
      selection,
    }
    fingerprintEntries.push(entry)
    origins.push({
      kind: 'provider',
      scope: resource.scope,
      path,
      label: 'provider-selection',
    })
  }

  const sortedEntries = fingerprintEntries
    .map((entry) => canonicalizeWorkspaceTrust(entry))
    .sort()
  origins.sort((left, right) =>
    canonicalizeWorkspaceTrust(left).localeCompare(
      canonicalizeWorkspaceTrust(right),
    ),
  )

  return {
    canonicalPath,
    fingerprint: createHash('sha256')
      .update(`[${sortedEntries.join(',')}]`)
      .digest('hex'),
    origins,
  }
}

export function workspaceTrustDecisionKey(
  inventory: Pick<WorkspaceTrustInventory, 'canonicalPath' | 'fingerprint'>,
): string {
  return `${inventory.canonicalPath}\0${inventory.fingerprint}`
}

function validateInventory(inventory: WorkspaceTrustInventory): void {
  if (
    !inventory.canonicalPath ||
    !isAbsolute(inventory.canonicalPath) ||
    resolve(inventory.canonicalPath) !== inventory.canonicalPath
  ) {
    throw new TypeError('Workspace trust requires a canonical absolute path')
  }
  if (!FINGERPRINT_PATTERN.test(inventory.fingerprint))
    throw new TypeError('Workspace trust fingerprint must be lowercase SHA-256')
  for (const origin of inventory.origins) {
    if (
      !['hook', 'mcp', 'provider'].includes(origin.kind) ||
      (origin.scope !== 'project' && origin.scope !== 'local') ||
      origin.path.length === 0 ||
      origin.label.length === 0
    ) {
      throw new TypeError(
        'Workspace trust inventory contains an invalid origin',
      )
    }
  }
}

async function readState(path: string): Promise<StateRead> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT')
      return { content: null, fingerprint: MISSING_FINGERPRINT }
    if (code === 'ELOOP')
      throw new Error(`Workspace trust state must be a regular file: ${path}`, {
        cause: error,
      })
    throw error
  }

  try {
    if (!(await handle.stat()).isFile())
      throw new Error(`Workspace trust state must be a regular file: ${path}`)
    const content = await handle.readFile('utf8')
    return {
      content,
      fingerprint: createHash('sha256').update(content).digest('hex'),
    }
  } finally {
    await handle.close()
  }
}

function parseStateRoot(
  content: string | null,
  path: string,
): Record<string, unknown> {
  if (content === null) return {}
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch (error) {
    throw new Error(`Invalid workspace trust state: ${path}`, { cause: error })
  }
  if (!isRecord(value))
    throw new Error(`Workspace trust state root must be an object: ${path}`)
  return value
}

function projectState(
  root: Record<string, unknown>,
  canonicalPath: string,
  statePath: string,
): Record<string, unknown> | undefined {
  if (root.projects !== undefined && !isRecord(root.projects))
    throw new Error(`Workspace trust projects must be an object: ${statePath}`)
  if (isRecord(root.projects)) {
    for (const [path, project] of Object.entries(root.projects)) {
      if (!isRecord(project)) {
        throw new Error(
          `Workspace trust project entry must be an object: ${statePath} (${path})`,
        )
      }
    }
  }
  const project = isRecord(root.projects)
    ? root.projects[canonicalPath]
    : undefined
  return isRecord(project) ? project : undefined
}

function matchesRecord(
  value: unknown,
  fingerprint: string,
): value is WorkspaceTrustRecord {
  return (
    isRecord(value) &&
    value.version === TRUST_VERSION &&
    value.fingerprint === fingerprint &&
    typeof value.acceptedAt === 'string' &&
    Number.isFinite(Date.parse(value.acceptedAt))
  )
}

export async function assessWorkspaceTrust(
  inventory: WorkspaceTrustInventory,
  statePath: string,
): Promise<WorkspaceTrustAssessment> {
  validateInventory(inventory)
  if (inventory.origins.length === 0)
    return { ...inventory, status: 'not-required' }

  const root = parseStateRoot((await readState(statePath)).content, statePath)
  const project = projectState(root, inventory.canonicalPath, statePath)
  return {
    ...inventory,
    status: matchesRecord(project?.workspaceTrust, inventory.fingerprint)
      ? 'trusted'
      : 'untrusted',
  }
}

async function acquireStateLease(statePath: string) {
  const lease = new ExclusiveFileLease(
    join(dirname(statePath), '.praxis-state.lock'),
  )
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const handle = await lease.tryAcquire()
    if (handle) return handle
    await sleep(5)
  }
  throw new Error(`Timed out acquiring workspace trust lock: ${statePath}`)
}

export async function persistWorkspaceTrust(
  assessment: WorkspaceTrustAssessment,
  statePath: string,
): Promise<void> {
  validateInventory(assessment)
  if (assessment.status === 'not-required' || assessment.origins.length === 0) {
    throw new TypeError('Cannot persist an empty workspace trust assessment')
  }

  const lease = await acquireStateLease(statePath)
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await readState(statePath)
      const root = parseStateRoot(current.content, statePath)
      const existingProject = projectState(
        root,
        assessment.canonicalPath,
        statePath,
      )
      const projects = isRecord(root.projects) ? { ...root.projects } : {}
      projects[assessment.canonicalPath] = {
        ...(existingProject ?? {}),
        workspaceTrust: {
          version: TRUST_VERSION,
          fingerprint: assessment.fingerprint,
          acceptedAt: new Date().toISOString(),
        },
      }
      const next = { ...root, projects }
      const committed = await writeFileAtomically(
        statePath,
        `${JSON.stringify(next, null, 2)}\n`,
        {
          mode: 0o600,
          beforeCommit: async () =>
            (await readState(statePath)).fingerprint === current.fingerprint,
        },
      )
      if (committed) return
    }
    throw new Error(`Workspace trust state changed concurrently: ${statePath}`)
  } finally {
    await lease.release()
  }
}
