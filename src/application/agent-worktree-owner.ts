import { isSessionId } from '../core/session.js'

export interface AgentWorktreeOwnerIdentity {
  readonly sessionId: string
  readonly agentId: string
  readonly executionToken: string
}

const AGENT_ID_PATTERN = /^a(?:[A-Za-z0-9][A-Za-z0-9_-]{0,62}-)?[0-9a-f]{16}$/u
const EXECUTION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u

function isAgentWorktreeOwnerIdentity(
  value: AgentWorktreeOwnerIdentity,
): boolean {
  return (
    isSessionId(value.sessionId) &&
    AGENT_ID_PATTERN.test(value.agentId) &&
    EXECUTION_TOKEN_PATTERN.test(value.executionToken)
  )
}

function isAgentWorktreeIdentity(value: {
  readonly sessionId: string
  readonly agentId: string
}): boolean {
  return isSessionId(value.sessionId) && AGENT_ID_PATTERN.test(value.agentId)
}

function assertAgentWorktreeOwnerIdentity(
  value: AgentWorktreeOwnerIdentity,
): void {
  if (!isAgentWorktreeOwnerIdentity(value))
    throw new Error('Invalid Agent worktree owner identity')
}

export function formatAgentWorktreeOwner(
  identity: AgentWorktreeOwnerIdentity,
): string {
  assertAgentWorktreeOwnerIdentity(identity)
  return `agent:${identity.sessionId}:${identity.agentId}:${identity.executionToken}`
}

export function formatAgentWorktreeOwnerPrefix(identity: {
  readonly sessionId: string
  readonly agentId: string
}): string {
  if (!isAgentWorktreeIdentity(identity))
    throw new Error('Invalid Agent worktree owner identity')
  return `agent:${identity.sessionId}:${identity.agentId}:`
}

export function parseAgentWorktreeOwner(
  ownerId: string,
): AgentWorktreeOwnerIdentity | null {
  const parts = ownerId.split(':')
  if (parts.length !== 4 || parts[0] !== 'agent') return null
  const sessionId = parts[1] ?? ''
  const agentId = parts[2] ?? ''
  const executionToken = parts[3] ?? ''
  const identity = { sessionId, agentId, executionToken }
  return isAgentWorktreeOwnerIdentity(identity) ? identity : null
}
