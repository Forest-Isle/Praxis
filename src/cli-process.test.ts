import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

const CLI_ENTRY = fileURLToPath(new URL('./cli.ts', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

async function snapshotFilesystemTree(
  root: string,
): Promise<Array<{ path: string; kind: string; mode: number; hash?: string }>> {
  const output: Array<{
    path: string
    kind: string
    mode: number
    hash?: string
  }> = []
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current)
    for (const name of entries) {
      const path = join(current, name)
      const info = await lstat(path)
      const rel = relative(root, path)
      if (info.isSymbolicLink()) throw new Error(`unexpected symlink: ${rel}`)
      if (info.isDirectory()) {
        output.push({ path: rel, kind: 'directory', mode: info.mode & 0o777 })
        await visit(path)
      } else if (info.isFile()) {
        const bytes = await readFile(path)
        output.push({
          path: rel,
          kind: 'file',
          mode: info.mode & 0o777,
          hash: createHash('sha256').update(bytes).digest('hex'),
        })
      } else {
        throw new Error(`unexpected native entry: ${rel}`)
      }
    }
  }
  await visit(root)
  return output.sort((a, b) => a.path.localeCompare(b.path))
}

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
    'reads a print prompt from piped stdin in the direct process',
    { timeout: 60_000 },
    async () => {
      configDir = await mkdtemp(join(tmpdir(), 'praxis-cli-process-'))
      const requestBodies: string[] = []
      let resolveRequest: (() => void) | undefined
      const requestReceived = new Promise<void>((resolve) => {
        resolveRequest = resolve
      })
      server = createServer((request, response) => {
        let body = ''
        request.setEncoding('utf8')
        request.on('data', (chunk: string) => {
          body += chunk
        })
        request.on('end', () => {
          requestBodies.push(body)
          resolveRequest?.()
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.end(
            [
              'data: {"choices":[{"delta":{"content":"process answer"}}]}',
              '',
              'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
              '',
              'data: [DONE]',
              '',
              '',
            ].join('\n'),
          )
        })
      })
      server.listen(0, '127.0.0.1')
      await new Promise<void>((resolve) => server?.once('listening', resolve))
      const address = server.address()
      if (address === null || typeof address === 'string') {
        throw new Error('print provider server has no TCP address')
      }
      const providerUrl = `http://127.0.0.1:${address.port}/v1`

      const childEnv: Record<string, string> = {}
      for (const [key, value] of Object.entries(process.env)) {
        if (
          value !== undefined &&
          key !== 'NODE_OPTIONS' &&
          !key.startsWith('PRAXIS_') &&
          !key.startsWith('CLAUDE_') &&
          !key.startsWith('ANTHROPIC_') &&
          !key.startsWith('OPENAI_') &&
          !key.startsWith('DEEPSEEK_')
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
        ['--import', 'tsx', CLI_ENTRY, '-p'],
        {
          cwd: REPO_ROOT,
          env: childEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
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
        child.stdin?.end('process stdin prompt\n')
        await Promise.race([
          requestReceived,
          new Promise<never>((_, reject) => {
            setTimeout(
              () =>
                reject(new Error('print provider request was not received')),
              30_000,
            )
          }),
        ])
        const exitCode = await waitForExit(child, 30_000)
        expect(exitCode).toBe(0)
        expect(
          requestBodies.some((body) => body.includes('process stdin prompt')),
        ).toBe(true)
        expect(stdout).toBe('process answer\n')
        expect(stderr).toBe('')
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

  it(
    'preserves the native footprint when session persistence is disabled',
    { timeout: 120_000 },
    async () => {
      configDir = await mkdtemp(join(tmpdir(), 'praxis-cli-footprint-'))
      const nativeRoot = join(configDir, 'native')
      const cwd = join(configDir, 'cwd')
      const home = join(configDir, 'home')
      await Promise.all([mkdir(nativeRoot), mkdir(cwd), mkdir(home)])
      const credentialName = 'PRAXIS_CLI_FOOTPRINT_FAKE_KEY'
      const credential = 'footprint-test-secret-763'
      const model = 'footprint-deterministic-model'
      const customProvider = 'footprint-provider'
      const settingsPath = join(nativeRoot, 'settings.json')
      await writeFile(
        settingsPath,
        JSON.stringify(
          {
            experimental: { codexResponses: true },
            provider: customProvider,
            model,
            providers: {
              [customProvider]: {
                protocol: 'codex-responses',
                profiles: {
                  default: {
                    baseUrl: 'http://127.0.0.1:0/v1',
                    credential: { source: 'env', name: credentialName },
                  },
                },
              },
            },
          },
          null,
          2,
        ) + '\n',
        { mode: 0o600 },
      )
      let requestCount = 0
      let requestBody = ''
      let authorization = ''
      let accept = ''
      let contentType = ''
      let originator = ''
      let openaiBeta = ''
      let requestUrl = ''
      let requestMethod = ''
      const requestReceived = new Promise<void>((resolve) => {
        server = createServer((request, response) => {
          requestCount += 1
          requestUrl = request.url ?? ''
          requestMethod = request.method ?? ''
          authorization = String(request.headers.authorization ?? '')
          accept = String(request.headers.accept ?? '')
          contentType = String(request.headers['content-type'] ?? '')
          originator = String(request.headers.originator ?? '')
          openaiBeta = String(request.headers['openai-beta'] ?? '')
          request.setEncoding('utf8')
          request.on('data', (chunk: string) => {
            requestBody += chunk
          })
          request.on('end', () => {
            response.writeHead(200, { 'content-type': 'text/event-stream' })
            response.end(
              'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"footprint answer"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
            )
            resolve()
          })
        })
        server.listen(0, '127.0.0.1')
      })
      await new Promise<void>((resolve) => server?.once('listening', resolve))
      const address = server?.address()
      if (
        address === null ||
        address === undefined ||
        typeof address === 'string'
      )
        throw new Error('footprint server has no TCP address')
      const settings = JSON.parse(
        await readFile(settingsPath, 'utf8'),
      ) as Record<string, unknown>
      ;(
        (settings.providers as Record<string, unknown>)[
          customProvider
        ] as Record<string, unknown>
      ).profiles = {
        default: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          credential: { source: 'env', name: credentialName },
        },
      }
      await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', {
        mode: 0o600,
      })
      const settingsBefore = await snapshotFilesystemTree(nativeRoot)
      const cwdBefore = await snapshotFilesystemTree(cwd)
      const homeBefore = await snapshotFilesystemTree(home)
      const childEnv: Record<string, string> = {
        PATH: process.env.PATH ?? '',
        HOME: home,
        PRAXIS_HOME: nativeRoot,
        [credentialName]: credential,
        NODE_ENV: 'test',
      }
      const child = spawn(
        process.execPath,
        [
          '--import',
          join(REPO_ROOT, 'node_modules/tsx/dist/loader.mjs'),
          CLI_ENTRY,
          '-p',
          '--max-turns',
          '1',
          '--disable-slash-commands',
          '--no-session-persistence',
          'hello',
        ],
        { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
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
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(`footprint request timeout: ${stderr || stdout}`),
                ),
              30_000,
            ),
          ),
        ])
        const exitCode = await waitForExit(child, 30_000)
        expect(exitCode).toBe(0)
        expect(requestCount).toBe(1)
        expect(requestMethod).toBe('POST')
        expect(requestUrl).toBe('/v1/responses')
        expect(authorization).toBe(`Bearer ${credential}`)
        expect(accept).toBe('text/event-stream')
        expect(contentType).toBe('application/json')
        expect(originator).toBe('praxis')
        expect(openaiBeta).toBe('responses=experimental')
        expect(requestBody).toContain(`"model":"${model}"`)
        expect(requestBody).not.toContain(credential)
        const parsedRequest = JSON.parse(requestBody) as Record<string, unknown>
        expect(parsedRequest).toMatchObject({
          model,
          store: false,
          stream: true,
          include: ['reasoning.encrypted_content'],
          tool_choice: 'auto',
          parallel_tool_calls: true,
        })
        expect(parsedRequest.input).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'message',
              role: 'user',
              content: expect.arrayContaining([
                expect.objectContaining({ type: 'input_text', text: 'hello' }),
              ]),
            }),
          ]),
        )
        expect(stdout).toBe('footprint answer\n')
        expect(stderr).toBe('')
        expect(await snapshotFilesystemTree(cwd)).toEqual(cwdBefore)
        expect(await snapshotFilesystemTree(home)).toEqual(homeBefore)
        const nativeRootAfter = await snapshotFilesystemTree(nativeRoot)
        const memoryEntries = nativeRootAfter.filter(
          (entry) =>
            entry.path === 'memory' || entry.path.startsWith('memory/'),
        )
        const stateEntries = nativeRootAfter.filter(
          (entry) => entry.path === 'state' || entry.path.startsWith('state/'),
        )
        const directoryMode = 0o777 & ~process.umask()
        const descriptors = nativeRootAfter.map(({ path, kind, mode }) => ({
          path,
          kind,
          mode,
        }))
        const canonicalCwd = await realpath(cwd)
        expect(canonicalCwd.length).toBeLessThanOrEqual(200)
        const projectMemory = join(
          'memory',
          canonicalCwd.replace(/[^a-zA-Z0-9]/gu, '-'),
        )
        expect(descriptors).toEqual([
          { path: 'memory', kind: 'directory', mode: directoryMode },
          { path: projectMemory, kind: 'directory', mode: directoryMode },
          { path: 'settings.json', kind: 'file', mode: 0o600 },
          { path: 'state', kind: 'directory', mode: directoryMode },
          { path: 'state.json', kind: 'file', mode: 0o600 },
          { path: 'state/locks', kind: 'directory', mode: directoryMode },
          {
            path: 'state/unknown-cost-sidecar.json',
            kind: 'file',
            mode: 0o600,
          },
        ])
        expect(
          memoryEntries.filter((entry) => entry.kind === 'directory'),
        ).toHaveLength(2)
        expect(
          memoryEntries.filter((entry) => entry.kind === 'file'),
        ).toHaveLength(0)
        expect(
          stateEntries.find((entry) => entry.path === 'state/locks')?.kind,
        ).toBe('directory')
        for (const file of nativeRootAfter.filter(
          (entry) => entry.kind === 'file',
        )) {
          expect(
            await readFile(join(nativeRoot, file.path), 'utf8'),
          ).not.toContain(credential)
        }
        expect(
          (await snapshotFilesystemTree(cwd)).every(
            (entry) => entry.kind === 'directory',
          ),
        ).toBe(true)
        expect(
          nativeRootAfter.some(
            (entry) =>
              entry.path.includes('sessions') ||
              entry.path.includes('history') ||
              entry.path.includes('tasks') ||
              entry.path.endsWith('.jsonl'),
          ),
        ).toBe(false)
        expect(
          nativeRootAfter.find((entry) => entry.path === 'settings.json')?.hash,
        ).toBe(
          settingsBefore.find((entry) => entry.path === 'settings.json')?.hash,
        )
        expect(
          nativeRootAfter.find((entry) => entry.path === 'settings.json')?.mode,
        ).toBe(0o600)
        const files = nativeRootAfter.filter((entry) => entry.kind === 'file')
        expect(files.map((entry) => entry.path).sort()).toEqual(
          expect.arrayContaining([
            'settings.json',
            'state.json',
            'state/unknown-cost-sidecar.json',
          ]),
        )
        expect(JSON.stringify(nativeRootAfter)).not.toContain(credential)
        const state = JSON.parse(
          await readFile(join(nativeRoot, 'state.json'), 'utf8'),
        ) as {
          projects?: Record<
            string,
            {
              lastSessionId?: string
              lastModelUsage?: Record<string, unknown>
              lastCost?: number
            }
          >
        }
        expect(Object.keys(state)).toEqual(['projects'])
        expect(Object.keys(state.projects ?? {})).toEqual([canonicalCwd])
        const project = state.projects?.[canonicalCwd]
        expect(Object.keys(project ?? {}).sort()).toEqual([
          'lastAPIDuration',
          'lastAPIDurationWithoutRetries',
          'lastCost',
          'lastDuration',
          'lastLinesAdded',
          'lastLinesRemoved',
          'lastModelUsage',
          'lastSessionId',
          'lastToolDuration',
          'lastTotalCacheCreationInputTokens',
          'lastTotalCacheReadInputTokens',
          'lastTotalInputTokens',
          'lastTotalOutputTokens',
          'lastTotalWebSearchRequests',
        ])
        expect(project?.lastSessionId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
        )
        expect(project?.lastModelUsage).toBeDefined()
        expect(typeof project?.lastCost).toBe('number')
        for (const key of [
          'lastCost',
          'lastAPIDuration',
          'lastAPIDurationWithoutRetries',
          'lastToolDuration',
          'lastDuration',
        ]) {
          const value = project?.[key as keyof typeof project] as number
          expect(Number.isFinite(value) && value >= 0).toBe(true)
        }
        for (const key of [
          'lastLinesAdded',
          'lastLinesRemoved',
          'lastTotalInputTokens',
          'lastTotalOutputTokens',
          'lastTotalCacheCreationInputTokens',
          'lastTotalCacheReadInputTokens',
          'lastTotalWebSearchRequests',
        ]) {
          const value = project?.[key as keyof typeof project] as number
          expect(Number.isSafeInteger(value) && value >= 0).toBe(true)
        }
        expect(Object.keys(project?.lastModelUsage ?? {})).toEqual([model])
        const modelUsage = project?.lastModelUsage?.[model] as
          Record<string, unknown> | undefined
        expect(Object.keys(modelUsage ?? {}).sort()).toEqual([
          'cacheCreationInputTokens',
          'cacheReadInputTokens',
          'costUSD',
          'inputTokens',
          'outputTokens',
          'webSearchRequests',
        ])
        for (const key of [
          'cacheCreationInputTokens',
          'cacheReadInputTokens',
          'inputTokens',
          'outputTokens',
          'webSearchRequests',
        ]) {
          const value = modelUsage?.[key]
          expect(Number.isSafeInteger(value) && Number(value) >= 0).toBe(true)
        }
        expect(
          typeof modelUsage?.costUSD === 'number' &&
            Number.isFinite(modelUsage.costUSD) &&
            modelUsage.costUSD >= 0,
        ).toBe(true)
        const sidecar = JSON.parse(
          await readFile(
            join(nativeRoot, 'state/unknown-cost-sidecar.json'),
            'utf8',
          ),
        ) as {
          version: number
          sessions: Record<string, { hasUnknownModelCost: boolean }>
        }
        expect(Object.keys(sidecar).sort()).toEqual(['sessions', 'version'])
        expect(sidecar.version).toBe(1)
        expect(Object.keys(sidecar.sessions)).toEqual([project?.lastSessionId])
        expect(sidecar.sessions[project?.lastSessionId ?? '']).toEqual({
          hasUnknownModelCost: true,
        })
        for (const file of files.filter(
          (entry) =>
            entry.path === 'state.json' ||
            entry.path === 'state/unknown-cost-sidecar.json',
        ))
          expect(file.mode).toBe(0o600)
        expect(await snapshotFilesystemTree(nativeRoot)).not.toContainEqual(
          expect.objectContaining({
            path: expect.stringMatching(
              /\.lock|\.tmp|\.candidate|\.stale|\.reclaim/,
            ),
          }),
        )
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL')
      }
    },
  )
})
