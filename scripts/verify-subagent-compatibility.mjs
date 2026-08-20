import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ClaudeSessionService } from '../dist/application/session-service.js'
import { resolveClaudePaths } from '../dist/compatibility/claude/paths.js'
import {
  assertContains,
  detectClaudeVersion,
  execFileAsync,
} from './lib/claude-probe.mjs'

const probeRoot = await mkdtemp(join(tmpdir(), 'praxis-subagent-compat-'))

try {
  const version = await detectClaudeVersion('Subagent compatibility probe')
  const configRoot = join(probeRoot, 'config')
  const workDirectory = join(probeRoot, 'work')
  await mkdir(workDirectory, { recursive: true })
  const cwd = await realpath(workDirectory)
  let mainTurn = 0
  const provider = {
    model: 'praxis-subagent-probe',
    capabilities: { streaming: true, usage: true, tools: true },
    async *complete(request) {
      const serialized = JSON.stringify(request.messages)
      if (serialized.includes('general-purpose subagent')) {
        yield {
          type: 'text-delta',
          delta: 'PRAXIS_S11_SIDECHAIN_MARKER',
        }
        yield {
          type: 'usage',
          usage: { inputTokens: 7, outputTokens: 3 },
        }
      } else if (mainTurn++ === 0) {
        yield {
          type: 'tool-call',
          call: {
            id: 'praxis_s11_agent',
            name: 'Agent',
            input: {
              description: 'Return compatibility marker',
              prompt: 'Return PRAXIS_S11_SIDECHAIN_MARKER',
              subagent_type: 'general-purpose',
              run_in_background: false,
            },
          },
        }
        yield {
          type: 'usage',
          usage: { inputTokens: 8, outputTokens: 4 },
        }
      } else {
        if (!serialized.includes('PRAXIS_S11_SIDECHAIN_MARKER')) {
          throw new Error('Main continuation omitted subagent result')
        }
        yield { type: 'text-delta', delta: 'PRAXIS_S11_MAIN_MARKER' }
        yield {
          type: 'usage',
          usage: { inputTokens: 8, outputTokens: 4 },
        }
      }
    },
  }
  const tools = {
    definitions: () => [],
    async prepare(call) {
      return call
    },
    async execute(call) {
      throw new Error(`Unexpected base tool ${call.name}`)
    },
  }
  const service = new ClaudeSessionService({
    configRoot,
    cwd,
    claudeVersion: version,
    provider,
    tools,
    permissions: { resolve: () => ({ behavior: 'allow' }) },
    enableSubagents: true,
  })
  const originalSubagentModel = process.env.CLAUDE_CODE_SUBAGENT_MODEL
  delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
  let result
  try {
    result = await service.run('Delegate the compatibility marker.')
  } finally {
    if (originalSubagentModel === undefined) {
      delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
    } else {
      process.env.CLAUDE_CODE_SUBAGENT_MODEL = originalSubagentModel
    }
  }
  if (result.text !== 'PRAXIS_S11_MAIN_MARKER') {
    throw new Error(`Praxis returned unexpected main result: ${result.text}`)
  }
  const paths = resolveClaudePaths({
    configDir: configRoot,
    cwd,
    sessionId: result.sessionId,
  })
  const mainSource = await readFile(paths.sessionFile, 'utf8')
  const subagentDirectory = join(
    paths.projectRoot,
    result.sessionId,
    'subagents',
  )
  const files = await readdir(subagentDirectory)
  const transcriptName = files.find((name) => name.endsWith('.jsonl'))
  const metadataName = files.find((name) => name.endsWith('.meta.json'))
  if (!transcriptName || !metadataName) {
    throw new Error('Praxis did not create native sidechain files')
  }
  const sidechainSource = await readFile(
    join(subagentDirectory, transcriptName),
    'utf8',
  )
  const metadataSource = await readFile(
    join(subagentDirectory, metadataName),
    'utf8',
  )
  assertContains(mainSource, '"status":"completed"', 'Praxis main Agent result')
  assertContains(
    sidechainSource,
    'PRAXIS_S11_SIDECHAIN_MARKER',
    'Praxis native sidechain',
  )
  assertContains(
    metadataSource,
    '"toolUseId":"praxis_s11_agent"',
    'Praxis native sidechain metadata',
  )

  const { stdout } = await execFileAsync(
    'claude',
    [
      '-p',
      '--resume',
      result.sessionId,
      '--model',
      'haiku',
      '--max-turns',
      '1',
      '--tools',
      '',
      '--output-format',
      'json',
      'Reply with exactly the marker returned by the prior subagent.',
    ],
    {
      cwd,
      env: { ...process.env, CLAUDE_CONFIG_DIR: configRoot },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
    },
  )
  const response = JSON.parse(stdout)
  if (
    response.type !== 'result' ||
    response.is_error ||
    response.session_id !== result.sessionId
  ) {
    throw new Error(`Claude failed to reopen Praxis Agent session: ${stdout}`)
  }
  assertContains(
    String(response.result),
    'PRAXIS_S11_SIDECHAIN_MARKER',
    'Claude resume of Praxis Agent session',
  )
  if (
    (await readFile(join(subagentDirectory, transcriptName), 'utf8')) !==
      sidechainSource ||
    (await readFile(join(subagentDirectory, metadataName), 'utf8')) !==
      metadataSource
  ) {
    throw new Error('Claude reopen changed Praxis native sidechain files')
  }

  console.log(
    `Claude ${version} native foreground subagent compatibility passed: Praxis write, sidechain discovery, and Claude resume`,
  )
} finally {
  await rm(probeRoot, { recursive: true })
}
