/** Provider- and persistence-independent lifecycle contract for one Agent. */

export type LifecycleState =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelling'
  | 'cancelled'
  | 'orphaned'

export type LifecycleAcceptance = 'pending' | 'accepted' | 'rejected'

export interface LifecycleOwner {
  readonly token: string
  readonly pid: number
  readonly acquiredAt: string
}

export interface AgentLifecycleSnapshot {
  readonly generation: number
  readonly revision: number
  readonly state: LifecycleState
  readonly owner: LifecycleOwner | null
  readonly previousOwnerToken: string | null
  readonly terminalAt: string | null
  readonly acceptance: LifecycleAcceptance
}

export const TERMINAL_LIFECYCLE_STATES = [
  'completed',
  'failed',
  'cancelled',
  'orphaned',
] as const

const transitions: Readonly<Record<LifecycleState, readonly LifecycleState[]>> =
  {
    queued: ['running', 'cancelling', 'failed'],
    running: ['waiting', 'completed', 'failed', 'cancelling'],
    waiting: ['running', 'completed', 'failed', 'cancelling'],
    cancelling: ['cancelled'],
    completed: [],
    failed: [],
    cancelled: [],
    orphaned: [],
  }

export function isTerminalLifecycleState(
  state: LifecycleState,
): state is 'completed' | 'failed' | 'cancelled' | 'orphaned' {
  return (TERMINAL_LIFECYCLE_STATES as readonly string[]).includes(state)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseOwner(value: unknown): LifecycleOwner {
  if (!isRecord(value)) throw new Error('Invalid lifecycle owner')
  const owner = value
  const token = owner.token
  const pid = owner.pid
  const acquiredAt = owner.acquiredAt
  if (
    typeof token !== 'string' ||
    token.trim().length === 0 ||
    !Number.isSafeInteger(pid) ||
    Number(pid) <= 0 ||
    typeof acquiredAt !== 'string' ||
    Number.isNaN(Date.parse(acquiredAt))
  ) {
    throw new Error('Invalid lifecycle owner')
  }
  return Object.freeze({
    token: token as string,
    pid: pid as number,
    acquiredAt: acquiredAt as string,
  })
}

/** The single invariant parser used by every lifecycle mutation and store. */
export function parseAgentLifecycleSnapshot(
  value: unknown,
): AgentLifecycleSnapshot {
  if (!isRecord(value)) throw new Error('Invalid lifecycle snapshot')
  const generation = value.generation
  const revision = value.revision
  const state = value.state
  const previousOwnerToken = value.previousOwnerToken
  const acceptance = value.acceptance
  const terminalAt = value.terminalAt
  if (!Number.isSafeInteger(generation) || Number(generation) <= 0) {
    throw new Error('Lifecycle generation must be a positive integer')
  }
  if (!Number.isSafeInteger(revision) || Number(revision) < 0) {
    throw new Error('Lifecycle revision must be a nonnegative integer')
  }
  if (
    ![
      'queued',
      'running',
      'waiting',
      'completed',
      'failed',
      'cancelling',
      'cancelled',
      'orphaned',
    ].includes(String(state))
  ) {
    throw new Error(`Invalid lifecycle state: ${String(value.state)}`)
  }
  if (
    previousOwnerToken !== null &&
    (typeof previousOwnerToken !== 'string' ||
      previousOwnerToken.trim().length === 0)
  ) {
    throw new Error('Invalid previous lifecycle owner token')
  }
  if (!['pending', 'accepted', 'rejected'].includes(String(acceptance))) {
    throw new Error('Invalid lifecycle acceptance')
  }
  if (isTerminalLifecycleState(state as LifecycleState)) {
    if (value.owner !== null || terminalAt === null) {
      throw new Error('Terminal lifecycle must be ownerless and timestamped')
    }
    if (
      typeof terminalAt !== 'string' ||
      Number.isNaN(Date.parse(terminalAt))
    ) {
      throw new Error('Invalid lifecycle terminal timestamp')
    }
    if (acceptance !== 'pending' && state !== 'completed') {
      throw new Error('Only completed lifecycle may be accepted or rejected')
    }
  } else if (
    value.owner === null ||
    terminalAt !== null ||
    acceptance !== 'pending'
  ) {
    throw new Error(
      'Nonterminal lifecycle must be owned, pending, and untimestamped',
    )
  }
  const owner = value.owner === null ? null : parseOwner(value.owner)
  return Object.freeze({
    generation: generation as number,
    revision: revision as number,
    state: state as LifecycleState,
    owner,
    previousOwnerToken: previousOwnerToken as string | null,
    terminalAt: terminalAt as string | null,
    acceptance: acceptance as LifecycleAcceptance,
  })
}

export function createAgentLifecycle(
  owner: LifecycleOwner,
  generation = 1,
): AgentLifecycleSnapshot {
  parseOwner(owner)
  return parseAgentLifecycleSnapshot({
    generation,
    revision: 0,
    state: 'queued',
    owner,
    previousOwnerToken: null,
    terminalAt: null,
    acceptance: 'pending',
  })
}

function requireCurrentOwner(
  current: AgentLifecycleSnapshot,
  token: string,
): void {
  if (current.owner === null || current.owner.token !== token) {
    throw new Error('Lifecycle execution owner token is stale or missing')
  }
}

export function transitionLifecycle(
  current: AgentLifecycleSnapshot,
  nextState: LifecycleState,
  ownerToken: string,
  terminalAt = new Date().toISOString(),
): AgentLifecycleSnapshot {
  parseAgentLifecycleSnapshot(current)
  requireCurrentOwner(current, ownerToken)
  if (!transitions[current.state].includes(nextState)) {
    throw new Error(
      `Illegal lifecycle transition: ${current.state} -> ${nextState}`,
    )
  }
  const terminal = isTerminalLifecycleState(nextState)
  if (terminal && Number.isNaN(Date.parse(terminalAt))) {
    throw new Error('Invalid lifecycle terminal timestamp')
  }
  return parseAgentLifecycleSnapshot({
    generation: current.generation,
    revision: current.revision + 1,
    state: nextState,
    owner: terminal ? null : current.owner,
    previousOwnerToken: terminal
      ? (current.owner?.token ?? null)
      : current.previousOwnerToken,
    terminalAt: terminal ? terminalAt : null,
    acceptance: 'pending',
  })
}

function requireFreshOwner(
  current: AgentLifecycleSnapshot,
  owner: LifecycleOwner,
): void {
  parseOwner(owner)
  if (owner.token === current.previousOwnerToken) {
    throw new Error('Lifecycle generation requires a fresh owner token')
  }
}

/** Rotate a queued execution owner during a planned parent-to-worker handoff. */
export function transferLifecycleOwner(
  current: AgentLifecycleSnapshot,
  currentOwnerToken: string,
  nextOwner: LifecycleOwner,
): AgentLifecycleSnapshot {
  parseAgentLifecycleSnapshot(current)
  requireCurrentOwner(current, currentOwnerToken)
  if (current.state !== 'queued') {
    throw new Error(`Cannot transfer lifecycle owner from ${current.state}`)
  }
  parseOwner(nextOwner)
  if (nextOwner.token === currentOwnerToken) {
    throw new Error('Lifecycle handoff requires a different owner token')
  }
  requireFreshOwner(current, nextOwner)
  return parseAgentLifecycleSnapshot({
    ...current,
    revision: current.revision + 1,
    owner: nextOwner,
    previousOwnerToken: currentOwnerToken,
  })
}

export function continueLifecycle(
  current: AgentLifecycleSnapshot,
  owner: LifecycleOwner,
): AgentLifecycleSnapshot {
  parseAgentLifecycleSnapshot(current)
  if (!['completed', 'failed', 'cancelled'].includes(current.state)) {
    throw new Error(`Cannot continue lifecycle from ${current.state}`)
  }
  requireFreshOwner(current, owner)
  return parseAgentLifecycleSnapshot({
    generation: current.generation + 1,
    revision: current.revision + 1,
    state: 'queued',
    owner,
    previousOwnerToken: current.previousOwnerToken,
    terminalAt: null,
    acceptance: 'pending',
  })
}

export function recoverLifecycle(
  current: AgentLifecycleSnapshot,
  owner: LifecycleOwner,
): AgentLifecycleSnapshot {
  parseAgentLifecycleSnapshot(current)
  if (current.state !== 'orphaned') {
    throw new Error(`Cannot recover lifecycle from ${current.state}`)
  }
  requireFreshOwner(current, owner)
  return parseAgentLifecycleSnapshot({
    generation: current.generation + 1,
    revision: current.revision + 1,
    state: 'queued',
    owner,
    previousOwnerToken: current.previousOwnerToken,
    terminalAt: null,
    acceptance: 'pending',
  })
}

/** Adapter-proven owner loss is intentionally separate from ordinary transitions. */
export function markLifecycleOrphaned(
  current: AgentLifecycleSnapshot,
  ownerToken: string,
  terminalAt = new Date().toISOString(),
): AgentLifecycleSnapshot {
  parseAgentLifecycleSnapshot(current)
  requireCurrentOwner(current, ownerToken)
  if (!['queued', 'running', 'waiting', 'cancelling'].includes(current.state)) {
    throw new Error(`Cannot orphan lifecycle from ${current.state}`)
  }
  if (Number.isNaN(Date.parse(terminalAt)))
    throw new Error('Invalid lifecycle terminal timestamp')
  return parseAgentLifecycleSnapshot({
    generation: current.generation,
    revision: current.revision + 1,
    state: 'orphaned',
    owner: null,
    previousOwnerToken: ownerToken,
    terminalAt,
    acceptance: 'pending',
  })
}

export function acceptLifecycle(
  current: AgentLifecycleSnapshot,
  generation = current.generation,
  acceptance: Exclude<LifecycleAcceptance, 'pending'> = 'accepted',
): AgentLifecycleSnapshot {
  parseAgentLifecycleSnapshot(current)
  if (current.state !== 'completed' || generation !== current.generation) {
    throw new Error('Only the completed current generation may be accepted')
  }
  return parseAgentLifecycleSnapshot({
    ...current,
    revision: current.revision + 1,
    acceptance,
  })
}
