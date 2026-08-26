import { describe, expect, it } from 'vitest'
import type { ModelToolCall } from '../core/runtime.js'
import { SerializedTeamLeadDecisionSurface } from './team-lead-decision-surface.js'

const call = (id: string): ModelToolCall => ({
  id,
  name: 'Write',
  input: {},
})

describe('SerializedTeamLeadDecisionSurface', () => {
  it('runs requests FIFO, without overlap, and recovers after rejection', async () => {
    let active = 0
    let maximum = 0
    const order: string[] = []
    const surface = new SerializedTeamLeadDecisionSurface(async (request) => {
      active += 1
      maximum = Math.max(maximum, active)
      order.push(request.id)
      await Promise.resolve()
      active -= 1
      if (request.id === 'first') throw new Error('rejected')
      return { behavior: 'allow' }
    })

    const first = surface.request({
      call: call('first'),
      decision: { behavior: 'ask', reason: 'first' },
      teamId: 'team',
      member: 'member',
      taskId: 'task',
      generation: 0,
    })
    const second = surface.request({
      call: call('second'),
      decision: { behavior: 'ask', reason: 'second' },
      teamId: 'team',
      member: 'member',
      taskId: 'task',
      generation: 0,
    })

    await expect(first).rejects.toThrow('rejected')
    await expect(second).resolves.toEqual({ behavior: 'allow' })
    expect(order).toEqual(['first', 'second'])
    expect(maximum).toBe(1)
  })
})
