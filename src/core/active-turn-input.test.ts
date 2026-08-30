import { describe, expect, it } from 'vitest'

import { ActiveTurnInputMailbox } from './active-turn-input.js'

describe('ActiveTurnInputMailbox', () => {
  it('trims input, preserves FIFO order, and creates stable ids', () => {
    let nextId = 0
    const mailbox = new ActiveTurnInputMailbox(() => `input-${++nextId}`)

    expect(mailbox.enqueue('  first  ')).toEqual({
      kind: 'accepted',
      item: { id: 'input-1', content: 'first' },
    })
    expect(mailbox.enqueue('\tsecond\n')).toEqual({
      kind: 'accepted',
      item: { id: 'input-2', content: 'second' },
    })
    expect(mailbox.enqueue('  \n')).toEqual({ kind: 'empty' })
    expect(mailbox.take()).toEqual({ id: 'input-1', content: 'first' })
    expect(mailbox.take()).toEqual({
      id: 'input-2',
      content: 'second',
    })
    expect(mailbox.take()).toBeUndefined()
  })

  it('atomically seals an empty mailbox and rejects later enqueue', () => {
    const mailbox = new ActiveTurnInputMailbox(() => 'fixed')
    expect(mailbox.takeOrSeal()).toBeUndefined()
    expect(mailbox.isSealed()).toBe(true)
    expect(mailbox.enqueue('later')).toEqual({ kind: 'sealed' })
  })

  it('takes one completion item before sealing and can withdraw pending items', () => {
    let nextId = 0
    const mailbox = new ActiveTurnInputMailbox(() => `input-${++nextId}`)
    const first = mailbox.enqueue('first')
    const second = mailbox.enqueue('second')
    if (first.kind !== 'accepted' || second.kind !== 'accepted')
      throw new Error('expected accepted inputs')
    expect(mailbox.takeOrSeal()).toEqual(first.item)
    expect(mailbox.withdraw(second.item.id)).toEqual({
      kind: 'withdrawn',
      item: second.item,
    })
    expect(mailbox.takeOrSeal()).toBeUndefined()
    expect(mailbox.withdraw('missing')).toEqual({ kind: 'not-pending' })
  })

  it('close seals and returns all undelivered inputs', () => {
    const mailbox = new ActiveTurnInputMailbox(() => 'id')
    mailbox.enqueue('one')
    mailbox.enqueue('two')
    expect(mailbox.close()).toEqual([
      { id: 'id', content: 'one' },
      { id: 'id', content: 'two' },
    ])
    expect(mailbox.close()).toEqual([])
    expect(mailbox.enqueue('three')).toEqual({ kind: 'sealed' })
  })
})
