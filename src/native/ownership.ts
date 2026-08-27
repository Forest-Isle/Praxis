export type NativeDataResource =
  | 'agents'
  | 'auto-memory'
  | 'commands'
  | 'durable-task-graph'
  | 'file-history'
  | 'hooks'
  | 'instructions'
  | 'mcp'
  | 'provider-payload'
  | 'search-index'
  | 'scheduled-prompts'
  | 'session-lock'
  | 'settings'
  | 'skills'
  | 'transcript'

export type DataPlane = 'praxis-sidecar' | 'shared'
export type PraxisAccess = 'append-only' | 'read-only' | 'read-write'

export interface DataOwnershipPolicy {
  resource: NativeDataResource
  plane: DataPlane
  praxisAccess: PraxisAccess
  location: string
}

export const NATIVE_DATA_OWNERSHIP = [
  {
    resource: 'transcript',
    plane: 'shared',
    praxisAccess: 'append-only',
    location: 'sessions/<project-key>/<session-id>.jsonl',
  },
  {
    resource: 'auto-memory',
    plane: 'shared',
    praxisAccess: 'read-write',
    location: 'memory/<project-key>/',
  },
  {
    resource: 'durable-task-graph',
    plane: 'shared',
    praxisAccess: 'read-write',
    location: 'tasks/<session-id>/',
  },
  {
    resource: 'scheduled-prompts',
    plane: 'shared',
    praxisAccess: 'read-write',
    location: 'scheduled/<project-key>.json',
  },
  {
    resource: 'file-history',
    plane: 'shared',
    praxisAccess: 'read-write',
    location:
      'file-history/<session-id>/ and transcript snapshot/delta records',
  },
  {
    resource: 'instructions',
    plane: 'shared',
    praxisAccess: 'read-only',
    location: 'PRAXIS.md, .praxis/PRAXIS.md, .praxis/rules/',
  },
  {
    resource: 'skills',
    plane: 'shared',
    praxisAccess: 'read-only',
    location: 'skills/ and .praxis/skills/',
  },
  {
    resource: 'commands',
    plane: 'shared',
    praxisAccess: 'read-only',
    location: 'commands/ and .praxis/commands/',
  },
  {
    resource: 'agents',
    plane: 'shared',
    praxisAccess: 'read-only',
    location: 'agents/ and .praxis/agents/',
  },
  {
    resource: 'settings',
    plane: 'shared',
    praxisAccess: 'read-only',
    location: 'settings.json and .praxis/settings*.json',
  },
  {
    resource: 'hooks',
    plane: 'shared',
    praxisAccess: 'read-only',
    location: 'hooks declared by Praxis settings',
  },
  {
    resource: 'mcp',
    plane: 'shared',
    praxisAccess: 'read-only',
    location: 'mcp.json and .praxis/mcp*.json',
  },
  {
    resource: 'provider-payload',
    plane: 'praxis-sidecar',
    praxisAccess: 'read-write',
    location: 'providers/',
  },
  {
    resource: 'search-index',
    plane: 'praxis-sidecar',
    praxisAccess: 'read-write',
    location: 'indexes/',
  },
  {
    resource: 'session-lock',
    plane: 'praxis-sidecar',
    praxisAccess: 'read-write',
    location: 'locks/',
  },
] as const satisfies readonly DataOwnershipPolicy[]

export function getNativeDataOwnership(
  resource: NativeDataResource,
): DataOwnershipPolicy {
  const policy = NATIVE_DATA_OWNERSHIP.find(
    (item) => item.resource === resource,
  )
  if (!policy) {
    throw new Error(`Missing native data ownership policy: ${resource}`)
  }

  return policy
}
