/** A user input item accepted by an active, steerable turn. */
export interface SteeringItem {
  readonly id: string
  readonly content: string
}

export type SteeringEnqueueResult =
  | { readonly kind: 'accepted'; readonly item: SteeringItem }
  | { readonly kind: 'empty' }
  | { readonly kind: 'sealed' }

export type SteeringWithdrawResult =
  | { readonly kind: 'withdrawn'; readonly item: SteeringItem }
  | { readonly kind: 'not-pending' }

/** Results returned by the session-level steering commands. */
export type ActiveTurnInputCommandResult =
  | { readonly kind: 'accepted'; readonly item: SteeringItem }
  | { readonly kind: 'withdrawn'; readonly item: SteeringItem }
  | { readonly kind: 'empty' }
  | { readonly kind: 'no-active-turn' }
  | { readonly kind: 'not-steerable' }
  | { readonly kind: 'turn-completing' }
  | { readonly kind: 'not-pending' }

/** The synchronous port exposed to the runtime at safe continuation points. */
export interface ActiveTurnInputPort {
  take(): SteeringItem | undefined
  takeOrSeal(): SteeringItem | undefined
  /** Drain and seal the port, returning every item that was not delivered. */
  close(): readonly SteeringItem[]
}

/**
 * A small synchronous FIFO. Keeping all state transitions synchronous makes
 * enqueue/take-or-seal atomic with respect to the runtime's await boundaries.
 */
export class ActiveTurnInputMailbox implements ActiveTurnInputPort {
  private readonly createId: () => string
  private readonly items: SteeringItem[] = []
  private sealed = false

  constructor(createId: () => string) {
    this.createId = createId
  }

  enqueue(content: string): SteeringEnqueueResult {
    const trimmed = content.trim()
    if (trimmed.length === 0) return { kind: 'empty' }
    if (this.sealed) return { kind: 'sealed' }
    const item: SteeringItem = { id: this.createId(), content: trimmed }
    this.items.push(item)
    return { kind: 'accepted', item }
  }

  take(): SteeringItem | undefined {
    return this.items.shift()
  }

  /** Take one item, or seal an empty mailbox before returning. */
  takeOrSeal(): SteeringItem | undefined {
    const item = this.items.shift()
    if (item !== undefined) return item
    this.sealed = true
    return undefined
  }

  withdraw(id: string): SteeringWithdrawResult {
    const index = this.items.findIndex((item) => item.id === id)
    if (index < 0) return { kind: 'not-pending' }
    const [item] = this.items.splice(index, 1)
    return item === undefined
      ? { kind: 'not-pending' }
      : { kind: 'withdrawn', item }
  }

  close(): readonly SteeringItem[] {
    this.sealed = true
    return this.items.splice(0)
  }

  isSealed(): boolean {
    return this.sealed
  }

  get pendingCount(): number {
    return this.items.length
  }
}
