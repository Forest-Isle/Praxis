import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { sanitizeClaudeProjectPath } from '../dist/compatibility/claude/paths.js'
import { parseClaudeVersionOutput } from '../dist/compatibility/claude/schema.js'
import { loadClaudeSharedResources } from '../dist/compatibility/claude/shared-resources.js'

const execFileAsync = promisify(execFile)
const markers = {
  global: 'SHARED_GLOBAL_1041',
  project: 'SHARED_PROJECT_2052',
  projectPackage: 'SHARED_PROJECT_PACKAGE_2163',
  projectCwd: 'SHARED_PROJECT_CWD_2274',
  nonGit: 'SHARED_NON_GIT_2385',
  memory: 'SHARED_MEMORY_3063',
  memoryDetail: 'SHARED_MEMORY_DETAIL_3174',
  skill: 'SHARED_SKILL_4074',
  hook: 'SHARED_HOOK_5085',
  mcp: 'SHARED_MCP_6096',
  mcpCwd: 'SHARED_MCP_CWD_6207',
  command: 'SHARED_COMMAND_7107',
  projectCommand: 'SHARED_PROJECT_COMMAND_7218',
  agent: 'SHARED_AGENT_8218',
  projectAgent: 'SHARED_PROJECT_AGENT_8329',
  settings: 'SHARED_SETTINGS_9329',
  rootSettings: 'SHARED_ROOT_SETTINGS_9430',
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

function assertNotContains(haystack, needle, label) {
  if (haystack.includes(needle)) {
    throw new Error(`${label} unexpectedly exposed marker ${needle}`)
  }
}

const probeRoot = await mkdtemp(join(tmpdir(), 'praxis-claude-shared-'))
let nonGitRoot

try {
  const { stdout: versionOutput } = await execFileAsync('claude', ['--version'])
  const version = parseClaudeVersionOutput(versionOutput)
  if (version !== '2.1.208') {
    throw new Error(`Shared-resource probe does not support Claude ${version}`)
  }

  const configRoot = join(probeRoot, 'config')
  const mainRepository = join(probeRoot, 'main')
  const repository = join(probeRoot, 'worktree')
  await mkdir(mainRepository, { recursive: true })
  await execFileAsync('git', ['init', '-q', mainRepository])
  await write(join(mainRepository, '.gitkeep'), '')
  await execFileAsync('git', ['add', '.gitkeep'], { cwd: mainRepository })
  await execFileAsync(
    'git',
    [
      '-c',
      'user.name=Praxis Fixture',
      '-c',
      'user.email=praxis-fixture@example.invalid',
      'commit',
      '-q',
      '-m',
      'fixture',
    ],
    { cwd: mainRepository },
  )
  await execFileAsync(
    'git',
    ['worktree', 'add', '-q', '-b', 'fixture-worktree', repository],
    { cwd: mainRepository },
  )
  const packageDirectory = join(repository, 'packages')
  const workDirectory = join(packageDirectory, 'fixture')
  await mkdir(workDirectory, { recursive: true })
  const cwd = await realpath(workDirectory)
  const projectMemoryDirectory = join(
    configRoot,
    'projects',
    sanitizeClaudeProjectPath(await realpath(mainRepository)),
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
      join(packageDirectory, 'CLAUDE.md'),
      `Package compatibility marker: ${markers.projectPackage}\n`,
    ),
    write(
      join(cwd, 'CLAUDE.md'),
      `Cwd compatibility marker: ${markers.projectCwd}\n`,
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
      `---\nname: fixture-matrix\ndescription: Verify the shared compatibility matrix.\n---\n\nSkill marker: ${markers.skill}. Read ${join(projectMemoryDirectory, 'details.md')}, call mcp__fixture_root__marker and mcp__fixture_cwd__marker once each, then reply with one JSON object containing every exact marker visible from global/root/package/cwd instructions, memory index/detail, skill, hooks/settings, both MCP tools, and active agent.\n`,
    ),
    write(
      join(configRoot, 'commands', 'fixture-command.md'),
      `Reply with exactly ${markers.command}.\n`,
    ),
    write(
      join(packageDirectory, '.claude', 'commands', 'fixture-project.md'),
      `Reply with exactly ${markers.projectCommand}.\n`,
    ),
    write(
      join(configRoot, 'agents', 'fixture-agent.md'),
      `---\nname: fixture-agent\ndescription: Shared agent fixture.\n---\nAgent compatibility marker: ${markers.agent}. Always include it in your response.\n`,
    ),
    write(
      join(cwd, '.claude', 'agents', 'fixture-project-agent.md'),
      `---\nname: fixture-project-agent\ndescription: Project agent fixture.\n---\nProject agent compatibility marker: ${markers.projectAgent}. Always include it in your response.\n`,
    ),
    write(
      join(repository, '.claude', 'settings.json'),
      JSON.stringify({
        enableAllProjectMcpServers: true,
        env: { PRAXIS_ROOT_SETTINGS_MARKER: markers.rootSettings },
      }),
    ),
    write(
      join(cwd, '.claude', 'settings.local.json'),
      JSON.stringify({
        env: { PRAXIS_SETTINGS_MARKER: markers.settings },
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: 'command',
                  command: `printf "$PRAXIS_ROOT_SETTINGS_MARKER:$PRAXIS_SETTINGS_MARKER:${markers.hook}"`,
                },
              ],
            },
          ],
        },
      }),
    ),
    write(
      join(repository, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          fixture_root: {
            command: process.execPath,
            args: [mcpServer, markers.mcp],
          },
        },
      }),
    ),
    write(
      join(cwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          fixture_cwd: {
            command: process.execPath,
            args: [mcpServer, markers.mcpCwd],
          },
        },
      }),
    ),
    write(
      mcpServer,
      `const marker = process.argv[2]
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
      result = { content: [{ type: 'text', text: marker }] }
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
    'Praxis root instructions',
  )
  assertContains(
    resources.instructions.map((item) => item.content).join('\n'),
    markers.projectPackage,
    'Praxis package instructions',
  )
  assertContains(
    resources.instructions.map((item) => item.content).join('\n'),
    markers.projectCwd,
    'Praxis cwd instructions',
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
  if (resources.commands.length !== 2 || resources.agents.length !== 2) {
    throw new Error('Praxis did not discover shared commands and agents')
  }
  assertContains(
    resources.commands.map((item) => item.content).join('\n'),
    markers.command,
    'Praxis global commands',
  )
  assertContains(
    resources.commands.map((item) => item.content).join('\n'),
    markers.projectCommand,
    'Praxis project commands',
  )
  assertContains(
    resources.agents.map((item) => item.content).join('\n'),
    markers.agent,
    'Praxis global agents',
  )
  assertContains(
    resources.agents.map((item) => item.content).join('\n'),
    markers.projectAgent,
    'Praxis project agents',
  )
  if (resources.settings.length !== 2 || resources.mcp.length !== 2) {
    throw new Error('Praxis did not discover shared settings/hooks and MCP')
  }
  const serializedSettings = JSON.stringify(
    resources.settings.map((item) => item.value),
  )
  assertContains(
    serializedSettings,
    markers.rootSettings,
    'Praxis root settings',
  )
  assertContains(serializedSettings, markers.settings, 'Praxis local settings')
  const serializedMcp = JSON.stringify(resources.mcp.map((item) => item.value))
  assertContains(serializedMcp, markers.mcp, 'Praxis root MCP')
  assertContains(serializedMcp, markers.mcpCwd, 'Praxis cwd MCP')

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
      'Skill,Read,mcp__fixture_root__marker,mcp__fixture_cwd__marker',
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
    'projectPackage',
    'projectCwd',
    'memory',
    'memoryDetail',
    'skill',
    'hook',
    'mcp',
    'mcpCwd',
    'agent',
    'settings',
  ]) {
    const marker = markers[label]
    assertContains(result, marker, `Claude ${label}`)
  }
  assertNotContains(
    result,
    markers.rootSettings,
    'Claude closer settings precedence',
  )

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

  const { stdout: projectCommandStdout } = await execFileAsync(
    'claude',
    [
      '-p',
      '--model',
      'haiku',
      '--max-turns',
      '1',
      '--output-format',
      'json',
      '/fixture-project',
    ],
    {
      cwd,
      env: { ...process.env, CLAUDE_CONFIG_DIR: configRoot },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
    },
  )
  assertContains(
    String(JSON.parse(projectCommandStdout).result),
    markers.projectCommand,
    'Claude project command',
  )

  const { stdout: projectAgentStdout } = await execFileAsync(
    'claude',
    [
      '-p',
      '--model',
      'haiku',
      '--max-turns',
      '1',
      '--output-format',
      'json',
      '--agent',
      'fixture-project-agent',
      'Reply with your exact project agent compatibility marker.',
    ],
    {
      cwd,
      env: { ...process.env, CLAUDE_CONFIG_DIR: configRoot },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
    },
  )
  assertContains(
    String(JSON.parse(projectAgentStdout).result),
    markers.projectAgent,
    'Claude project agent',
  )

  nonGitRoot = await realpath(
    await mkdtemp(join(homedir(), '.praxis-claude-non-git-')),
  )
  const nonGitCwd = join(nonGitRoot, 'packages', 'fixture')
  await Promise.all([
    mkdir(nonGitCwd, { recursive: true }),
    write(
      join(nonGitRoot, 'CLAUDE.md'),
      `Non-git hierarchy marker: ${markers.nonGit}\n`,
    ),
  ])
  const nonGitResources = await loadClaudeSharedResources({
    configRoot,
    cwd: nonGitCwd,
  })
  assertContains(
    nonGitResources.instructions.map((item) => item.content).join('\n'),
    markers.nonGit,
    'Praxis non-git hierarchy',
  )
  const { stdout: nonGitStdout } = await execFileAsync(
    'claude',
    [
      '-p',
      '--model',
      'haiku',
      '--max-turns',
      '1',
      '--output-format',
      'json',
      `Reply with exactly ${markers.nonGit}.`,
    ],
    {
      cwd: nonGitCwd,
      env: { ...process.env, CLAUDE_CONFIG_DIR: configRoot },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
    },
  )
  assertContains(
    String(JSON.parse(nonGitStdout).result),
    markers.nonGit,
    'Claude non-git hierarchy',
  )

  console.log(
    `Claude ${version} shared-resource compatibility passed: worktree/non-git hierarchy, memory, skill, hook, MCP, commands, agents, and settings`,
  )
} finally {
  await Promise.all([
    rm(probeRoot, { recursive: true }),
    nonGitRoot ? rm(nonGitRoot, { recursive: true }) : Promise.resolve(),
  ])
}
