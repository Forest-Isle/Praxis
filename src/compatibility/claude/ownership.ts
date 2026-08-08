export type ClaudeDataResource =
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
  resource: ClaudeDataResource
  plane: DataPlane
  praxisAccess: PraxisAccess
  location: string
}

export const CLAUDE_DATA_OWNERSHIP = [
  {
    resource: 'transcript',
    plane: 'shared',
    praxisAccess: 'append-only',
    location: 'projects/<project-key>/<session-id>.jsonl',
  },
  {
    resource: 'auto-memory',
    plane: 'shared',
    praxisAccess: 'read-write',
    location: 'projects/<project-key>/memory/',
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
    location: '.claude/scheduled_tasks.json',
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
    location: 'CLAUDE.md and .claude rules',
  },
  {
    resource: 'skills',
    plane: 'shared',
    praxisAccess: 'read-only',
    location: 'skills/ and .claude/skills/',
  },
  {
    resource: 'commands',
    plane: 'shared',
    praxisAccess: 'read-only',
    location: 'commands/ and .claude/commands/',
  },
  {
    resource: 'agents',
    plane: 'shared',
    praxisAccess: 'read-only',
    location: 'agents/ and .claude/agents/',
  },
  {
    resource: 'settings',
    plane: 'shared',
    praxisAccess: 'read-only',
    location: 'settings.json and .claude/settings*.json',
  },
  {
    resource: 'hooks',
    plane: 'shared',
    praxisAccess: 'read-only',
    location: 'hooks declared by Claude settings',
  },
  {
    resource: 'mcp',
    plane: 'shared',
    praxisAccess: 'read-only',
    location: '.mcp.json and Claude-compatible settings',
  },
  {
    resource: 'provider-payload',
    plane: 'praxis-sidecar',
    praxisAccess: 'read-write',
    location: 'praxis/providers/',
  },
  {
    resource: 'search-index',
    plane: 'praxis-sidecar',
    praxisAccess: 'read-write',
    location: 'praxis/indexes/',
  },
  {
    resource: 'session-lock',
    plane: 'praxis-sidecar',
    praxisAccess: 'read-write',
    location: 'praxis/locks/',
  },
] as const satisfies readonly DataOwnershipPolicy[]

export function getDataOwnership(
  resource: ClaudeDataResource,
): DataOwnershipPolicy {
  const policy = CLAUDE_DATA_OWNERSHIP.find(
    (item) => item.resource === resource,
  )
  if (!policy) {
    throw new Error(`Missing Claude data ownership policy: ${resource}`)
  }

  return policy
}
