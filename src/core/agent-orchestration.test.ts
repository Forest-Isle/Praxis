import { describe, expect, it } from 'vitest'

import {
  acceptLifecycle,
  continueLifecycle,
  createAgentLifecycle,
  isTerminalLifecycleState,
  markLifecycleOrphaned,
  parseAgentLifecycleSnapshot,
  recoverLifecycle,
  transitionLifecycle,
  transferLifecycleOwner,
  type AgentLifecycleSnapshot,
  type LifecycleOwner,
  type LifecycleState,
} from './agent-orchestration.js'

const owner = (token: string): LifecycleOwner => ({
  token,
  pid: 1,
  acquiredAt: '2026-08-24T00:00:00.000Z',
})

const rawSnapshot = (overrides: Record<string, unknown> = {}) => ({
  generation: 1,
  revision: 0,
  state: 'running',
  owner: owner('raw'),
  previousOwnerToken: null,
  terminalAt: null,
  acceptance: 'pending',
  ...overrides,
})

describe('agent orchestration lifecycle', () => {
  it('parses and freezes valid snapshots while rejecting invalid raw values', () => {
    const valid = parseAgentLifecycleSnapshot(rawSnapshot())
    expect(Object.isFrozen(valid)).toBe(true)
    expect(Object.isFrozen(valid.owner)).toBe(true)
    expect(valid).toMatchObject({ state: 'running', generation: 1 })
    expect(() =>
      parseAgentLifecycleSnapshot(rawSnapshot({ state: 'bogus' })),
    ).toThrow(/Invalid lifecycle state/u)
    expect(() =>
      parseAgentLifecycleSnapshot(
        rawSnapshot({
          state: 'completed',
          terminalAt: new Date().toISOString(),
        }),
      ),
    ).toThrow(/Terminal lifecycle must be ownerless/u)
    expect(() =>
      parseAgentLifecycleSnapshot(
        rawSnapshot({ state: 'running', owner: null }),
      ),
    ).toThrow(/Nonterminal lifecycle must be owned/u)
    expect(() =>
      parseAgentLifecycleSnapshot(
        rawSnapshot({ state: 'completed', owner: null, terminalAt: 'bad' }),
      ),
    ).toThrow(/Invalid lifecycle terminal timestamp/u)
    expect(() =>
      parseAgentLifecycleSnapshot(rawSnapshot({ acceptance: 'maybe' })),
    ).toThrow(/Invalid lifecycle acceptance/u)
  })

  it('enforces the transition matrix and one terminal transition', () => {
    let current = createAgentLifecycle(owner('first'))
    expect(current.state).toBe('queued')
    expect(current.acceptance).toBe('pending')
    current = transitionLifecycle(current, 'running', 'first')
    current = transitionLifecycle(current, 'waiting', 'first')
    current = transitionLifecycle(current, 'running', 'first')
    current = transitionLifecycle(current, 'completed', 'first')
    expect(isTerminalLifecycleState(current.state)).toBe(true)
    expect(current.owner).toBeNull()
    expect(current.previousOwnerToken).toBe('first')
    expect(() => transitionLifecycle(current, 'failed', 'first')).toThrow()
    expect(() => transitionLifecycle(current, 'completed', 'stale')).toThrow()
  })

  it('supports cancellation, owner-loss, fresh generations, and acceptance independently', () => {
    let current = createAgentLifecycle(owner('first'))
    current = transitionLifecycle(current, 'running', 'first')
    current = transitionLifecycle(current, 'cancelling', 'first')
    current = transitionLifecycle(current, 'cancelled', 'first')
    const next = continueLifecycle(current, owner('second'))
    expect(next).toMatchObject({
      generation: 2,
      state: 'queued',
      previousOwnerToken: 'first',
      acceptance: 'pending',
    })
    expect(() => continueLifecycle(current, owner('first'))).toThrow()

    const orphaned = markLifecycleOrphaned(
      transitionLifecycle(next, 'running', 'second'),
      'second',
    )
    expect(orphaned.state).toBe('orphaned')
    const recovered = recoverLifecycle(orphaned, owner('third'))
    expect(recovered.generation).toBe(3)
    expect(recovered.previousOwnerToken).toBe('second')
    expect(() => transitionLifecycle(recovered, 'running', 'second')).toThrow(
      'Lifecycle execution owner token is stale or missing',
    )
    const completed = transitionLifecycle(recovered, 'running', 'third')
    const terminal = transitionLifecycle(completed, 'completed', 'third')
    const accepted = acceptLifecycle(terminal)
    expect(accepted.state).toBe('completed')
    expect(accepted.terminalAt).toBe(terminal.terminalAt)
    expect(accepted.revision).toBe(terminal.revision + 1)
  })

  it('transfers a queued owner without changing its generation', () => {
    const current = createAgentLifecycle(owner('first'))
    const transferred = transferLifecycleOwner(
      current,
      'first',
      owner('second'),
    )
    expect(transferred).toMatchObject({
      generation: 1,
      revision: 1,
      state: 'queued',
      terminalAt: null,
      acceptance: 'pending',
      previousOwnerToken: 'first',
      owner: { token: 'second' },
    })
    expect(() =>
      transferLifecycleOwner(current, 'stale', owner('second')),
    ).toThrow()
    expect(() =>
      transferLifecycleOwner(transferred, 'second', owner('second')),
    ).toThrow()
    let continued = createAgentLifecycle(owner('old'))
    continued = transitionLifecycle(continued, 'running', 'old')
    continued = transitionLifecycle(continued, 'completed', 'old')
    continued = continueLifecycle(continued, owner('first'))
    expect(() =>
      transferLifecycleOwner(continued, 'first', owner('old')),
    ).toThrow(/fresh owner token/u)
    expect(() =>
      transferLifecycleOwner(
        transitionLifecycle(current, 'running', 'first'),
        'first',
        owner('third'),
      ),
    ).toThrow()
  })

  it('refuses handoff from every non-queued lifecycle state', () => {
    const snapshots: AgentLifecycleSnapshot[] = []
    const running = transitionLifecycle(
      createAgentLifecycle(owner('first')),
      'running',
      'first',
    )
    snapshots.push(running)
    snapshots.push(transitionLifecycle(running, 'waiting', 'first'))
    snapshots.push(transitionLifecycle(running, 'cancelling', 'first'))
    snapshots.push(transitionLifecycle(running, 'completed', 'first'))
    snapshots.push(transitionLifecycle(running, 'failed', 'first'))
    snapshots.push(
      transitionLifecycle(
        transitionLifecycle(running, 'cancelling', 'first'),
        'cancelled',
        'first',
      ),
    )
    snapshots.push(markLifecycleOrphaned(running, 'first'))
    for (const snapshot of snapshots)
      expect(() =>
        transferLifecycleOwner(snapshot, 'first', owner('next')),
      ).toThrow()
  })

  it.each([
    ['queued', 'running'],
    ['running', 'completed'],
    ['waiting', 'failed'],
    ['cancelling', 'cancelled'],
  ] as const)('accepts legal transition %s -> %s', (from, to) => {
    let current = createAgentLifecycle(owner('owner'))
    if (from !== 'queued')
      current = transitionLifecycle(current, 'running', 'owner')
    if (from === 'waiting' || from === 'cancelling')
      current = transitionLifecycle(current, 'waiting', 'owner')
    if (from === 'cancelling')
      current = transitionLifecycle(current, 'cancelling', 'owner')
    expect(() => transitionLifecycle(current, to, 'owner')).not.toThrow()
  })

  it('checks every ordinary state pair against the declared matrix', () => {
    const states: LifecycleState[] = [
      'queued',
      'running',
      'waiting',
      'completed',
      'failed',
      'cancelling',
      'cancelled',
      'orphaned',
    ]
    const legal: Record<LifecycleState, readonly LifecycleState[]> = {
      queued: ['running', 'cancelling', 'failed'],
      running: ['waiting', 'completed', 'failed', 'cancelling'],
      waiting: ['running', 'completed', 'failed', 'cancelling'],
      cancelling: ['cancelled'],
      completed: [],
      failed: [],
      cancelled: [],
      orphaned: [],
    }
    const snapshotFor = (state: LifecycleState) => {
      let current = createAgentLifecycle(owner('owner'))
      if (state !== 'queued')
        current = transitionLifecycle(current, 'running', 'owner')
      if (state === 'waiting' || state === 'cancelling')
        current = transitionLifecycle(current, 'waiting', 'owner')
      if (state === 'cancelling')
        current = transitionLifecycle(current, 'cancelling', 'owner')
      if (state === 'completed')
        current = transitionLifecycle(current, 'completed', 'owner')
      if (state === 'failed')
        current = transitionLifecycle(current, 'failed', 'owner')
      if (state === 'cancelled') {
        current = transitionLifecycle(current, 'cancelling', 'owner')
        current = transitionLifecycle(current, 'cancelled', 'owner')
      }
      if (state === 'orphaned')
        current = markLifecycleOrphaned(current, 'owner')
      return current
    }
    for (const from of states) {
      for (const to of states) {
        const operation = () =>
          transitionLifecycle(snapshotFor(from), to, 'owner')
        if (legal[from]?.includes(to)) expect(operation).not.toThrow()
        else expect(operation).toThrow()
      }
    }
  })
})
