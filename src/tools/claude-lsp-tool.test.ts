import { execFile } from 'node:child_process'
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import type {
  ModelMessage,
  ModelToolCall,
  ToolExecutionContext,
  ToolRegistry,
} from '../core/runtime.js'
import type { ClaudePluginLspServer } from '../plugins/claude-plugin-runtime.js'
import { formatClaudeLspResult } from './claude-lsp-formatters.js'
import { ClaudeLspToolManager } from './claude-lsp-tool.js'
import { LocalToolRegistry } from './local-tools.js'

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
function frame(value) {
  const body = Buffer.from(JSON.stringify(value))
  return Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n'), body])
}
function send(value) {
  process.stdout.write(frame(value))
}
function sendCoalesced(values) {
  process.stdout.write(Buffer.concat(values.map(frame)))
}
function sendFragmented(value) {
  const framed = frame(value)
  process.stdout.write(framed.subarray(0, Math.max(1, Math.floor(framed.length / 2))))
  setImmediate(() => process.stdout.write(framed.subarray(Math.floor(framed.length / 2))))
}
function receive(message) {
  if (message.method === 'exit') process.exit(0)
  if ((message.method === 'textDocument/didOpen' || message.method === 'textDocument/didChange') && process.env.LSP_PUBLISH_DIAGNOSTICS) {
    const uri = message.params.textDocument.uri
    const mode = process.env.LSP_PUBLISH_DIAGNOSTICS
    if (mode === 'none') return
    if (process.env.LSP_DIAGNOSTIC_CRASH_ONCE_FILE && !fs.existsSync(process.env.LSP_DIAGNOSTIC_CRASH_ONCE_FILE)) {
      fs.writeFileSync(process.env.LSP_DIAGNOSTIC_CRASH_ONCE_FILE, 'crashed')
      process.exit(24)
    }
    const text = message.method === 'textDocument/didOpen'
      ? message.params.textDocument.text
      : message.params.contentChanges[0].text
    const fileCode = uri.includes('alpha.fixture')
      ? 'E-ALPHA'
      : uri.includes('beta.fixture')
        ? 'E-BETA'
        : text.includes('changed')
          ? 'E-NEW'
          : 'E-OLD'
    const diagnosticMessage = process.env.LSP_DIAGNOSTIC_SECRET
      ? 'fixture diagnostic ' + (process.env.LSP_API_TOKEN || '')
      : 'fixture diagnostic'
    const diagnostics = text.includes('clean')
      ? []
      : [{range:{start:{line:0,character:0},end:{line:0,character:1}},severity:1,code:fileCode,message:diagnosticMessage}]
    const version = mode === 'wrong-version' ? message.params.textDocument.version + 100 : message.params.textDocument.version
    const publication = {jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params:{uri,version,diagnostics}}
    const invalid = {jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params:{uri,diagnostics:[{message:1}]}}
    const unrelated = process.env.LSP_UNRELATED_URI
      ? {jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params:{uri:process.env.LSP_UNRELATED_URI,version,diagnostics:[{range:{start:{line:0,character:0},end:{line:0,character:1}},severity:1,code:'E-UNRELATED',message:'unrelated diagnostic'}]}}
      : null
    const publish = () => {
      if (mode === 'fragmented') sendFragmented(publication)
      else if (mode === 'invalid-then-valid') sendCoalesced([invalid, publication])
      else {
        if (unrelated) send(unrelated)
        send(publication)
      }
    }
    if (mode === 'wait-release') {
      const timer = setInterval(() => {
        if (!process.env.LSP_RELEASE_FILE || !fs.existsSync(process.env.LSP_RELEASE_FILE)) return
        clearInterval(timer)
        publish()
      }, 5)
    } else publish()
    return
  }
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

const mutationBase: ToolRegistry = {
  definitions: () => [],
  schedulingPolicy: () => ({ concurrency: 'exclusive' }),
  prepare: async (call) => call,
  execute: async () => ({ content: 'mutation succeeded', isError: false }),
}

const errorMutationBase: ToolRegistry = {
  definitions: () => [],
  schedulingPolicy: () => ({ concurrency: 'exclusive' }),
  prepare: async (call) => call,
  execute: async () => ({ content: 'mutation failed exactly', isError: true }),
}

const throwingMutationBase: ToolRegistry = {
  definitions: () => [],
  schedulingPolicy: () => ({ concurrency: 'exclusive' }),
  prepare: async (call) => call,
  execute: async () => {
    throw new Error('mutation threw exactly')
  },
}

async function contextAfterReads(
  registry: LocalToolRegistry,
  context: ToolExecutionContext,
  filePaths: readonly string[],
): Promise<ToolExecutionContext> {
  const messages: ModelMessage[] = [...(context.messages ?? [])]
  for (const [index, filePath] of filePaths.entries()) {
    const read = await registry.prepare(
      {
        id: `read-${index}-${filePath}`,
        name: 'Read',
        input: { file_path: filePath },
      },
      context,
    )
    const result = await registry.execute(read, context)
    messages.push(
      { role: 'assistant', content: '', toolCalls: [read] },
      {
        role: 'tool',
        toolCallId: read.id,
        content: result.content,
        isError: false,
      },
    )
  }
  return { ...context, messages }
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

  it('enriches a real Edit after didChange, redacts secrets, and clears stale diagnostics', async () => {
    const { root, file, definition } = await fixture()
    const local = new LocalToolRegistry({ cwd: root })
    const manager = new ClaudeLspToolManager({
      servers: [
        {
          ...definition,
          env: {
            ...definition.env,
            LSP_PUBLISH_DIAGNOSTICS: 'dynamic',
            LSP_DIAGNOSTIC_SECRET: '1',
          },
        },
      ],
      cwdProvider: () => root,
      roots: () => [root],
    })
    const registry = manager.registry(local)
    await registry.execute(call('open', 'hover', file), { cwd: root })

    let context = await contextAfterReads(local, { cwd: root }, [file])
    const edit = await registry.prepare(
      {
        id: 'edit',
        name: 'Edit',
        input: {
          file_path: file,
          old_string: 'first',
          new_string: 'changed',
        },
      },
      context,
    )
    const result = await registry.execute(edit, context)
    expect(await readFile(file, 'utf8')).toBe('changed\nsecond\n')
    expect(result.content).toContain(
      'main.fixture:1:1 error E-NEW fixture diagnostic [REDACTED]',
    )
    expect(result.content).not.toContain('E-OLD')
    expect(result.content).not.toContain('explicit-secret')

    context = await contextAfterReads(local, context, [file])
    const clear = await registry.prepare(
      {
        id: 'clear',
        name: 'Edit',
        input: {
          file_path: file,
          old_string: 'changed',
          new_string: 'clean',
        },
      },
      context,
    )
    const cleared = await registry.execute(clear, context)
    expect(await readFile(file, 'utf8')).toBe('clean\nsecond\n')
    expect(cleared.content).not.toContain('<diagnostics>')
    expect(cleared.content).not.toContain('E-NEW')
    await manager.close()
  })

  it('handles fragmented diagnostics without disturbing later request responses', async () => {
    const { root, file, definition } = await fixture()
    const manager = new ClaudeLspToolManager({
      servers: [
        {
          ...definition,
          env: { ...definition.env, LSP_PUBLISH_DIAGNOSTICS: 'fragmented' },
        },
      ],
      cwdProvider: () => root,
      roots: () => [root],
    })
    const registry = manager.registry(mutationBase)
    await expect(
      registry.execute(
        { id: 'edit', name: 'Edit', input: { file_path: file } },
        { cwd: root },
      ),
    ).resolves.toMatchObject({
      content: expect.stringContaining('fixture diagnostic'),
    })
    await expect(
      registry.execute(call('hover', 'hover', file), { cwd: root }),
    ).resolves.toMatchObject({
      content: expect.stringContaining('Hover info at 2:3'),
    })
    await manager.close()
  })

  it('ignores an invalid coalesced publication before accepting the valid one', async () => {
    const { root, file, definition } = await fixture()
    const manager = new ClaudeLspToolManager({
      servers: [
        {
          ...definition,
          env: {
            ...definition.env,
            LSP_PUBLISH_DIAGNOSTICS: 'invalid-then-valid',
          },
        },
      ],
      cwdProvider: () => root,
      roots: () => [root],
    })
    const result = await manager
      .registry(mutationBase)
      .execute(
        { id: 'edit', name: 'Edit', input: { file_path: file } },
        { cwd: root },
      )
    expect(result.content).toContain('fixture diagnostic')
    await manager.close()
  })

  it('ignores a diagnostic publication carrying the wrong document version', async () => {
    const { root, file, definition } = await fixture()
    const manager = new ClaudeLspToolManager({
      servers: [
        {
          ...definition,
          env: { ...definition.env, LSP_PUBLISH_DIAGNOSTICS: 'wrong-version' },
        },
      ],
      cwdProvider: () => root,
      roots: () => [root],
    })
    const result = await manager
      .registry(mutationBase)
      .execute(
        { id: 'edit', name: 'Edit', input: { file_path: file } },
        { cwd: root },
      )
    expect(result).toEqual({ content: 'mutation succeeded', isError: false })
    await manager.close()
  })

  it('enriches ApplyPatch for only its exact canonical targets in stable order', async () => {
    const { root, definition } = await fixture()
    const alpha = join(root, 'alpha.fixture')
    const beta = join(root, 'beta.fixture')
    const unrelated = join(root, 'unrelated.fixture')
    await writeFile(alpha, 'alpha\n')
    await writeFile(beta, 'beta\n')
    await writeFile(unrelated, 'unrelated\n')
    const local = new LocalToolRegistry({ cwd: root })
    const context = await contextAfterReads(local, { cwd: root }, [alpha, beta])
    const manager = new ClaudeLspToolManager({
      servers: [
        {
          ...definition,
          env: {
            ...definition.env,
            LSP_PUBLISH_DIAGNOSTICS: 'dynamic',
            LSP_UNRELATED_URI: pathToFileURL(unrelated).href,
          },
        },
      ],
      cwdProvider: () => root,
      roots: () => [root],
    })
    const registry = manager.registry(local)
    const patch = await registry.prepare(
      {
        id: 'patch',
        name: 'ApplyPatch',
        input: {
          edits: [
            {
              file_path: beta,
              old_string: 'beta',
              new_string: 'changed beta',
            },
            {
              file_path: alpha,
              old_string: 'alpha',
              new_string: 'changed alpha',
            },
          ],
        },
      },
      context,
    )
    const result = await registry.execute(patch, context)
    expect(result.accessedPaths).toEqual([beta, alpha])
    expect(result.content).toContain('alpha.fixture:1:1 error E-ALPHA')
    expect(result.content).toContain('beta.fixture:1:1 error E-BETA')
    expect(result.content).not.toContain('E-UNRELATED')
    expect(result.content.indexOf('alpha.fixture')).toBeLessThan(
      result.content.indexOf('beta.fixture'),
    )
    await manager.close()
  })

  it('excludes additional-root and symlink-escape mutation targets before startup', async () => {
    const { root, pidFile, definition } = await fixture()
    const outsideRoot = await realpath(
      await mkdtemp(join(tmpdir(), 'praxis-lsp-diagnostics-outside-')),
    )
    roots.push(outsideRoot)
    const outside = join(outsideRoot, 'outside.fixture')
    const link = join(root, 'link.fixture')
    await writeFile(outside, 'outside\n')
    await symlink(outside, link)
    const manager = new ClaudeLspToolManager({
      servers: [
        {
          ...definition,
          env: { ...definition.env, LSP_PUBLISH_DIAGNOSTICS: 'dynamic' },
        },
      ],
      cwdProvider: () => root,
      roots: () => [root, outsideRoot],
    })
    const registry = manager.registry(mutationBase)
    for (const filePath of [outside, link]) {
      await expect(
        registry.execute(
          { id: filePath, name: 'Edit', input: { file_path: filePath } },
          { cwd: root },
        ),
      ).resolves.toEqual({ content: 'mutation succeeded', isError: false })
    }
    await expect(readFile(pidFile, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await manager.close()
  })

  it('preserves failed, thrown, and pre-aborted mutation semantics without startup', async () => {
    const { root, file, pidFile, definition } = await fixture()
    const manager = new ClaudeLspToolManager({
      servers: [
        {
          ...definition,
          env: { ...definition.env, LSP_PUBLISH_DIAGNOSTICS: 'dynamic' },
        },
      ],
      cwdProvider: () => root,
      roots: () => [root],
    })
    await expect(
      manager
        .registry(errorMutationBase)
        .execute(
          { id: 'failed', name: 'Edit', input: { file_path: file } },
          { cwd: root },
        ),
    ).resolves.toEqual({
      content: 'mutation failed exactly',
      isError: true,
    })
    await expect(
      manager
        .registry(throwingMutationBase)
        .execute(
          { id: 'thrown', name: 'Edit', input: { file_path: file } },
          { cwd: root },
        ),
    ).rejects.toThrow('mutation threw exactly')
    const controller = new AbortController()
    controller.abort()
    await expect(
      manager
        .registry(mutationBase)
        .execute(
          { id: 'aborted', name: 'Edit', input: { file_path: file } },
          { cwd: root, signal: controller.signal },
        ),
    ).resolves.toEqual({ content: 'mutation succeeded', isError: false })
    await expect(readFile(pidFile, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await manager.close()
  })

  it('bounds startup and preserves success when interrupted after LSP starts', async () => {
    const timed = await fixture()
    const timeoutManager = new ClaudeLspToolManager({
      servers: [
        {
          ...timed.definition,
          env: {
            ...timed.definition.env,
            LSP_PUBLISH_DIAGNOSTICS: 'dynamic',
            LSP_INITIALIZE_DELAY: '2000',
          },
        },
      ],
      cwdProvider: () => timed.root,
      roots: () => [timed.root],
    })
    const startedAt = Date.now()
    await expect(
      timeoutManager
        .registry(mutationBase)
        .execute(
          { id: 'timeout', name: 'Edit', input: { file_path: timed.file } },
          { cwd: timed.root },
        ),
    ).resolves.toEqual({ content: 'mutation succeeded', isError: false })
    expect(Date.now() - startedAt).toBeLessThan(1_900)
    await timeoutManager.close()

    const interrupted = await fixture()
    const interruptManager = new ClaudeLspToolManager({
      servers: [
        {
          ...interrupted.definition,
          env: {
            ...interrupted.definition.env,
            LSP_PUBLISH_DIAGNOSTICS: 'none',
          },
        },
      ],
      cwdProvider: () => interrupted.root,
      roots: () => [interrupted.root],
    })
    const controller = new AbortController()
    const pending = interruptManager.registry(mutationBase).execute(
      {
        id: 'interrupted',
        name: 'Edit',
        input: { file_path: interrupted.file },
      },
      { cwd: interrupted.root, signal: controller.signal },
    )
    await eventuallyReadJson(interrupted.pidFile)
    controller.abort()
    await expect(pending).resolves.toEqual({
      content: 'mutation succeeded',
      isError: false,
    })
    await interruptManager.close()
  })

  it('drops crashed-connection state and does not surface diagnostics after cwd replacement', async () => {
    const crashed = await fixture()
    const crashFile = join(crashed.root, 'diagnostics-crashed')
    const crashManager = new ClaudeLspToolManager({
      servers: [
        {
          ...crashed.definition,
          env: {
            ...crashed.definition.env,
            LSP_PUBLISH_DIAGNOSTICS: 'dynamic',
            LSP_DIAGNOSTIC_CRASH_ONCE_FILE: crashFile,
          },
        },
      ],
      cwdProvider: () => crashed.root,
      roots: () => [crashed.root],
    })
    const crashRegistry = crashManager.registry(mutationBase)
    await expect(
      crashRegistry.execute(
        { id: 'crash', name: 'Edit', input: { file_path: crashed.file } },
        { cwd: crashed.root },
      ),
    ).resolves.toEqual({ content: 'mutation succeeded', isError: false })
    await expect(
      crashRegistry.execute(
        { id: 'restart', name: 'Edit', input: { file_path: crashed.file } },
        { cwd: crashed.root },
      ),
    ).resolves.toMatchObject({
      content: expect.stringContaining('fixture diagnostic'),
    })
    await crashManager.close()

    const first = await fixture()
    const second = await fixture()
    const releaseFile = join(first.root, 'release-diagnostics')
    let cwd = first.root
    const cwdManager = new ClaudeLspToolManager({
      servers: [
        {
          ...first.definition,
          env: {
            ...first.definition.env,
            LSP_PUBLISH_DIAGNOSTICS: 'wait-release',
            LSP_RELEASE_FILE: releaseFile,
          },
        },
      ],
      cwdProvider: () => cwd,
      roots: () => [first.root, second.root],
    })
    const pending = cwdManager
      .registry(mutationBase)
      .execute(
        { id: 'cwd', name: 'Edit', input: { file_path: first.file } },
        { cwd: first.root },
      )
    const firstPid = Number(await eventuallyReadJson(first.pidFile))
    cwd = second.root
    await writeFile(releaseFile, 'release')
    await expect(pending).resolves.toEqual({
      content: 'mutation succeeded',
      isError: false,
    })
    await expect(eventuallyStopped(firstPid)).resolves.toBe(true)
    await cwdManager.close()
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
    await expect(
      registry.execute(
        {
          id: 'missing-mutation',
          name: 'Edit',
          input: { file_path: join(second.root, 'missing.fixture') },
        },
        { cwd },
      ),
    ).resolves.toEqual({ content: 'base', isError: false })
    await expect(eventuallyStopped(firstPid)).resolves.toBe(true)
    await registry.execute(call('2', 'hover', second.file), { cwd })
    const secondPid = Number(await readFile(first.pidFile, 'utf8'))

    expect(secondPid).not.toBe(firstPid)
    await manager.close()
    await expect(eventuallyStopped(secondPid)).resolves.toBe(true)
  })
})
