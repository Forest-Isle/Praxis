import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { sanitizeClaudeProjectPath } from '../dist/compatibility/claude/paths.js'
import { parseClaudeVersionOutput } from '../dist/compatibility/claude/schema.js'
import { loadClaudeSharedResources } from '../dist/compatibility/claude/shared-resources.js'

const execFileAsync = promisify(execFile)
const markers = {
  global: 'SHARED_GLOBAL_1041',
  project: 'SHARED_PROJECT_2052',
  memory: 'SHARED_MEMORY_3063',
  memoryDetail: 'SHARED_MEMORY_DETAIL_3174',
  skill: 'SHARED_SKILL_4074',
  hook: 'SHARED_HOOK_5085',
  mcp: 'SHARED_MCP_6096',
  command: 'SHARED_COMMAND_7107',
  agent: 'SHARED_AGENT_8218',
  settings: 'SHARED_SETTINGS_9329',
}

async function write(path, content) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

function assertContains(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    throw new Error(`${label} did not expose marker ${needle}`)
  }
}

const probeRoot = await mkdtemp(join(tmpdir(), 'praxis-claude-shared-'))

try {
  const { stdout: versionOutput } = await execFileAsync('claude', ['--version'])
  const version = parseClaudeVersionOutput(versionOutput)
  if (version !== '2.1.208') {
    throw new Error(`Shared-resource probe does not support Claude ${version}`)
  }

  const configRoot = join(probeRoot, 'config')
  const repository = join(probeRoot, 'work')
  const workDirectory = join(repository, 'packages', 'fixture')
  await mkdir(workDirectory, { recursive: true })
  await execFileAsync('git', ['init', '-q', repository])
  const cwd = await realpath(workDirectory)
  const projectMemoryDirectory = join(
    configRoot,
    'projects',
    sanitizeClaudeProjectPath(await realpath(repository)),
    'memory',
  )
  const mcpServer = join(probeRoot, 'fixture-mcp.mjs')

  await Promise.all([
    write(
      join(configRoot, 'CLAUDE.md'),
      `Global compatibility marker: ${markers.global}\n`,
    ),
    write(
      join(repository, 'CLAUDE.md'),
      `Project compatibility marker: ${markers.project}\n`,
    ),
    write(
      join(projectMemoryDirectory, 'MEMORY.md'),
      `Auto-memory marker: ${markers.memory}\n\n- [Details](details.md)\n`,
    ),
    write(
      join(projectMemoryDirectory, 'details.md'),
      `Detailed memory marker: ${markers.memoryDetail}\n`,
    ),
    write(
      join(repository, '.claude', 'skills', 'fixture-matrix', 'SKILL.md'),
      `---\nname: fixture-matrix\ndescription: Verify the shared compatibility matrix.\n---\n\nSkill marker: ${markers.skill}. Call mcp__fixture__marker once, then reply with one JSON object containing exact global, project, memory, skill, hook, mcp, and agent marker strings visible in context.\n`,
    ),
    write(
      join(configRoot, 'commands', 'fixture-command.md'),
      `Reply with exactly ${markers.command}.\n`,
    ),
    write(
      join(configRoot, 'agents', 'fixture-agent.md'),
      `---\nname: fixture-agent\ndescription: Shared agent fixture.\n---\nAgent compatibility marker: ${markers.agent}. Always include it in your response.\n`,
    ),
    write(
      join(cwd, '.claude', 'settings.local.json'),
      JSON.stringify({
        enableAllProjectMcpServers: true,
        env: { PRAXIS_SETTINGS_MARKER: markers.settings },
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: 'command',
                  command: `printf "$PRAXIS_SETTINGS_MARKER:${markers.hook}"`,
                },
              ],
            },
          ],
        },
      }),
    ),
    write(
      join(cwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          fixture: { command: process.execPath, args: [mcpServer] },
        },
      }),
    ),
    write(
      mcpServer,
      `let buffer = ''
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
    let result
    if (request.method === 'initialize') {
      result = {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'praxis-fixture', version: '1.0.0' },
      }
    } else if (request.method === 'tools/list') {
      result = {
        tools: [{
          name: 'marker',
          description: 'Returns the shared MCP compatibility marker.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        }],
      }
    } else if (request.method === 'tools/call') {
      result = { content: [{ type: 'text', text: '${markers.mcp}' }] }
    } else {
      result = {}
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n')
  }
})
`,
    ),
  ])

  const resources = await loadClaudeSharedResources({ configRoot, cwd })
  assertContains(
    resources.instructions.map((item) => item.content).join('\n'),
    markers.global,
    'Praxis global instructions',
  )
  assertContains(
    resources.instructions.map((item) => item.content).join('\n'),
    markers.project,
    'Praxis project instructions',
  )
  assertContains(
    resources.memory.map((item) => item.content).join('\n'),
    markers.memory,
    'Praxis memory',
  )
  assertContains(
    resources.memory.map((item) => item.content).join('\n'),
    markers.memoryDetail,
    'Praxis linked memory',
  )
  assertContains(
    resources.skills.map((item) => item.content).join('\n'),
    markers.skill,
    'Praxis skills',
  )
  if (resources.commands.length !== 1 || resources.agents.length !== 1) {
    throw new Error('Praxis did not discover shared commands and agents')
  }
  assertContains(
    resources.commands[0]?.content ?? '',
    markers.command,
    'Praxis commands',
  )
  assertContains(
    resources.agents[0]?.content ?? '',
    markers.agent,
    'Praxis agents',
  )
  if (resources.settings.length !== 1 || !resources.mcp) {
    throw new Error('Praxis did not discover shared settings/hooks and MCP')
  }

  const { stdout } = await execFileAsync(
    'claude',
    [
      '-p',
      '--model',
      'haiku',
      '--max-turns',
      '3',
      '--output-format',
      'json',
      '--allowedTools',
      'Skill,mcp__fixture__marker',
      '--agent',
      'fixture-agent',
      '--dangerously-skip-permissions',
      '/fixture-matrix',
    ],
    {
      cwd,
      env: { ...process.env, CLAUDE_CONFIG_DIR: configRoot },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
    },
  )
  const response = JSON.parse(stdout)
  const result = String(response.result)
  for (const label of [
    'global',
    'project',
    'memory',
    'skill',
    'hook',
    'mcp',
    'agent',
    'settings',
  ]) {
    const marker = markers[label]
    assertContains(result, marker, `Claude ${label}`)
  }

  const { stdout: commandStdout } = await execFileAsync(
    'claude',
    [
      '-p',
      '--model',
      'haiku',
      '--max-turns',
      '1',
      '--output-format',
      'json',
      '/fixture-command',
    ],
    {
      cwd,
      env: { ...process.env, CLAUDE_CONFIG_DIR: configRoot },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
    },
  )
  const commandResponse = JSON.parse(commandStdout)
  assertContains(
    String(commandResponse.result),
    markers.command,
    'Claude command',
  )

  console.log(
    `Claude ${version} shared-resource compatibility passed: instructions, memory, skill, hook, MCP, commands, agents, and settings`,
  )
} finally {
  await rm(probeRoot, { recursive: true })
}
