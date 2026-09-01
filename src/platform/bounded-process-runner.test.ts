import { describe, expect, it } from 'vitest'
import { BoundedProcessRunner } from './bounded-process-runner.js'

describe('bounded process runner', () => {
  it('supports explicit no-inheritance environments and redacts explicit secrets', async () => {
    const sentinel = `PRAXIS_SENTINEL_${Date.now()}`
    const old = process.env[sentinel]
    process.env[sentinel] = 'ambient-value'
    try {
      const result = await new BoundedProcessRunner({
        cwd: process.cwd(),
        maxOutputBytes: 4096,
      }).run({
        command: process.execPath,
        args: [
          '-e',
          `process.stdout.write(JSON.stringify({ambient:process.env.${sentinel}||null, benign:process.env.PRXIS_BENIGN, secret:process.env.PRXIS_SECRET}))`,
        ],
        timeoutMs: 5000,
        inheritEnvironment: false,
        redactExplicitEnvironment: true,
        env: {
          PRXIS_BENIGN: 'explicit-value',
          PRXIS_SECRET: 'explicit-secret',
        },
      })
      expect(result.stdout).toContain('explicit-value')
      expect(result.stdout).not.toContain('explicit-secret')
      expect(result.stdout).toContain('[REDACTED]')
      expect(result.stdout).toContain('"ambient":null')
    } finally {
      if (old === undefined) delete process.env[sentinel]
      else process.env[sentinel] = old
    }
  })
})
