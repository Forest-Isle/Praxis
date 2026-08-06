import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-mcp-management-'))
const configRoot = join(root, 'config')
const cliPath = join(process.cwd(), 'dist', 'cli.js')
const env = { ...process.env, CLAUDE_CONFIG_DIR: configRoot }

async function run(...args) {
  return execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: root,
    env,
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
  const listed = JSON.parse((await run('mcp', '--json', 'list')).stdout)
  if (
    listed.type !== 'mcp-list' ||
    listed.servers.length !== 2 ||
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
  console.log('MCP management compatibility checks passed.')
} finally {
  await rm(root, { recursive: true, force: true })
}
