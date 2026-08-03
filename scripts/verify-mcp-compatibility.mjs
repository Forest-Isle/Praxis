import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import {
  assertContains,
  detectClaudeVersion,
  writeFixture,
} from './lib/claude-probe.mjs'

const execFileAsync = promisify(execFile)
const root = await realpath(await mkdtemp(join(tmpdir(), 'praxis-mcp-compat-')))
const configRoot = join(root, 'config')
const cwd = join(root, 'work')
const stdioServer = join(root, 'stdio-server.mjs')
const pidFile = join(root, 'stdio.pid')
const markers = {
  user: 'MCP_USER_SHADOWED_1042',
  local: 'MCP_LOCAL_ACTIVE_2053',
  http: 'MCP_HTTP_ACTIVE_3064',
  done: 'MCP_PRAXIS_DONE_4075',
}
let providerMessages = ''

const server = createServer(async (request, response) => {
  let body = ''
  request.setEncoding('utf8')
  for await (const chunk of request) body += chunk
  if (request.url === '/mcp') {
    if (!body) {
      response.writeHead(204).end()
      return
    }
    const message = JSON.parse(body)
    if (message.id === undefined) {
      response.writeHead(202).end()
      return
    }
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'praxis-http-fixture', version: '1' },
          }
        : message.method === 'tools/list'
          ? {
              tools: [
                {
                  name: 'marker',
                  description: 'Returns the HTTP MCP marker.',
                  inputSchema: { type: 'object' },
                },
              ],
            }
          : { content: [{ type: 'text', text: markers.http }] }
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    return
  }

  const providerRequest = JSON.parse(body)
  providerMessages = JSON.stringify(providerRequest.messages ?? [])
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  if (
    providerMessages.includes(markers.local) &&
    providerMessages.includes(markers.http)
  ) {
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: markers.done } }] })}\n\ndata: [DONE]\n\n`,
    )
    return
  }
  response.end(
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_stdio',
                type: 'function',
                function: { name: 'mcp__fixture__marker', arguments: '{}' },
              },
              {
                index: 1,
                id: 'call_http',
                type: 'function',
                function: {
                  name: 'mcp__http_fixture__marker',
                  arguments: '{}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    })}\n\ndata: [DONE]\n\n`,
  )
})

function listen() {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

function closeServer() {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

try {
  const version = await detectClaudeVersion('MCP compatibility probe')
  await mkdir(cwd, { recursive: true })
  await listen()
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no address')

  await Promise.all([
    writeFixture(
      stdioServer,
      `import { writeFile } from 'node:fs/promises'
await writeFile(process.argv[3], String(process.pid))
const marker = process.argv[2]
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  while (buffer.includes('\\n')) {
    const newline = buffer.indexOf('\\n')
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (!line.trim()) continue
    const request = JSON.parse(line)
    if (request.id === undefined) continue
    const result = request.method === 'initialize'
      ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'praxis-stdio-fixture', version: '1' } }
      : request.method === 'tools/list'
        ? { tools: [{ name: 'marker', description: 'Returns the stdio MCP marker.', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: marker }] }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n')
  }
})
`,
    ),
    writeFixture(
      join(configRoot, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          fixture: {
            command: process.execPath,
            args: [stdioServer, markers.user, pidFile],
          },
        },
        projects: {
          [cwd]: {
            mcpServers: {
              fixture: {
                command: process.execPath,
                args: [stdioServer, markers.local, pidFile],
              },
            },
          },
        },
      }),
    ),
    writeFixture(
      join(cwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          http_fixture: {
            type: 'http',
            url: `http://127.0.0.1:${address.port}/mcp`,
          },
        },
      }),
    ),
    writeFixture(
      join(configRoot, 'settings.json'),
      JSON.stringify({
        permissions: {
          allow: ['mcp__fixture__marker', 'mcp__http_fixture__marker'],
        },
      }),
    ),
  ])

  const claude = await execFileAsync('claude', ['mcp', 'get', 'fixture'], {
    cwd,
    env: { ...process.env, CLAUDE_CONFIG_DIR: configRoot },
  })
  assertContains(claude.stdout, 'Scope: Local config', 'Claude local MCP')

  const cli = join(process.cwd(), 'dist', 'cli.js')
  const { stdout } = await execFileAsync(
    process.execPath,
    [cli, 'run', '--json', 'Call both MCP marker tools.'],
    {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configRoot,
        PRAXIS_API_KEY: 'fixture-key',
        PRAXIS_MODEL: 'fixture-model',
        PRAXIS_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      },
      maxBuffer: 4 * 1024 * 1024,
    },
  )
  const result = stdout
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((record) => record.type === 'result')
  assertContains(String(result?.text), markers.done, 'Praxis MCP result')
  assertContains(providerMessages, markers.local, 'Praxis local MCP call')
  assertContains(providerMessages, markers.http, 'Praxis HTTP MCP call')
  if (providerMessages.includes(markers.user)) {
    throw new Error('Praxis did not apply local-over-user MCP precedence')
  }
  const pid = Number(await readFile(pidFile, 'utf8'))
  try {
    process.kill(pid, 0)
    throw new Error('Praxis left the MCP stdio server running')
  } catch (error) {
    if (
      (error instanceof Error && error.message.includes('left')) ||
      error.code !== 'ESRCH'
    )
      throw error
  }

  console.log(
    `Claude ${version} MCP compatibility passed: user/local precedence, stdio and HTTP discovery/call, and subprocess cleanup`,
  )
} finally {
  if (server.listening) await closeServer()
  await rm(root, { recursive: true })
}
