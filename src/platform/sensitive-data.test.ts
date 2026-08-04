import { describe, expect, it } from 'vitest'

import {
  redactSensitiveError,
  redactSensitiveText,
  redactSensitiveValue,
  sanitizeChildEnvironment,
  sensitiveEnvironmentValues,
} from './sensitive-data.js'

describe('sensitive data boundaries', () => {
  it('removes ambient credentials while preserving runtime variables and explicit overrides', () => {
    const environment = sanitizeChildEnvironment(
      {
        PRAXIS_API_KEY: 'explicit-api-key',
        MARKER: 'visible',
      },
      {
        PATH: '/usr/bin',
        HOME: '/tmp/home',
        PRAXIS_API_KEY: 'ambient-api-key',
        AWS_ACCESS_KEY_ID: 'ambient-access-key',
        DOCKER_AUTH_CONFIG: 'ambient-docker-auth',
        GH_TOKEN: 'ambient-token',
        GITHUB_PAT: 'ambient-pat',
        NPM_CONFIG__AUTH: 'ambient-npm-auth',
        NPM_CONFIG_REGISTRY_AUTHTOKEN: 'ambient-npm-token',
        PGPASSWORD: 'ambient-pg-password',
        SERVICE_PASSWORD: 'ambient-password',
        GOOGLE_APPLICATION_CREDENTIALS: '/tmp/credentials.json',
        AUTHORIZATION: 'Bearer ambient-auth',
        COOKIE: 'session=ambient-cookie',
        BASH_ENV: '/tmp/ambient-startup',
      },
    )

    expect(environment).toEqual({
      PATH: '/usr/bin',
      HOME: '/tmp/home',
      PRAXIS_API_KEY: 'explicit-api-key',
      MARKER: 'visible',
    })
  })

  it('redacts exact sensitive values and authorization payloads', () => {
    const values = sensitiveEnvironmentValues({
      PRAXIS_API_KEY: 'shorter-secret',
      AUTHORIZATION: 'Bearer longer-secret-token',
      COOKIE: 'session=cookie-secret; theme=dark',
      MARKER: 'visible',
    })

    expect(
      redactSensitiveText(
        'shorter-secret Bearer longer-secret-token longer-secret-token cookie-secret visible',
        values,
      ),
    ).toBe('[REDACTED] [REDACTED] [REDACTED] [REDACTED] visible')
    expect(
      redactSensitiveValue(
        {
          description: 'longer-secret-token',
          nested: ['shorter-secret'],
          'shorter-secret': true,
        },
        values,
      ),
    ).toEqual({
      description: '[REDACTED]',
      nested: ['[REDACTED]'],
      '[REDACTED]': true,
    })

    const escapedValues = sensitiveEnvironmentValues({
      API_KEY: 'quoted"secret\nline',
      TOKEN: 'x',
    })
    const serialized = JSON.stringify({ secret: 'quoted"secret\nline' })
    expect(redactSensitiveText(serialized, escapedValues)).not.toContain(
      'quoted',
    )
    expect(redactSensitiveText('x', escapedValues)).toBe('[REDACTED]')
  })

  it('rebuilds errors without secrets in nested diagnostic fields', () => {
    const secret = 'nested-error-secret'
    const cause = new Error(`cause ${secret}`)
    const source = new Error('clean message', { cause }) as Error & {
      details: unknown
    }
    const circular: Record<string, unknown> = { token: secret }
    circular.self = circular
    source.stack = `stack ${secret}`
    source.details = circular

    const sanitized = redactSensitiveError(source, [secret]) as Error & {
      details: unknown
    }

    expect(sanitized).not.toBe(source)
    expect(sanitized.message).toBe('clean message')
    expect(sanitized.stack).toBe('stack [REDACTED]')
    expect((sanitized.cause as Error).message).toBe('cause [REDACTED]')
    expect(sanitized.details).toEqual({
      token: '[REDACTED]',
      self: '[Circular]',
    })
  })
})
