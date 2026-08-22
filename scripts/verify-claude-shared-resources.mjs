import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { sanitizeClaudeProjectPath } from '../dist/compatibility/claude/paths.js'
import { ClaudeContextAssembler } from '../dist/compatibility/claude/context.js'
import {
  loadClaudeContextResources,
  loadClaudeSharedResources,
} from '../dist/compatibility/claude/shared-resources.js'
import {
  assertContains,
  assertNotContains,
  detectClaudeVersion,
  execFileAsync,
  runClaudeJson,
  writeFixture as write,
} from './lib/claude-probe.mjs'

const markers = {
  global: 'SHARED_GLOBAL_1041',
  project: 'SHARED_PROJECT_2052',
  localInstruction: 'SHARED_LOCAL_INSTRUCTION_2108',
  projectPackage: 'SHARED_PROJECT_PACKAGE_2163',
  projectCwd: 'SHARED_PROJECT_CWD_2274',
  rule: 'SHARED_RULE_2304',
  userRule: 'SHARED_USER_RULE_2326',
  conditionalRule: 'SHARED_CONDITIONAL_RULE_2348',
  nonGit: 'SHARED_NON_GIT_2385',
  nonGitSkill: 'SHARED_NON_GIT_SKILL_2496',
  nonGitCommand: 'SHARED_NON_GIT_COMMAND_2507',
  nonGitAgent: 'SHARED_NON_GIT_AGENT_2618',
  memory: 'SHARED_MEMORY_3063',
  memoryDetail: 'SHARED_MEMORY_DETAIL_3174',
  memoryBoundary: 'SHARED_MEMORY_LINE_200_3230',
  memoryBeyondIndex: 'SHARED_MEMORY_AFTER_LINE_200_3285',
  skill: 'SHARED_SKILL_4074',
  hook: 'SHARED_HOOK_5085',
  mcp: 'SHARED_MCP_6096',
  mcpCwd: 'SHARED_MCP_CWD_6207',
  command: 'SHARED_COMMAND_7107',
  projectCommand: 'SHARED_PROJECT_COMMAND_7218',
  agent: 'SHARED_AGENT_8218',
  projectAgent: 'SHARED_PROJECT_AGENT_8329',
  settings: 'SHARED_SETTINGS_9329',
  cwdSettings: 'SHARED_CWD_SETTINGS_9374',
  rootSettings: 'SHARED_ROOT_SETTINGS_9430',
}

const probeRoot = await mkdtemp(join(tmpdir(), 'praxis-claude-shared-'))
let nonGitRoot

try {
  const version = await detectClaudeVersion('Shared-resource probe')

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
  const memoryIndex = [
    `Auto-memory marker: ${markers.memory}`,
    '- [Details](details.md)',
    ...Array.from(
      { length: 197 },
      (_, index) => `Memory compatibility filler line ${index + 3}`,
    ),
    `Memory boundary marker: ${markers.memoryBoundary}`,
    `Out-of-index marker: ${markers.memoryBeyondIndex}`,
  ].join('\n')

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
      join(repository, 'CLAUDE.local.md'),
      `Local instruction compatibility marker: ${markers.localInstruction}\n`,
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
      join(cwd, '.claude', 'rules', 'fixture.md'),
      `Rule compatibility marker: ${markers.rule}\n`,
    ),
    write(
      join(configRoot, 'rules', 'fixture.md'),
      `User rule compatibility marker: ${markers.userRule}\n`,
    ),
    write(
      join(cwd, '.claude', 'rules', 'conditional.md'),
      `---\npaths:\n  - "src/**"\n---\nConditional rule marker: ${markers.conditionalRule}\n`,
    ),
    write(join(projectMemoryDirectory, 'MEMORY.md'), memoryIndex),
    write(
      join(projectMemoryDirectory, 'details.md'),
      `Detailed memory marker: ${markers.memoryDetail}\n`,
    ),
    write(
      join(repository, '.claude', 'skills', 'fixture-matrix', 'SKILL.md'),
      `---\nname: fixture-matrix\ndescription: Verify the shared compatibility matrix.\n---\n\nSkill marker: ${markers.skill}. Read ${join(projectMemoryDirectory, 'details.md')}, call mcp__fixture_root__marker and mcp__fixture_cwd__marker once each, then reply with one JSON object containing every exact marker visible from global/root/local/package/cwd/rule instructions, memory index/detail, skill, hooks/settings, both MCP tools, and active agent.\n`,
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
      join(cwd, '.claude', 'settings.json'),
      JSON.stringify({
        enableAllProjectMcpServers: true,
        env: { PRAXIS_CWD_SETTINGS_MARKER: markers.cwdSettings },
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
                  command: `printf "$PRAXIS_CWD_SETTINGS_MARKER:$PRAXIS_SETTINGS_MARKER:$PRAXIS_ROOT_SETTINGS_MARKER:${markers.hook}"`,
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
    markers.localInstruction,
    'Praxis local instructions',
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
    resources.instructions.map((item) => item.content).join('\n'),
    markers.rule,
    'Praxis rules',
  )
  assertContains(
    resources.instructions.map((item) => item.content).join('\n'),
    markers.userRule,
    'Praxis user rules',
  )
  assertContains(
    resources.instructions.map((item) => item.content).join('\n'),
    markers.conditionalRule,
    'Praxis conditional rule discovery',
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
  const contextResources = await loadClaudeContextResources({
    configRoot,
    cwd,
  })
  const { systemMessages } = await new ClaudeContextAssembler({
    loadResources: async () => contextResources,
  }).assemble()
  if (systemMessages.length === 0) {
    throw new Error('Praxis did not assemble shared system context')
  }
  const systemContext = systemMessages
    .map(({ content }) => content)
    .join('\n\n')
  for (const label of [
    'global',
    'project',
    'localInstruction',
    'projectPackage',
    'projectCwd',
    'rule',
    'userRule',
    'memory',
    'memoryBoundary',
  ]) {
    assertContains(systemContext, markers[label], `Praxis assembled ${label}`)
  }
  assertNotContains(
    systemContext,
    markers.memoryDetail,
    'Praxis deferred memory detail',
  )
  assertNotContains(
    systemContext,
    markers.conditionalRule,
    'Praxis deferred conditional rule',
  )
  assertNotContains(
    systemContext,
    markers.memoryBeyondIndex,
    'Praxis memory index line limit',
  )
  for (const label of ['skill', 'command', 'agent']) {
    assertNotContains(systemContext, markers[label], `Praxis deferred ${label}`)
  }
  if (resources.settings.length !== 2 || resources.mcp.length !== 2) {
    throw new Error('Praxis did not discover shared settings/hooks and MCP')
  }
  const serializedSettings = JSON.stringify(
    resources.settings.map((item) => item.value),
  )
  assertContains(serializedSettings, markers.cwdSettings, 'Praxis cwd settings')
  assertContains(serializedSettings, markers.settings, 'Praxis local settings')
  assertNotContains(
    serializedSettings,
    markers.rootSettings,
    'Praxis parent settings boundary',
  )
  const serializedMcp = JSON.stringify(resources.mcp.map((item) => item.value))
  assertContains(serializedMcp, markers.mcp, 'Praxis root MCP')
  assertContains(serializedMcp, markers.mcpCwd, 'Praxis cwd MCP')

  const baseContextResponse = await runClaudeJson(
    [
      '-p',
      '--model',
      'haiku',
      '--max-turns',
      '1',
      '--tools',
      '',
      '--output-format',
      'json',
      'Without using tools, reply with every exact token matching SHARED_[A-Z0-9_]+ already present in your instructions or auto-memory.',
    ],
    cwd,
    configRoot,
  )
  const baseContextResult = String(baseContextResponse.result)
  for (const label of [
    'global',
    'project',
    'rule',
    'userRule',
    'memory',
    'memoryBoundary',
  ]) {
    assertContains(
      baseContextResult,
      markers[label],
      `Claude base context ${label}`,
    )
  }
  assertNotContains(
    baseContextResult,
    markers.memoryDetail,
    'Claude deferred memory detail',
  )
  assertNotContains(
    baseContextResult,
    markers.conditionalRule,
    'Claude deferred conditional rule',
  )
  assertNotContains(
    baseContextResult,
    markers.memoryBeyondIndex,
    'Claude memory index line limit',
  )

  const response = await runClaudeJson(
    [
      '-p',
      '--model',
      'haiku',
      '--max-turns',
      '8',
      '--output-format',
      'json',
      '--allowedTools',
      'Skill,Read,mcp__fixture_root__marker,mcp__fixture_cwd__marker',
      '--agent',
      'fixture-agent',
      '--dangerously-skip-permissions',
      '/fixture-matrix',
    ],
    cwd,
    configRoot,
  )
  const result = String(response.result)
  for (const label of [
    'global',
    'project',
    'localInstruction',
    'projectPackage',
    'projectCwd',
    'rule',
    'userRule',
    'memory',
    'memoryBoundary',
    'memoryDetail',
    'skill',
    'hook',
    'mcp',
    'mcpCwd',
    'agent',
    'settings',
    'cwdSettings',
  ]) {
    const marker = markers[label]
    assertContains(result, marker, `Claude ${label}`)
  }
  assertNotContains(
    result,
    markers.rootSettings,
    'Claude closer settings precedence',
  )

  const commandResponse = await runClaudeJson(
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
    cwd,
    configRoot,
  )
  assertContains(
    String(commandResponse.result),
    markers.command,
    'Claude command',
  )

  const projectCommandResponse = await runClaudeJson(
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
    cwd,
    configRoot,
  )
  assertContains(
    String(projectCommandResponse.result),
    markers.projectCommand,
    'Claude project command',
  )

  const projectAgentResponse = await runClaudeJson(
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
    cwd,
    configRoot,
  )
  assertContains(
    String(projectAgentResponse.result),
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
    write(
      join(nonGitRoot, '.claude', 'skills', 'non-git-skill', 'SKILL.md'),
      `---\nname: non-git-skill\ndescription: Non-git project skill fixture.\n---\nReply with exactly ${markers.nonGitSkill}.\n`,
    ),
    write(
      join(nonGitRoot, '.claude', 'commands', 'non-git-command.md'),
      `Reply with exactly ${markers.nonGitCommand}.\n`,
    ),
    write(
      join(nonGitRoot, '.claude', 'agents', 'non-git-agent.md'),
      `---\nname: non-git-agent\ndescription: Non-git project agent fixture.\n---\nReply with exactly ${markers.nonGitAgent}.\n`,
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
  assertContains(
    nonGitResources.skills.map((item) => item.content).join('\n'),
    markers.nonGitSkill,
    'Praxis non-git project skill',
  )
  assertContains(
    nonGitResources.commands.map((item) => item.content).join('\n'),
    markers.nonGitCommand,
    'Praxis non-git project command',
  )
  assertContains(
    nonGitResources.agents.map((item) => item.content).join('\n'),
    markers.nonGitAgent,
    'Praxis non-git project agent',
  )
  const nonGitResponse = await runClaudeJson(
    [
      '-p',
      '--model',
      'haiku',
      '--max-turns',
      '1',
      '--output-format',
      'json',
      'Reply with exactly the marker declared by the nearest non-git CLAUDE.md instruction.',
    ],
    nonGitCwd,
    configRoot,
  )
  assertContains(
    String(nonGitResponse.result),
    markers.nonGit,
    'Claude non-git hierarchy',
  )
  const nonGitSkillResponse = await runClaudeJson(
    [
      '-p',
      '--model',
      'haiku',
      '--max-turns',
      '1',
      '--output-format',
      'json',
      '/non-git-skill',
    ],
    nonGitCwd,
    configRoot,
  )
  assertContains(
    String(nonGitSkillResponse.result),
    markers.nonGitSkill,
    'Claude non-git project skill',
  )
  const nonGitCommandResponse = await runClaudeJson(
    [
      '-p',
      '--model',
      'haiku',
      '--max-turns',
      '1',
      '--output-format',
      'json',
      '/non-git-command',
    ],
    nonGitCwd,
    configRoot,
  )
  assertContains(
    String(nonGitCommandResponse.result),
    markers.nonGitCommand,
    'Claude non-git project command',
  )
  const nonGitAgentResponse = await runClaudeJson(
    [
      '-p',
      '--model',
      'haiku',
      '--max-turns',
      '1',
      '--output-format',
      'json',
      '--agent',
      'non-git-agent',
      'Follow your agent instructions.',
    ],
    nonGitCwd,
    configRoot,
  )
  assertContains(
    String(nonGitAgentResponse.result),
    markers.nonGitAgent,
    'Claude non-git project agent',
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
