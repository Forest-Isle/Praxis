export interface DurableFollowUpBatch {
  readonly id: string
  readonly messages: readonly string[]
  acknowledge(): Promise<void>
}

function multiset(values: readonly string[]): Map<string, number> {
  const result = new Map<string, number>()
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1)
  return result
}

function containsAll(
  container: readonly string[],
  required: readonly string[],
): boolean {
  const available = multiset(container)
  for (const [value, count] of multiset(required)) {
    if ((available.get(value) ?? 0) < count) return false
  }
  return true
}

export class DurableFollowUpTracker {
  private readonly pending = new Map<string, DurableFollowUpBatch>()

  register(batch: DurableFollowUpBatch): void {
    if (!batch || typeof batch.id !== 'string' || batch.id.trim() === '')
      throw new Error('Invalid durable follow-up batch')
    if (!Array.isArray(batch.messages) || batch.messages.length === 0) return
    if (batch.messages.some((message) => typeof message !== 'string'))
      throw new Error('Invalid durable follow-up messages')
    const existing = this.pending.get(batch.id)
    if (existing) {
      if (
        existing.messages.length !== batch.messages.length ||
        existing.messages.some(
          (message, index) => message !== batch.messages[index],
        )
      )
        throw new Error(`Conflicting durable follow-up batch: ${batch.id}`)
      return
    }
    this.pending.set(batch.id, batch)
  }

  add(batch: DurableFollowUpBatch): void {
    this.register(batch)
  }

  track(batch: DurableFollowUpBatch): void {
    this.register(batch)
  }

  async followUpUserMessagesCompleted(
    messages: readonly string[],
  ): Promise<void> {
    const completed = [...messages]
    for (const [id, batch] of this.pending) {
      if (!containsAll(completed, batch.messages)) continue
      await batch.acknowledge()
      this.pending.delete(id)
    }
  }

  size(): number {
    return this.pending.size
  }
}
