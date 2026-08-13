import { describe, expect, it, vi } from 'vitest'

import { notifyTerminal } from './terminal-notifications.js'

describe('terminal notifications', () => {
  it('selects the detected local terminal for auto and keeps untrusted control bytes out', () => {
    const write = vi.fn()
    notifyTerminal({
      channel: 'auto',
      title: 'Praxis\u001b',
      message: 'done\u0007',
      environment: { TERM_PROGRAM: 'Ghostty' },
      write,
    })
    expect(write).toHaveBeenCalledWith('\u001b]9;Praxis: done\u0007')
  })

  it('honors disabled notifications and explicit bell channels', () => {
    const write = vi.fn()
    notifyTerminal({
      channel: 'notifications_disabled',
      title: 'Praxis',
      message: 'done',
      write,
    })
    expect(write).not.toHaveBeenCalled()
    notifyTerminal({
      channel: 'terminal_bell',
      title: 'Praxis',
      message: 'done',
      write,
    })
    expect(write).toHaveBeenCalledWith('\u0007')
  })
})
