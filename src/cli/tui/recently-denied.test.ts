import { describe, expect, it } from 'vitest'

import {
  createRecentlyDeniedStore,
  type RecentlyDeniedAction,
} from './recently-denied.js'

function action(id: string, display = 'Delete target'): RecentlyDeniedAction {
  return {
    id,
    call: {
      id: `call-${id}`,
      name: 'Bash',
      input: { command: 'rm -rf /tmp/target', description: display },
    },
    display,
    reason: 'Classifier policy',
    sessionId: '11111111-1111-4111-8111-111111111111',
  }
}

describe('recently denied session state', () => {
  it('retains duplicates newest-first', async () => {
    const store = createRecentlyDeniedStore()
    await store.record(action('one'))
    await store.record(action('two'))

    expect(await store.load()).toEqual([action('two'), action('one')])
  })

  it('removes only the selected denial', async () => {
    const store = createRecentlyDeniedStore()
    await store.record(action('one'))
    await store.record(action('two'))

    await expect(store.remove('two')).resolves.toEqual([action('one')])
  })

  it('starts empty for each InteractiveApp process store', async () => {
    const first = createRecentlyDeniedStore()
    await first.record(action('one'))

    await expect(createRecentlyDeniedStore().load()).resolves.toEqual([])
  })
})
