import { describe, expect, it, vi } from 'vitest'

import { suspendTuiProcess } from './terminal-suspend.js'

const SUSPEND_NOTICE =
  'Praxis Code has been suspended. Run `fg` to bring Praxis Code back.\n' +
  'Note: ctrl + z now suspends Praxis Code, ctrl + _ undoes input.\n\n'

describe('TUI process suspension', () => {
  it('prints the Claude-compatible notice before stopping the process', () => {
    const calls: string[] = []
    suspendTuiProcess({
      write(message) {
        calls.push(`write:${message}`)
      },
      stop() {
        calls.push('stop')
      },
    })

    expect(calls).toEqual([`write:${SUSPEND_NOTICE}`, 'stop'])
  })

  it('targets the current process with SIGTSTP by default', () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    try {
      suspendTuiProcess()
      expect(write).toHaveBeenCalledWith(SUSPEND_NOTICE)
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTSTP')
    } finally {
      kill.mockRestore()
      write.mockRestore()
    }
  })
})
