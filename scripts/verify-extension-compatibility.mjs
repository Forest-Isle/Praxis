import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import {
  detectClaudeVersion,
  runClaudeJson,
  writeFixture as write,
} from './lib/claude-probe.mjs'

const execFileAsync = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), 'praxis-extension-compat-'))
const markers = {
  command: 'EXTENSION_COMMAND_2147',
  nestedCommand: 'EXTENSION_NESTED_COMMAND_2199',
  skill: 'EXTENSION_SKILL_3258',
  invalidMetadata: 'EXTENSION_INVALID_METADATA_3271',
  agent: 'EXTENSION_AGENT_4369',
}

function sse(response, payloads) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(
    `${payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join('')}data: [DONE]\n\n`,
  )
}

const server = createServer(async (request, response) => {
  let body = ''
  request.setEncoding('utf8')
  for await (const chunk of request) body += chunk
  const providerRequest = JSON.parse(body)
  const serialized = JSON.stringify(providerRequest.messages ?? [])
  const tools = providerRequest.tools ?? []
  if (
    serialized.includes('INVOKE_EXTENSION_SKILL') &&
    !serialized.includes('Launching skill: fixture-skill')
  ) {
    const skillTool = tools.find((tool) => tool.function?.name === 'Skill')
    if (
      !skillTool?.function?.parameters?.properties?.skill?.enum?.includes(
        'fixture-skill',
      )
    ) {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          error: { message: 'Skill tool missing fixture-skill' },
        }),
      )
      return
    }
    sse(response, [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_extension_skill',
                  type: 'function',
                  function: {
                    name: 'Skill',
                    arguments: JSON.stringify({
                      skill: 'fixture-skill',
                      args: 'tool args',
                    }),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    ])
    return
  }

  let expected
  if (serialized.includes('INVOKE_EXTENSION_SKILL')) expected = markers.skill
  else if (serialized.includes('PRAXIS_RESUME_CLAUDE_COMMAND')) {
    if (!serialized.includes(markers.command)) {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          error: { message: 'Claude command history missing' },
        }),
      )
      return
    }
    expected = markers.command
  } else if (serialized.includes(markers.command)) expected = markers.command
  else if (serialized.includes(markers.nestedCommand))
    expected = markers.nestedCommand
  else if (serialized.includes(markers.skill)) expected = markers.skill
  else if (serialized.includes(markers.invalidMetadata))
    expected = markers.invalidMetadata
  else if (serialized.includes(markers.agent)) expected = markers.agent
  if (!expected) {
    response.writeHead(500, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({ error: { message: 'extension context missing' } }),
    )
    return
  }
  sse(response, [{ choices: [{ delta: { content: expected } }] }])
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

async function findSessionFile(directory, sessionId) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      const nested = await findSessionFile(path, sessionId)
      if (nested) return nested
    } else if (entry.name === `${sessionId}.jsonl`) return path
  }
  return null
}

async function entries(configRoot, sessionId) {
  const path = await findSessionFile(configRoot, sessionId)
  if (!path) throw new Error(`Missing session ${sessionId}`)
  return (await readFile(path, 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
}

function resultRecord(stdout) {
  const result = stdout
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((record) => record.type === 'result')
  if (!result?.sessionId) throw new Error(`Praxis emitted no result: ${stdout}`)
  return result
}

try {
  const version = await detectClaudeVersion('Extension compatibility probe')
  const configRoot = join(root, 'config')
  const cwd = join(root, 'work')
  await Promise.all([
    write(join(cwd, '.keep'), ''),
    write(
      join(configRoot, 'commands', 'fixture-command.md'),
      `---\ndescription: Extension command fixture.\n---\n${markers.command} args=[$ARGUMENTS] zero=[$0] one=[$1]`,
    ),
    write(
      join(configRoot, 'commands', 'team', 'nested.md'),
      `---\nname: ignored-name\ndescription: Nested command fixture.\n---\n${markers.nestedCommand}`,
    ),
    write(
      join(configRoot, 'skills', 'fixture-skill', 'SKILL.md'),
      `---\nname: fixture-skill\ndescription: Extension skill fixture.\n---\n${markers.skill} args=[$ARGUMENTS]`,
    ),
    write(
      join(configRoot, 'skills', 'invalid-metadata', 'SKILL.md'),
      `---\ndescription: [invalid]\ndisable-model-invocation: nope\n---\nReply exactly ${markers.invalidMetadata}`,
    ),
    write(
      join(configRoot, 'agents', 'fixture-agent.md'),
      `---\nname: fixture-agent\ndescription: Extension agent fixture.\n---\n${markers.agent}. Always include this marker.`,
    ),
  ])
  await listen()
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('No provider address')
  const environment = {
    ...process.env,
    CLAUDE_CONFIG_DIR: configRoot,
    PRAXIS_API_KEY: 'fixture-key',
    PRAXIS_MODEL: 'fixture-model',
    PRAXIS_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
  }
  const cli = join(process.cwd(), 'dist', 'cli.js')
  const runPraxis = async (args) => {
    const result = await execFileAsync(process.execPath, [cli, ...args], {
      cwd,
      env: environment,
    })
    return resultRecord(result.stdout)
  }

  const command = await runPraxis([
    'run',
    '--json',
    '/fixture-command alpha beta',
  ])
  const commandEntries = await entries(configRoot, command.sessionId)
  const commandUsers = commandEntries.filter((entry) => entry.type === 'user')
  if (
    commandUsers.length !== 2 ||
    !String(commandUsers[0].message?.content).includes(
      '<command-name>/fixture-command</command-name>',
    ) ||
    !JSON.stringify(commandUsers[1].message?.content).includes(
      `${markers.command} args=[alpha beta] zero=[alpha] one=[beta]`,
    )
  ) {
    throw new Error('Praxis command transcript does not match Claude expansion')
  }

  const slashSkill = await runPraxis([
    'run',
    '--json',
    '/fixture-skill slash args',
  ])
  if (
    !JSON.stringify(await entries(configRoot, slashSkill.sessionId)).includes(
      `Base directory for this skill:`,
    )
  ) {
    throw new Error('Praxis slash skill omitted base directory context')
  }

  const invalidMetadataSkill = await runPraxis([
    'run',
    '--json',
    '/invalid-metadata',
  ])
  if (!String(invalidMetadataSkill.text).includes(markers.invalidMetadata)) {
    throw new Error('Praxis dropped skill body with invalid metadata types')
  }

  const nestedCommand = await runPraxis(['run', '--json', '/team:nested'])
  const nestedEntries = await entries(configRoot, nestedCommand.sessionId)
  const nestedWrapper = String(
    nestedEntries.find((entry) => entry.type === 'user')?.message?.content,
  )
  if (
    !nestedWrapper.includes('<command-name>/team:nested</command-name>') ||
    nestedWrapper.includes('<command-args>')
  ) {
    throw new Error('Praxis nested no-argument command wrapper is incompatible')
  }

  const toolSkill = await runPraxis(['run', '--json', 'INVOKE_EXTENSION_SKILL'])
  const skillEntries = await entries(configRoot, toolSkill.sessionId)
  if (
    !skillEntries.some((entry) =>
      entry.message?.content?.some?.(
        (block) =>
          block.type === 'tool_result' &&
          block.content === 'Launching skill: fixture-skill',
      ),
    ) ||
    !JSON.stringify(skillEntries).includes(`${markers.skill} args=[tool args]`)
  ) {
    throw new Error('Praxis Skill tool transcript is incomplete')
  }

  const agent = await runPraxis([
    'run',
    '--json',
    '--agent',
    'fixture-agent',
    'Use the selected agent marker.',
  ])
  const agentEntries = await entries(configRoot, agent.sessionId)
  if (
    agentEntries[0]?.type !== 'agent-setting' ||
    agentEntries[0]?.agentSetting !== 'fixture-agent' ||
    !JSON.stringify(agentEntries).includes(markers.agent)
  ) {
    throw new Error('Praxis did not persist native agent context')
  }

  for (const [label, sessionId] of [
    ['command', command.sessionId],
    ['skill', toolSkill.sessionId],
    ['agent', agent.sessionId],
  ]) {
    const acknowledgement = `EXTENSION_RESUME_${label.toUpperCase()}_OK`
    const reopened = await runClaudeJson(
      [
        '-p',
        '--resume',
        sessionId,
        '--model',
        'haiku',
        '--max-turns',
        '1',
        '--tools',
        '',
        '--output-format',
        'json',
        `Reply exactly ${acknowledgement}.`,
      ],
      cwd,
      configRoot,
    )
    if (
      reopened.session_id !== sessionId ||
      !String(reopened.result).includes(acknowledgement)
    ) {
      throw new Error(
        `Claude did not resume Praxis ${label} context: ${JSON.stringify(reopened)}`,
      )
    }
  }

  const native = await runClaudeJson(
    [
      '-p',
      '--model',
      'haiku',
      '--max-turns',
      '3',
      '--output-format',
      'json',
      '/fixture-command native one',
    ],
    cwd,
    configRoot,
  )
  const resumed = await runPraxis([
    'resume',
    '--json',
    native.session_id,
    'PRAXIS_RESUME_CLAUDE_COMMAND',
  ])
  if (!String(resumed.text).includes(markers.command)) {
    throw new Error('Praxis did not resume Claude command expansion')
  }

  const nativeInvalidMetadata = await runClaudeJson(
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
      '/invalid-metadata',
    ],
    cwd,
    configRoot,
  )
  if (!String(nativeInvalidMetadata.result).includes(markers.invalidMetadata)) {
    throw new Error('Claude dropped skill body with invalid metadata types')
  }

  const nativeAgent = await runClaudeJson(
    [
      '-p',
      '--agent',
      'fixture-agent',
      '--model',
      'haiku',
      '--max-turns',
      '1',
      '--output-format',
      'json',
      'Reply with the agent marker.',
    ],
    cwd,
    configRoot,
  )
  const resumedAgent = await runPraxis([
    'resume',
    '--json',
    nativeAgent.session_id,
    'PRAXIS_RESUME_CLAUDE_AGENT',
  ])
  if (!String(resumedAgent.text).includes(markers.agent)) {
    throw new Error('Praxis did not resume Claude agent-setting')
  }

  console.log(
    `Claude ${version} extension compatibility passed: commands, slash/model skills, agent-setting, Praxis→Claude resume, and Claude→Praxis resume`,
  )
} finally {
  if (server.listening) await closeServer()
  await rm(root, { recursive: true })
}
