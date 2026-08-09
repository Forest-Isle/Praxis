import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-mcp-management-'))
const configRoot = join(root, 'config')
const cliPath = join(process.cwd(), 'dist', 'cli.js')
const env = {
  ...process.env,
  CLAUDE_CONFIG_DIR: configRoot,
  PRAXIS_MCP_OAUTH_STORE: 'file',
}

async function run(...args) {
  return execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: root,
    env,
    timeout: 30_000,
  })
}

async function runWithEnv(extra, ...args) {
  return execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: root,
    env: { ...env, ...extra },
    timeout: 30_000,
  })
}

try {
  await run(
    'mcp',
    'add-json',
    'fixture',
    '{"type":"stdio","command":"node","args":["server.mjs"]}',
  )
  await run(
    'mcp',
    '--scope',
    'project',
    'add-json',
    'project-server',
    '{"type":"http","url":"https://example.com/mcp"}',
  )
  await runWithEnv(
    { MCP_CLIENT_SECRET: 'fixture-json-client-secret' },
    'mcp',
    'add-json',
    '--scope',
    'user',
    '--client-secret',
    'json-secret-server',
    '{"type":"http","url":"https://example.test/json-mcp","oauth":{"clientId":"fixture-json-client"}}',
  )
  const listed = JSON.parse((await run('mcp', '--json', 'list')).stdout)
  if (
    listed.type !== 'mcp-list' ||
    listed.servers.length !== 3 ||
    listed.servers.some((server) => !server.config)
  ) {
    throw new Error(`Unexpected MCP list: ${JSON.stringify(listed)}`)
  }
  const fetched = JSON.parse(
    (await run('mcp', '--json', 'get', 'fixture')).stdout,
  )
  if (fetched.server?.scope !== 'local') {
    throw new Error(`Unexpected MCP get: ${JSON.stringify(fetched)}`)
  }
  await run('mcp', '--scope', 'local', 'remove', 'fixture')
  const state = JSON.parse(
    await readFile(join(configRoot, '.claude.json'), 'utf8'),
  )
  const identity = Object.keys(state.projects)[0]
  if (state.projects[identity].mcpServers.fixture !== undefined) {
    throw new Error('Local MCP server was not removed')
  }
  await run('mcp', 'reset-project-choices')

  const stdio = await run(
    'mcp',
    'add',
    'stdio-fixture',
    '-e',
    'ONE=1',
    '-e',
    'TWO=two',
    '--',
    'node',
    'server.mjs',
    '--flag',
  )
  if (!stdio.stdout.includes('Added stdio MCP server stdio-fixture')) {
    throw new Error(`Unexpected stdio add output: ${stdio.stdout}`)
  }
  const http = await runWithEnv(
    { MCP_CLIENT_SECRET: 'fixture-client-secret' },
    'mcp',
    'add',
    '-s',
    'user',
    '-t',
    'streamable-http',
    'http-fixture',
    'https://example.test/mcp',
    '-H',
    'Authorization: Bearer fixture-header',
    '-H',
    'X-Test: yes',
    '--callback-port',
    '4321',
    '--client-id',
    'fixture-client',
    '--client-secret',
  )
  if (
    !http.stdout.includes('Added HTTP MCP server http-fixture') ||
    !http.stdout.includes('"Authorization": "[REDACTED]"')
  ) {
    throw new Error(`Unexpected HTTP add output: ${http.stdout}`)
  }
  await run(
    'mcp',
    'add',
    '-s',
    'project',
    '-t',
    'sse',
    'sse-fixture',
    'https://example.test/sse',
  )
  const addState = JSON.parse(
    await readFile(join(configRoot, '.claude.json'), 'utf8'),
  )
  const localProject = addState.projects[identity]
  if (
    JSON.stringify(localProject.mcpServers['stdio-fixture']) !==
    JSON.stringify({
      type: 'stdio',
      command: 'node',
      args: ['server.mjs', '--flag'],
      env: { ONE: '1', TWO: 'two' },
    })
  ) {
    throw new Error('Stdio MCP add config did not preserve env and arguments')
  }
  if (
    JSON.stringify(addState.mcpServers['http-fixture']) !==
    JSON.stringify({
      type: 'http',
      url: 'https://example.test/mcp',
      headers: {
        Authorization: 'Bearer fixture-header',
        'X-Test': 'yes',
      },
      oauth: { clientId: 'fixture-client', callbackPort: 4321 },
    })
  ) {
    throw new Error('HTTP MCP add config did not preserve headers and OAuth')
  }
  const projectMcp = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8'))
  if (
    JSON.stringify(projectMcp.mcpServers['sse-fixture']) !==
    JSON.stringify({ type: 'sse', url: 'https://example.test/sse' })
  ) {
    throw new Error('SSE MCP add config did not use project scope')
  }
  const credentials = await readFile(
    join(configRoot, '.credentials.json'),
    'utf8',
  )
  if (
    !credentials.includes('fixture-client-secret') ||
    !credentials.includes('fixture-json-client-secret') ||
    JSON.stringify(addState).includes('fixture-client-secret') ||
    JSON.stringify(addState).includes('fixture-json-client-secret')
  ) {
    throw new Error('MCP client secret was not isolated from config JSON')
  }
  const help = await run('mcp', 'add', '--help')
  if (!help.stdout.includes('--callback-port <port>')) {
    throw new Error(`MCP add help omitted OAuth controls: ${help.stdout}`)
  }
  const addJsonHelp = await run('mcp', 'add-json', '--help')
  if (!addJsonHelp.stdout.includes('--client-secret')) {
    throw new Error(
      `MCP add-json help omitted client-secret: ${addJsonHelp.stdout}`,
    )
  }
  console.log('MCP management compatibility checks passed.')
} finally {
  await rm(root, { recursive: true, force: true })
}
