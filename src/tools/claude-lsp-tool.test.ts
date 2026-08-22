import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import type { ModelToolCall, ToolRegistry } from '../core/runtime.js'
import type { ClaudePluginLspServer } from '../plugins/claude-plugin-runtime.js'
import { formatClaudeLspResult } from './claude-lsp-formatters.js'
import { ClaudeLspToolManager } from './claude-lsp-tool.js'

const roots: string[] = []
const execFileAsync = promisify(execFile)

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

const serverScript = String.raw`
const fs = require('node:fs')
let buffer = Buffer.alloc(0)
const notifications = []
let initialized = false
if (process.env.LSP_PID_FILE) fs.writeFileSync(process.env.LSP_PID_FILE, String(process.pid))
function send(value) {
  const body = Buffer.from(JSON.stringify(value))
  process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n'), body]))
}
function receive(message) {
  if (message.method === 'exit') process.exit(0)
  if (message.id === undefined) {
    notifications.push(message)
    return
  }
  if (message.method === undefined) {
    if (process.env.LSP_CONFIG_RESPONSE_FILE && message.id === 'server-config') {
      fs.writeFileSync(process.env.LSP_CONFIG_RESPONSE_FILE, JSON.stringify(message.result))
    }
    return
  }
  if (message.method === 'initialize') {
    const respond = () => {
      initialized = true
      send({jsonrpc:'2.0', id:message.id, result:{capabilities:{}}})
      if (process.env.LSP_CONFIG_RESPONSE_FILE) {
        setTimeout(() => send({jsonrpc:'2.0',id:'server-config',method:'workspace/configuration',params:{items:[{section:'fixture'}]}}), 5)
      }
    }
    const delay = Number(process.env.LSP_INITIALIZE_DELAY || 0)
    if (delay > 0) setTimeout(respond, delay)
    else respond()
    return
  }
  if (message.method === 'shutdown') return send({jsonrpc:'2.0', id:message.id, result:null})
  if (!initialized) return send({jsonrpc:'2.0',id:message.id,error:{code:-32002,message:'server not initialized'}})
  if (message.method === 'workspace/symbol' && message.params.query === 'hang') return
  const uri = message.params?.textDocument?.uri || 'file:///fixture/main.fixture'
  const position = message.params?.position || {line:0,character:0}
  const range = {start:position,end:{line:position.line,character:position.character + 1}}
  const item = {name:'main',kind:12,uri,range,selectionRange:range}
  const location = {uri,range}
  if (message.method === 'textDocument/definition' || message.method === 'textDocument/implementation') {
    return send({jsonrpc:'2.0', id:message.id, result:{targetUri:uri,targetRange:range,targetSelectionRange:range}})
  }
  if (message.method === 'textDocument/references') {
    const locations = [location]
    if (process.env.LSP_IGNORED_URI) locations.push({uri:process.env.LSP_IGNORED_URI,range})
    return send({jsonrpc:'2.0', id:message.id, result:locations})
  }
  if (message.method === 'textDocument/hover') {
    if (process.env.LSP_CONTENT_MODIFIED_ONCE_FILE && !fs.existsSync(process.env.LSP_CONTENT_MODIFIED_ONCE_FILE)) {
      fs.writeFileSync(process.env.LSP_CONTENT_MODIFIED_ONCE_FILE, 'retried')
      return send({jsonrpc:'2.0',id:message.id,error:{code:-32801,message:'content modified'}})
    }
    if (process.env.LSP_CRASH_ONCE_FILE && !fs.existsSync(process.env.LSP_CRASH_ONCE_FILE)) {
      fs.writeFileSync(process.env.LSP_CRASH_ONCE_FILE, 'crashed')
      process.exit(23)
    }
    const details = 'explicit=' + (process.env.EXPLICIT_LSP_ENV || '') +
      ';token=' + (process.env.LSP_API_TOKEN || '') +
      ';arg=' + (process.argv.at(-1) || '') +
      ';ambient=' + (process.env.PRAXIS_LSP_SECRET || '') +
      ';notifications=' + notifications.map(value => value.method).join(',')
    return send({jsonrpc:'2.0', id:message.id, result:{contents:{kind:'markdown',value:details},range}})
  }
  if (message.method === 'textDocument/documentSymbol') return send({jsonrpc:'2.0', id:message.id, result:[item]})
  if (message.method === 'workspace/symbol') return send({jsonrpc:'2.0', id:message.id, result:[{name:message.params.query,kind:12,location}]})
  if (message.method === 'textDocument/prepareCallHierarchy') {
    return send({jsonrpc:'2.0', id:message.id, result:process.env.LSP_EMPTY_CALL_ITEMS ? [] : process.env.LSP_MULTIPLE_CALL_ITEMS ? [item,{...item,name:'second'}] : [item]})
  }
  if (message.method === 'callHierarchy/incomingCalls') return send({jsonrpc:'2.0', id:message.id, result:[{from:message.params.item,fromRanges:[range]}]})
  if (message.method === 'callHierarchy/outgoingCalls') return send({jsonrpc:'2.0', id:message.id, result:[{to:message.params.item,fromRanges:[range]}]})
  send({jsonrpc:'2.0', id:message.id, result:null})
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk])
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd < 0) return
    const header = buffer.subarray(0, headerEnd).toString('ascii')
    const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1])
    const start = headerEnd + 4
    if (buffer.length < start + length) return
    const body = buffer.subarray(start, start + length)
    buffer = buffer.subarray(start + length)
    receive(JSON.parse(body.toString('utf8')))
  }
})
`

const base: ToolRegistry = {
  definitions: () => [],
  schedulingPolicy: () => ({ concurrency: 'concurrent' }),
  prepare: async (call) => call,
  execute: async () => ({ content: 'base', isError: false }),
}

function call(
  id: string,
  operation: string,
  filePath: string,
  extra: Record<string, unknown> = {},
): ModelToolCall {
  return {
    id,
    name: 'LSP',
    input: { operation, filePath, line: 2, character: 3, ...extra },
  }
}

async function fixture(): Promise<{
  root: string
  file: string
  pidFile: string
  configResponseFile: string
  definition: ClaudePluginLspServer
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'praxis-lsp-')))
  roots.push(root)
  const file = join(root, 'main.fixture')
  const pidFile = join(root, 'server.pid')
  const configResponseFile = join(root, 'config-response.json')
  await writeFile(file, 'first\nsecond\n')
  return {
    root,
    file,
    pidFile,
    configResponseFile,
    definition: {
      name: 'fixture',
      pluginName: 'fixture-plugin',
      pluginRoot: root,
      command: process.execPath,
      args: ['-e', serverScript, 'argument-only-secret'],
      env: {
        EXPLICIT_LSP_ENV: 'allowed',
        LSP_API_TOKEN: 'explicit-secret',
        LSP_PID_FILE: pidFile,
        LSP_CONFIG_RESPONSE_FILE: configResponseFile,
      },
      extensionToLanguage: { '.fixture': 'fixture' },
      sensitiveValues: ['only-secret', 'argument-only-secret', ''],
    },
  }
}

async function eventuallyStopped(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

async function eventuallyReadJson(path: string): Promise<unknown> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
        !(error instanceof SyntaxError)
      )
        throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return JSON.parse(await readFile(path, 'utf8'))
}

describe('Claude LSP tool', () => {
  it('formats every operation with Claude-compatible text', () => {
    const cwd = '/workspace'
    const uri = 'file:///workspace/main.fixture'
    const range = {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 13 },
    }
    const location = { uri, range }
    const item = {
      name: 'fixtureSymbol',
      kind: 12,
      uri,
      range,
      selectionRange: range,
    }

    expect(formatClaudeLspResult('goToDefinition', location, cwd)).toBe(
      'Defined in main.fixture:1:1',
    )
    expect(
      formatClaudeLspResult(
        'goToImplementation',
        {
          targetUri: uri,
          targetRange: range,
          targetSelectionRange: range,
        },
        cwd,
      ),
    ).toBe('Defined in main.fixture:1:1')
    expect(formatClaudeLspResult('findReferences', [location], cwd)).toBe(
      'Found 1 reference:\n  main.fixture:1:1',
    )
    expect(
      formatClaudeLspResult(
        'hover',
        {
          contents: [
            { language: 'fixture', value: 'signature' },
            { kind: 'markdown', value: '**fixture hover**' },
          ],
          range,
        },
        cwd,
      ),
    ).toBe('Hover info at 1:1:\n\nsignature\n\n**fixture hover**')
    expect(
      formatClaudeLspResult(
        'documentSymbol',
        [
          {
            name: 'fixtureSymbol',
            detail: '(): void',
            kind: 12,
            range,
            selectionRange: range,
            children: [
              {
                name: 'value',
                kind: 13,
                range,
                selectionRange: range,
              },
            ],
          },
        ],
        cwd,
      ),
    ).toBe(
      'Document symbols:\nfixtureSymbol (Function) (): void - Line 1\n  value (Variable) - Line 1',
    )
    expect(
      formatClaudeLspResult(
        'workspaceSymbol',
        [
          {
            name: 'fixtureSymbol',
            kind: 12,
            containerName: 'Fixture',
            location,
          },
        ],
        cwd,
      ),
    ).toBe(
      'Found 1 symbol in workspace:\n\nmain.fixture:\n  fixtureSymbol (Function) - Line 1 in Fixture',
    )
    expect(formatClaudeLspResult('prepareCallHierarchy', [item], cwd)).toBe(
      'Call hierarchy item: fixtureSymbol (Function) - main.fixture:1',
    )
    expect(
      formatClaudeLspResult(
        'incomingCalls',
        [{ from: item, fromRanges: [range] }],
        cwd,
      ),
    ).toBe(
      'Found 1 incoming call:\n\nmain.fixture:\n  fixtureSymbol (Function) - Line 1 [calls at: 1:1]',
    )
    expect(
      formatClaudeLspResult(
        'outgoingCalls',
        [{ to: item, fromRanges: [range] }],
        cwd,
      ),
    ).toBe(
      'Found 1 outgoing call:\n\nmain.fixture:\n  fixtureSymbol (Function) - Line 1 [called from: 1:1]',
    )
  })

  it('formats empty and grouped LSP results without simplified fallbacks', () => {
    const cwd = '/workspace'
    const range = {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 },
    }
    expect(formatClaudeLspResult('goToDefinition', null, cwd)).toContain(
      'No definition found.',
    )
    expect(formatClaudeLspResult('findReferences', [], cwd)).toContain(
      'No references found.',
    )
    expect(formatClaudeLspResult('hover', null, cwd)).toContain(
      'No hover information available.',
    )
    expect(formatClaudeLspResult('documentSymbol', [], cwd)).toContain(
      'No symbols found in document.',
    )
    expect(formatClaudeLspResult('workspaceSymbol', [], cwd)).toContain(
      'No symbols found in workspace.',
    )
    expect(formatClaudeLspResult('prepareCallHierarchy', [], cwd)).toBe(
      'No call hierarchy item found at this position',
    )
    expect(formatClaudeLspResult('incomingCalls', [], cwd)).toBe(
      'No incoming calls found (nothing calls this function)',
    )
    expect(formatClaudeLspResult('outgoingCalls', [], cwd)).toBe(
      'No outgoing calls found (this function calls nothing)',
    )
    expect(
      formatClaudeLspResult(
        'findReferences',
        [
          { uri: 'file:///workspace/a.fixture', range },
          { uri: 'file:///workspace/a.fixture', range },
          { uri: 'file:///workspace/b.fixture', range },
        ],
        cwd,
      ),
    ).toBe(
      'Found 3 references across 2 files:\n\na.fixture:\n  Line 1:1\n  Line 1:1\n\nb.fixture:\n  Line 1:1',
    )
  })

  it('exposes the Claude schema and executes document and workspace operations', async () => {
    const { root, file, configResponseFile, definition } = await fixture()
    const manager = new ClaudeLspToolManager({
      servers: [definition],
      cwdProvider: () => root,
      roots: () => [root],
    })
    const registry = manager.registry(base)

    expect(registry.definitions().map(({ name }) => name)).toEqual(['LSP'])
    expect(
      registry.schedulingPolicy?.(call('policy', 'hover', file)),
    ).toMatchObject({ concurrency: 'exclusive' })
    expect(registry.definitions()[0]?.inputSchema).toMatchObject({
      required: ['operation', 'filePath', 'line', 'character'],
      additionalProperties: false,
      properties: {
        operation: {
          enum: expect.arrayContaining([
            'goToDefinition',
            'workspaceSymbol',
            'incomingCalls',
          ]),
        },
      },
    })

    const hover = await registry.execute(call('1', 'hover', file), {
      cwd: root,
    })
    expect(hover.isError).toBe(false)
    expect(hover.content).toContain('Hover info at 2:3:')
    expect(hover.content).toContain('explicit=allowed')
    expect(hover.accessedPaths).toEqual([await realpath(file)])
    expect(await eventuallyReadJson(configResponseFile)).toEqual([null])

    const symbols = await registry.execute(
      call('2', 'workspaceSymbol', file, { query: 'main' }),
      { cwd: root },
    )
    expect(symbols.content).toBe(
      'Found 1 symbol in workspace:\n\n/fixture/main.fixture:\n  main (Function) - Line 1',
    )
    await manager.close()
  })

  it('opens and refreshes documents and resolves call hierarchy operations', async () => {
    const { root, file, definition } = await fixture()
    const manager = new ClaudeLspToolManager({
      servers: [definition],
      cwdProvider: () => root,
      roots: () => [root],
    })
    const registry = manager.registry(base)
    await registry.execute(call('1', 'documentSymbol', file), { cwd: root })
    await writeFile(file, 'changed\nsecond\n')
    const refreshed = await registry.execute(call('2', 'hover', file), {
      cwd: root,
    })
    expect(refreshed.content).toContain('initialized')
    expect(refreshed.content).toContain('textDocument/didOpen')
    expect(refreshed.content).toContain('textDocument/didChange')

    const incoming = await registry.execute(call('3', 'incomingCalls', file), {
      cwd: root,
    })
    expect(incoming.content).toBe(
      'Found 1 incoming call:\n\nmain.fixture:\n  main (Function) - Line 2 [calls at: 1:1]',
    )
    await manager.close()
  })

  it('uses only the first prepared call hierarchy item like Claude', async () => {
    const { root, file, definition } = await fixture()
    const manager = new ClaudeLspToolManager({
      servers: [
        {
          ...definition,
          env: { ...definition.env, LSP_MULTIPLE_CALL_ITEMS: '1' },
        },
      ],
      cwdProvider: () => root,
      roots: () => [root],
    })
    const result = await manager
      .registry(base)
      .execute(call('1', 'incomingCalls', file), { cwd: root })

    expect(result.content).toContain('Found 1 incoming call:')
    expect(result.content).not.toContain('second')
    await manager.close()
  })

  it('distinguishes a missing call hierarchy item from no calls', async () => {
    const { root, file, definition } = await fixture()
    const manager = new ClaudeLspToolManager({
      servers: [
        {
          ...definition,
          env: { ...definition.env, LSP_EMPTY_CALL_ITEMS: '1' },
        },
      ],
      cwdProvider: () => root,
      roots: () => [root],
    })
    const registry = manager.registry(base)

    for (const operation of ['incomingCalls', 'outgoingCalls']) {
      await expect(
        registry.execute(call(operation, operation, file), { cwd: root }),
      ).resolves.toMatchObject({
        isError: false,
        content: 'No call hierarchy item found at this position',
      })
    }
    await manager.close()
  })

  it('filters gitignored references before formatting the result', async () => {
    const { root, file, definition } = await fixture()
    await execFileAsync('git', ['init', '-q'], { cwd: root })
    await writeFile(join(root, '.gitignore'), 'ignored.fixture\n')
    const ignoredFile = join(root, 'ignored.fixture')
    await writeFile(ignoredFile, 'ignored\n')
    const manager = new ClaudeLspToolManager({
      servers: [
        {
          ...definition,
          env: {
            ...definition.env,
            LSP_IGNORED_URI: pathToFileURL(await realpath(ignoredFile)).href,
          },
        },
      ],
      cwdProvider: () => root,
      roots: () => [root],
    })
    const result = await manager
      .registry(base)
      .execute(call('1', 'findReferences', file), { cwd: root })

    expect(result).toMatchObject({
      isError: false,
      content: 'Found 1 reference:\n  main.fixture:2:3',
    })
    expect(result.content).not.toContain('ignored.fixture')
    await manager.close()
  })

  it("rejects files over Claude's 10MB LSP limit before spawning", async () => {
    const { root, file, pidFile, definition } = await fixture()
    await writeFile(file, Buffer.alloc(10_000_001))
    const manager = new ClaudeLspToolManager({
      servers: [definition],
      cwdProvider: () => root,
      roots: () => [root],
    })
    const result = await manager
      .registry(base)
      .execute(call('1', 'hover', file), { cwd: root })

    expect(result).toMatchObject({
      isError: false,
      content: 'File too large for LSP analysis (11MB exceeds 10MB limit)',
    })
    await expect(readFile(pidFile, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await manager.close()
  })

  it('rejects unsupported paths and file types before spawning a server', async () => {
    const { root, definition } = await fixture()
    const outside = await mkdtemp(join(tmpdir(), 'praxis-lsp-outside-'))
    roots.push(outside)
    const outsideFile = join(outside, 'outside.fixture')
    await writeFile(outsideFile, 'outside')
    const manager = new ClaudeLspToolManager({
      servers: [definition],
      cwdProvider: () => root,
      roots: () => [root],
    })
    const registry = manager.registry(base)

    await expect(
      registry.execute(call('1', 'hover', outsideFile), { cwd: root }),
    ).resolves.toMatchObject({
      isError: true,
      content: expect.stringContaining('outside allowed roots'),
    })
    const plain = join(root, 'plain.txt')
    await writeFile(plain, 'plain')
    await expect(
      registry.execute(call('2', 'hover', plain), { cwd: root }),
    ).resolves.toMatchObject({
      isError: false,
      content: 'No LSP server available for file type: .txt',
    })
    await manager.close()
  })

  it('matches configured file extensions case-insensitively', async () => {
    const { root, definition } = await fixture()
    const file = join(root, 'UPPER.FIXTURE')
    await writeFile(file, 'upper\n')
    const manager = new ClaudeLspToolManager({
      servers: [definition],
      cwdProvider: () => root,
      roots: () => [root],
    })

    await expect(
      manager.registry(base).execute(call('1', 'hover', file), { cwd: root }),
    ).resolves.toMatchObject({
      isError: false,
      content: expect.stringContaining('Hover info at 2:3'),
    })
    await manager.close()
  })

  it('propagates cancellation, isolates ambient credentials, and closes the server', async () => {
    const { root, file, pidFile, definition } = await fixture()
    const previous = process.env.PRAXIS_LSP_SECRET
    process.env.PRAXIS_LSP_SECRET = 'ambient-secret'
    try {
      const manager = new ClaudeLspToolManager({
        servers: [definition],
        cwdProvider: () => root,
        roots: () => [root],
      })
      const registry = manager.registry(base)
      const hover = await registry.execute(call('1', 'hover', file), {
        cwd: root,
      })
      expect(hover.content).toContain('explicit=allowed')
      expect(hover.content).toContain('token=[REDACTED]')
      expect(hover.content).not.toContain('explicit-secret')
      expect(hover.content).not.toContain('argument-only-secret')
      expect(hover.content).not.toContain('ambient-secret')

      const controller = new AbortController()
      const pending = registry.execute(
        call('2', 'workspaceSymbol', file, { query: 'hang' }),
        { cwd: root, signal: controller.signal },
      )
      controller.abort()
      await expect(pending).resolves.toMatchObject({
        isError: false,
        content: expect.stringContaining('cancelled'),
      })
      const pid = Number(await readFile(pidFile, 'utf8'))
      await manager.close()
      await expect(eventuallyStopped(pid)).resolves.toBe(true)
    } finally {
      if (previous === undefined) delete process.env.PRAXIS_LSP_SECRET
      else process.env.PRAXIS_LSP_SECRET = previous
    }
  })

  it('returns without hanging when the configured server command cannot spawn', async () => {
    const { root, file, definition } = await fixture()
    const manager = new ClaudeLspToolManager({
      servers: [
        {
          ...definition,
          command: join(root, 'missing-lsp-command'),
          args: [],
        },
      ],
      cwdProvider: () => root,
      roots: () => [root],
    })

    await expect(
      manager.registry(base).execute(call('1', 'hover', file), { cwd: root }),
    ).resolves.toMatchObject({
      isError: false,
      content: expect.stringContaining('ENOENT'),
    })
    await manager.close()
  })

  it('shares one pending initialization across concurrent LSP calls', async () => {
    const { root, file, definition } = await fixture()
    const manager = new ClaudeLspToolManager({
      servers: [
        {
          ...definition,
          env: { ...definition.env, LSP_INITIALIZE_DELAY: '50' },
        },
      ],
      cwdProvider: () => root,
      roots: () => [root],
    })
    const registry = manager.registry(base)

    const results = await Promise.all([
      registry.execute(call('1', 'hover', file), { cwd: root }),
      registry.execute(call('2', 'hover', file), { cwd: root }),
    ])
    expect(results).toEqual([
      expect.objectContaining({
        isError: false,
        content: expect.stringContaining('Hover info at 2:3'),
      }),
      expect.objectContaining({
        isError: false,
        content: expect.stringContaining('Hover info at 2:3'),
      }),
    ])
    await manager.close()
  })

  it('restarts a crashed server on the next request', async () => {
    const { root, file, definition } = await fixture()
    const crashFile = join(root, 'crashed')
    const manager = new ClaudeLspToolManager({
      servers: [
        {
          ...definition,
          env: { ...definition.env, LSP_CRASH_ONCE_FILE: crashFile },
        },
      ],
      cwdProvider: () => root,
      roots: () => [root],
    })
    const registry = manager.registry(base)

    await expect(
      registry.execute(call('1', 'hover', file), { cwd: root }),
    ).resolves.toMatchObject({
      isError: false,
      content: expect.stringContaining('exited with code 23'),
    })
    await expect(
      registry.execute(call('2', 'hover', file), { cwd: root }),
    ).resolves.toMatchObject({
      isError: false,
      content: expect.stringContaining('Hover info at 2:3'),
    })
    await manager.close()
  })

  it('retries transient content-modified responses', async () => {
    const { root, file, definition } = await fixture()
    const retryFile = join(root, 'retried')
    const manager = new ClaudeLspToolManager({
      servers: [
        {
          ...definition,
          env: {
            ...definition.env,
            LSP_CONTENT_MODIFIED_ONCE_FILE: retryFile,
          },
        },
      ],
      cwdProvider: () => root,
      roots: () => [root],
    })

    await expect(
      manager.registry(base).execute(call('1', 'hover', file), { cwd: root }),
    ).resolves.toMatchObject({
      isError: false,
      content: expect.stringContaining('Hover info at 2:3'),
    })
    expect(await readFile(retryFile, 'utf8')).toBe('retried')
    await manager.close()
  })

  it('enforces configured crash restart limits', async () => {
    const { root, file, definition } = await fixture()
    const crashFile = join(root, 'crashed')
    const manager = new ClaudeLspToolManager({
      servers: [
        {
          ...definition,
          maxRestarts: 0,
          env: { ...definition.env, LSP_CRASH_ONCE_FILE: crashFile },
        },
      ],
      cwdProvider: () => root,
      roots: () => [root],
    })
    const registry = manager.registry(base)

    await expect(
      registry.execute(call('1', 'hover', file), { cwd: root }),
    ).resolves.toMatchObject({ isError: false })
    await expect(
      registry.execute(call('2', 'hover', file), { cwd: root }),
    ).resolves.toMatchObject({
      isError: false,
      content: expect.stringContaining(
        'exceeded max crash recovery attempts (0)',
      ),
    })
    await manager.close()
  })

  it('closes stale connections when the worktree cwd changes', async () => {
    const first = await fixture()
    const second = await fixture()
    let cwd = first.root
    const manager = new ClaudeLspToolManager({
      servers: [first.definition],
      cwdProvider: () => cwd,
      roots: () => [first.root, second.root],
    })
    const registry = manager.registry(base)

    await registry.execute(call('1', 'hover', first.file), { cwd })
    const firstPid = Number(await readFile(first.pidFile, 'utf8'))
    cwd = second.root
    await registry.execute(call('2', 'hover', second.file), { cwd })
    const secondPid = Number(await readFile(first.pidFile, 'utf8'))

    expect(secondPid).not.toBe(firstPid)
    await expect(eventuallyStopped(firstPid)).resolves.toBe(true)
    await manager.close()
    await expect(eventuallyStopped(secondPid)).resolves.toBe(true)
  })
})
