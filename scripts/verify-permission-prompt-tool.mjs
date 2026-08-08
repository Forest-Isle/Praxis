import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { writeFixture } from './lib/claude-probe.mjs'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-permission-prompt-compat-'))
const mcpServer = join(root, 'permission-server.mjs')
const providerRequests = []
let failure

function events(blocks, stopReason) {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_permission_fixture',
        type: 'message',
        role: 'assistant',
        model: 'fixture-model',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    ...blocks.flatMap((block, index) => [
      { type: 'content_block_start', index, content_block: block.start },
      ...(block.delta
        ? [{ type: 'content_block_delta', index, delta: block.delta }]
        : []),
      { type: 'content_block_stop', index },
    ]),
    {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ]
}

function stream(response, blocks, stopReason) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    events(blocks, stopReason)
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(''),
  )
}

const provider = createServer(async (request, response) => {
  try {
    if (request.method === 'HEAD') {
      response.writeHead(200).end()
      return
    }
    let source = ''
    request.setEncoding('utf8')
    for await (const chunk of request) source += chunk
    const body = JSON.parse(source)
    providerRequests.push(body)
    const serialized = JSON.stringify(body.messages)
    if (
      serialized.includes('tool_result') ||
      serialized.includes('UPDATED_INPUT_EXECUTED') ||
      serialized.includes('DENIED_BY_MCP')
    ) {
      stream(
        response,
        [
          {
            start: { type: 'text', text: '' },
            delta: { type: 'text_delta', text: 'PERMISSION_COMPLETE' },
          },
        ],
        'end_turn',
      )
      return
    }
    if (serialized.includes('ALLOW_ORIGINAL')) {
      stream(
        response,
        [
          {
            start: {
              type: 'tool_use',
              id: 'toolu_permission_allow',
              name: 'Bash',
              input: {},
            },
            delta: {
              type: 'input_json_delta',
              partial_json: JSON.stringify({
                command: "printf 'ALLOW_ORIGINAL'",
                description: 'Permission allow fixture',
              }),
            },
          },
        ],
        'tool_use',
      )
      return
    }
    if (serialized.includes('DENY_ORIGINAL')) {
      stream(
        response,
        [
          {
            start: {
              type: 'tool_use',
              id: 'toolu_permission_deny',
              name: 'Bash',
              input: {},
            },
            delta: {
              type: 'input_json_delta',
              partial_json: JSON.stringify({
                command: "printf 'DENY_ORIGINAL'",
                description: 'Permission deny fixture',
              }),
            },
          },
        ],
        'tool_use',
      )
      return
    }
    stream(
      response,
      [
        {
          start: { type: 'text', text: '' },
          delta: { type: 'text_delta', text: 'PERMISSION_COMPLETE' },
        },
      ],
      'end_turn',
    )
  } catch (error) {
    failure ??= error
    response.writeHead(500).end()
  }
})

async function runProbe(label, command, commandArgs, env, prompt) {
  const requestStart = providerRequests.length
  const configRoot = join(root, `${label}-config`)
  const cwd = join(root, `${label}-work`)
  const callLog = join(root, `${label}-calls.jsonl`)
  await mkdir(cwd, { recursive: true })
  const mcpConfig = JSON.stringify({
    mcpServers: {
      permission: {
        command: process.execPath,
        args: [mcpServer, callLog],
      },
    },
  })
  let result
  try {
    result = await execFileAsync(
      command,
      [
        ...commandArgs,
        '-p',
        '--model',
        'fixture-model',
        '--output-format',
        'json',
        '--strict-mcp-config',
        '--mcp-config',
        mcpConfig,
        '--permission-prompt-tool',
        'mcp__permission__approve',
        '--settings',
        JSON.stringify({ permissions: { ask: ['Bash(*)'] } }),
        '--',
        prompt,
      ],
      {
        cwd,
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: configRoot,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          ...env,
        },
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    )
  } catch (error) {
    result = {
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      failed: true,
    }
  }
  return {
    output: JSON.parse(result.stdout.trim().split('\n').at(-1)),
    failed: result.failed === true,
    calls: (await readFile(callLog, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse),
    providerMessages: providerRequests
      .slice(requestStart)
      .map((request) => JSON.stringify(request.messages)),
  }
}

try {
  await writeFixture(
    mcpServer,
    `import { appendFile } from 'node:fs/promises'
const log = process.argv[2]
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', async chunk => {
  buffer += chunk
  while (buffer.includes('\\n')) {
    const newline = buffer.indexOf('\\n')
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (!line.trim()) continue
    const request = JSON.parse(line)
    if (request.id === undefined) continue
    let result
    if (request.method === 'initialize') {
      result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'permission-fixture', version: '1' } }
    } else if (request.method === 'tools/list') {
      result = { tools: [{ name: 'approve', description: 'Approve permission requests.', inputSchema: { type: 'object', additionalProperties: true } }] }
    } else {
      await appendFile(log, JSON.stringify(request.params) + '\\n')
      const command = request.params.arguments.input.command
      result = { content: [{ type: 'text', text: JSON.stringify(command.includes('DENY')
        ? { behavior: 'deny', message: 'DENIED_BY_MCP', interrupt: true }
        : { behavior: 'allow', updatedInput: { command: "printf 'UPDATED_INPUT_EXECUTED'", description: 'Updated by MCP' } }) }] }
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n')
  }
})
`,
  )
  await new Promise((resolve, reject) => {
    provider.once('error', reject)
    provider.listen(0, '127.0.0.1', resolve)
  })
  const address = provider.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const implementations = [
    {
      label: 'claude',
      command: 'claude',
      args: [],
      env: {
        ANTHROPIC_API_KEY: 'fixture-key',
        ANTHROPIC_BASE_URL: baseUrl,
      },
    },
    {
      label: 'praxis',
      command: process.execPath,
      args: [join(process.cwd(), 'dist/cli.js')],
      env: {
        PRAXIS_PROVIDER: 'anthropic',
        PRAXIS_API_KEY: 'fixture-key',
        PRAXIS_MODEL: 'fixture-model',
        PRAXIS_BASE_URL: `${baseUrl}/v1`,
      },
    },
  ]
  const observations = {}
  for (const implementation of implementations) {
    const allow = await runProbe(
      `${implementation.label}-allow`,
      implementation.command,
      implementation.args,
      implementation.env,
      'ALLOW_ORIGINAL',
    )
    const deny = await runProbe(
      `${implementation.label}-deny`,
      implementation.command,
      implementation.args,
      implementation.env,
      'DENY_ORIGINAL',
    )
    observations[implementation.label] = {
      allowCall: allow.calls[0]?.arguments,
      denyCall: deny.calls[0]?.arguments,
      allowUpdated: allow.providerMessages.some((messages) =>
        messages.includes('UPDATED_INPUT_EXECUTED'),
      ),
      denyInterrupted: deny.failed && deny.providerMessages.length === 1,
    }
  }
  if (failure) throw failure
  if (
    JSON.stringify(observations.claude) !== JSON.stringify(observations.praxis)
  ) {
    throw new Error(
      `Permission prompt observations differ: ${JSON.stringify(observations)}`,
    )
  }
  if (
    observations.praxis.allowCall?.tool_name !== 'Bash' ||
    observations.praxis.allowCall?.tool_use_id !== 'toolu_permission_allow' ||
    observations.praxis.allowUpdated !== true ||
    observations.praxis.denyInterrupted !== true
  ) {
    throw new Error(
      `Permission prompt contract mismatch: ${JSON.stringify(observations.praxis)}`,
    )
  }
  console.log(
    'Permission prompt tool compatibility passed: hidden MCP routing, updated input, denial, and Claude parity',
  )
} finally {
  await new Promise((resolve) => provider.close(resolve)).catch(() => undefined)
  await rm(root, { recursive: true, force: true })
}
