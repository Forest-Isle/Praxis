import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

const CLI_ENTRY = fileURLToPath(new URL('./cli.ts', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

function waitForExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<number | null> {
  return new Promise<number | null>((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode)
      return
    }
    const timer = setTimeout(() => {
      reject(new Error('direct CLI process did not exit in time'))
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

describe('direct process lifecycle', () => {
  let configDir: string | undefined
  let server: Server | undefined

  afterEach(async () => {
    if (server !== undefined) {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server?.close(() => resolve()))
      server = undefined
    }
    if (configDir !== undefined) {
      await rm(configDir, { recursive: true, force: true })
      configDir = undefined
    }
  })

  it(
    'terminates a hanging provider request via SIGTERM on the cancellation path',
    { timeout: 60_000 },
    async () => {
      configDir = await mkdtemp(join(tmpdir(), 'praxis-cli-process-'))
      let resolveRequest: (() => void) | undefined
      server = createServer(() => {
        // Hold the request open so the CLI remains awaiting the provider.
        resolveRequest?.()
      })
      server.listen(0, '127.0.0.1')
      await new Promise<void>((resolve) => server?.once('listening', resolve))
      const address = server.address()
      if (address === null || typeof address === 'string') {
        throw new Error('hanging provider server has no TCP address')
      }
      const providerUrl = `http://127.0.0.1:${address.port}/v1`

      const childEnv: Record<string, string> = {}
      for (const [key, value] of Object.entries(process.env)) {
        if (
          value !== undefined &&
          key !== 'NODE_OPTIONS' &&
          !key.startsWith('PRAXIS_') &&
          !key.startsWith('CLAUDE_')
        ) {
          childEnv[key] = value
        }
      }
      childEnv.PRAXIS_API_KEY = 'praxis-cli-process-test-key'
      childEnv.PRAXIS_MODEL = 'test-model'
      childEnv.PRAXIS_BASE_URL = providerUrl
      childEnv.PRAXIS_CLAUDE_BINARY = join(configDir, 'missing-claude')
      childEnv.PRAXIS_HOME = join(configDir, 'config')

      const child = spawn(
        process.execPath,
        ['--import', 'tsx', CLI_ENTRY, 'run', '--json', 'hello'],
        {
          cwd: REPO_ROOT,
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      let stdout = ''
      let stderr = ''
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk
      })

      try {
        const requestReceived = new Promise<void>((resolve) => {
          resolveRequest = resolve
        })
        await Promise.race([
          requestReceived,
          new Promise<never>((_, reject) => {
            setTimeout(
              () =>
                reject(new Error('provider request was not received in time')),
              30_000,
            )
          }),
        ])
        child.kill('SIGTERM')
        const exitCode = await waitForExit(child, 30_000)
        expect(exitCode).toBe(130)
        expect(stderr).toContain('Praxis run cancelled.')
        expect(stdout).not.toContain('"type":"error"')
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL')
        }
      }
    },
  )

  it(
    'exits silently on SIGINT while print output awaits a provider',
    { timeout: 120_000 },
    async () => {
      configDir = await mkdtemp(join(tmpdir(), 'praxis-cli-process-'))
      let resolveRequest: (() => void) | undefined
      server = createServer(() => {
        resolveRequest?.()
      })
      server.listen(0, '127.0.0.1')
      await new Promise<void>((resolve) => server?.once('listening', resolve))
      const address = server.address()
      if (address === null || typeof address === 'string') {
        throw new Error('hanging provider server has no TCP address')
      }
      const providerUrl = `http://127.0.0.1:${address.port}/v1`

      const childEnv: Record<string, string> = {}
      for (const [key, value] of Object.entries(process.env)) {
        if (
          value !== undefined &&
          key !== 'NODE_OPTIONS' &&
          !key.startsWith('PRAXIS_') &&
          !key.startsWith('CLAUDE_')
        ) {
          childEnv[key] = value
        }
      }
      childEnv.PRAXIS_API_KEY = 'praxis-cli-process-test-key'
      childEnv.PRAXIS_MODEL = 'test-model'
      childEnv.PRAXIS_BASE_URL = providerUrl
      childEnv.PRAXIS_CLAUDE_BINARY = join(configDir, 'missing-claude')
      childEnv.PRAXIS_HOME = join(configDir, 'config')

      const invocations = [
        ['run', '-p', 'hello'],
        ['run', '-p', '--output-format', 'json', 'hello'],
        ['run', '-p', '--output-format', 'stream-json', '--verbose', 'hello'],
      ]

      for (const args of invocations) {
        const requestReceived = new Promise<void>((resolve) => {
          resolveRequest = resolve
        })
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', CLI_ENTRY, ...args],
          {
            cwd: REPO_ROOT,
            env: childEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
        let stdout = ''
        let stderr = ''
        child.stdout?.setEncoding('utf8')
        child.stderr?.setEncoding('utf8')
        child.stdout?.on('data', (chunk: string) => {
          stdout += chunk
        })
        child.stderr?.on('data', (chunk: string) => {
          stderr += chunk
        })

        try {
          await Promise.race([
            requestReceived,
            new Promise<never>((_, reject) => {
              setTimeout(
                () =>
                  reject(
                    new Error('provider request was not received in time'),
                  ),
                30_000,
              )
            }),
          ])
          child.kill('SIGINT')
          const exitCode = await waitForExit(child, 30_000)
          expect(exitCode).toBe(0)
          expect(stderr).not.toContain('Praxis run cancelled.')

          if (args.includes('stream-json')) {
            const records = stdout
              .trim()
              .split('\n')
              .filter(Boolean)
              .map(
                (line) =>
                  JSON.parse(line) as { type?: string; subtype?: string },
              )
            expect(records).toContainEqual(
              expect.objectContaining({ type: 'system', subtype: 'init' }),
            )
            expect(records).not.toContainEqual(
              expect.objectContaining({ type: 'assistant' }),
            )
            expect(records).not.toContainEqual(
              expect.objectContaining({ type: 'result' }),
            )
            expect(records).not.toContainEqual(
              expect.objectContaining({ type: 'error' }),
            )
          } else {
            expect(stdout).toBe('')
          }
        } finally {
          resolveRequest = undefined
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL')
          }
        }
      }
    },
  )
})
