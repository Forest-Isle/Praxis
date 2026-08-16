import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ClaudeSessionService } from '../dist/application/session-service.js'
import {
  AGENT_COLORS,
  agentColorMessage,
  getClaudeEffectiveAgentColor,
  parseAgentColorInput,
} from '../dist/compatibility/claude/agent-color.js'
import { createClaudeNativeFork } from '../dist/compatibility/claude/fork.js'
import { resolveClaudePaths } from '../dist/compatibility/claude/paths.js'
import { selectClaudeSchemaAdapter } from '../dist/compatibility/claude/schema.js'
import { CLAUDE_2_1_208_COMMAND_BY_NAME } from '../dist/cli/tui/claude-command-inventory.js'
import { mergeTuiSlashCommands } from '../dist/cli/tui/slash-commands.js'
import { detectClaudeVersion, runClaudeJson } from './lib/claude-probe.mjs'

const probeRoot = await mkdtemp(join(tmpdir(), 'praxis-color-command-compat-'))
const configRoot = join(probeRoot, 'config')
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const praxisCli = join(repositoryRoot, 'dist', 'cli.js')

async function runClaude(args, cwd) {
  const result = await runClaudeJson(args, cwd, configRoot)
  if (result.type !== 'result' || result.is_error) {
    throw new Error(`Claude command failed: ${JSON.stringify(result)}`)
  }
  return result
}

const cliEnvironment = { ...process.env, CLAUDE_CONFIG_DIR: configRoot }
delete cliEnvironment.PRAXIS_API_KEY

function runPraxisCli(args, cwd, input) {
  try {
    return execFileSync(process.execPath, [praxisCli, ...args], {
      cwd,
      env: cliEnvironment,
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
    })
  } catch (error) {
    const execution = error
    execution.stdout ??= ''
    execution.stderr ??= ''
    throw execution
  }
}

let providerCalls = 0

function queuedProviderThrows() {
  return {
    capabilities: { streaming: true, usage: true, tools: false },
    async *complete() {
      providerCalls += 1
      // /color commands are provider-free; yielding usage keeps this a valid
      // generator while the final providerCalls assertion below fails loudly.
      yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
      throw new Error('/color must never invoke the model provider')
    },
  }
}

let canonicalWorkDirectory = ''

async function sessionEntries(sessionId, cwd = canonicalWorkDirectory) {
  const source = await readFile(
    resolveClaudePaths({ configDir: configRoot, cwd, sessionId }).sessionFile,
    'utf8',
  )
  return source
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

async function countAgentColorEntries(sessionId) {
  return (await sessionEntries(sessionId)).filter(
    (entry) => entry.type === 'agent-color',
  ).length
}

try {
  const version = await detectClaudeVersion('Color command compatibility probe')
  const schema = selectClaudeSchemaAdapter(version)
  const workDirectory = join(probeRoot, 'work')
  await mkdir(workDirectory, { recursive: true })
  canonicalWorkDirectory = await realpath(workDirectory)

  // Proof 1: /color is discoverable in the shipped slash catalog with the
  // exact description and argument hint from the Claude 2.1.208 registry.
  {
    const catalog = mergeTuiSlashCommands([])
    const color = catalog.find((command) => command.name === 'color')
    assert.deepEqual(color, {
      name: 'color',
      description: 'Set the prompt bar color for this session',
      argumentHint: '[red|blue|green|yellow|purple|orange|pink|cyan|default]',
      source: 'builtin',
    })
    assert.deepEqual(CLAUDE_2_1_208_COMMAND_BY_NAME.get('color'), {
      name: 'color',
      disposition: 'included',
      visibility: 'visible',
    })
    console.log('Proof 1 passed: /color catalog discovery matches 2.1.208')
  }

  // Proof 2: real Claude Code 2.1.208 executes /color with zero model
  // requests and writes the exact native agent-color transcript shape.
  {
    const origin = await runClaude(
      ['-p', '/color purple', '--max-turns', '1', '--output-format', 'json'],
      canonicalWorkDirectory,
    )
    assert.equal(origin.result, 'Session color set to: purple')
    assert.equal(origin.num_turns, 0, 'Claude /color made a model turn')
    assert.equal(origin.total_cost_usd, 0, 'Claude /color incurred cost')
    const claudeSessionId = origin.session_id
    const entries = await sessionEntries(claudeSessionId)
    assert.deepEqual(
      entries[0],
      {
        type: 'agent-color',
        agentColor: 'purple',
        sessionId: claudeSessionId,
      },
      'Claude native agent-color entry does not match the documented shape',
    )
    const transcript = entries.map((entry) => JSON.stringify(entry)).join('\n')
    assert(transcript.includes('<command-name>/color</command-name>'))
    assert(transcript.includes('<command-args>purple</command-args>'))
    assert(
      transcript.includes(
        '<local-command-stdout>Session color set to: purple</local-command-stdout>',
      ),
    )
    const agentColorEntry = entries.find(
      (entry) => entry.type === 'agent-color',
    )
    assert.doesNotThrow(() => schema.serializeForAppend(agentColorEntry))
    assert.doesNotThrow(() => schema.serializeForFork(agentColorEntry))
    const fork = createClaudeNativeFork({
      source: entries,
      sourceSessionId: claudeSessionId,
      sessionId: '99999999-9999-4999-8999-999999999999',
    })
    assert.deepEqual(
      fork.filter((entry) => entry.type === 'agent-color'),
      [
        {
          type: 'agent-color',
          agentColor: 'purple',
          sessionId: fork[0].sessionId,
        },
      ],
      'fork must keep exactly one effective agent-color',
    )
    console.log('Proof 2 passed: Claude runs /color without a model request')
    assert.equal(
      getClaudeEffectiveAgentColor(entries, claudeSessionId),
      'purple',
    )
  }

  // Proof 3: Claude reset aliases round-trip through the effective color
  // reader that the Praxis session picker and resume flow use.
  {
    const origin = await runClaude(
      ['-p', '/color green', '--max-turns', '1', '--output-format', 'json'],
      canonicalWorkDirectory,
    )
    const claudeSessionId = origin.session_id
    const before = await sessionEntries(claudeSessionId)
    assert.equal(getClaudeEffectiveAgentColor(before, claudeSessionId), 'green')
    const reset = await runClaude(
      [
        '-p',
        '--resume',
        claudeSessionId,
        '/color default',
        '--max-turns',
        '1',
        '--output-format',
        'json',
      ],
      canonicalWorkDirectory,
    )
    assert.equal(reset.result, 'Session color reset to default')
    assert.equal(reset.num_turns, 0)
    assert.equal(reset.session_id, claudeSessionId)
    const after = await sessionEntries(claudeSessionId)
    assert.equal(
      getClaudeEffectiveAgentColor(after, claudeSessionId),
      undefined,
      'reset default must read as no color',
    )
    console.log('Proof 3 passed: Claude color set/reset reads back exactly')
  }

  // Proof 4: the Praxis service writes the native pair provider-free for a
  // fresh session, an invalid color, and a reset.
  {
    const service = new ClaudeSessionService({
      configRoot,
      cwd: canonicalWorkDirectory,
      claudeVersion: version,
      provider: queuedProviderThrows(),
    })
    const sessionId = await service.recordColorUsage(
      undefined,
      { kind: 'color', color: 'orange' },
      '/color orange',
      'bypassPermissions',
    )
    const entries = await sessionEntries(sessionId)
    assert.deepEqual(entries.slice(0, 3), [
      { type: 'agent-color', agentColor: 'orange', sessionId },
      { type: 'mode', mode: 'normal', sessionId },
      {
        type: 'permission-mode',
        permissionMode: 'bypassPermissions',
        sessionId,
      },
    ])
    const pair = entries.slice(3)
    assert.deepEqual(
      pair.map((entry) => entry.type),
      ['system', 'system'],
    )
    assert(pair[0].content.includes('<command-name>/color</command-name>'))
    assert(pair[0].content.includes('<command-args>orange</command-args>'))
    assert(
      pair[1].content.includes(
        '<local-command-stdout>Session color set to: orange</local-command-stdout>',
      ),
    )
    const history = await readFile(join(configRoot, 'history.jsonl'), 'utf8')
    assert(history.includes('"display":"/color orange"'))
    assert.equal(await service.readEffectiveAgentColor(sessionId), 'orange')

    await service.recordColorUsage(
      sessionId,
      { kind: 'invalid', input: 'bogus' },
      '/color bogus',
    )
    assert.equal(
      await countAgentColorEntries(sessionId),
      1,
      'an invalid color must not append an agent-color entry',
    )
    const afterInvalid = await sessionEntries(sessionId)
    assert(
      afterInvalid
        .at(-1)
        .content.includes(
          'Invalid color "bogus". Available colors: red, blue, green, yellow, purple, orange, pink, cyan, default',
        ),
    )
    assert.equal(await service.readEffectiveAgentColor(sessionId), 'orange')

    await service.recordColorUsage(sessionId, { kind: 'reset' }, '/color reset')
    const afterReset = await sessionEntries(sessionId)
    assert.deepEqual(
      afterReset.filter((entry) => entry.type === 'agent-color').at(-1),
      { type: 'agent-color', agentColor: 'default', sessionId },
    )
    assert.equal(await service.readEffectiveAgentColor(sessionId), undefined)
    console.log(
      'Proof 4 passed: Praxis /color writes are provider-free and native',
    )
  }

  // Proof 5: real Claude Code resumes a Praxis-created color session and the
  // random/invalid/message contract holds.
  {
    const service = new ClaudeSessionService({
      configRoot,
      cwd: canonicalWorkDirectory,
      claudeVersion: version,
      provider: queuedProviderThrows(),
    })
    const sessionId = await service.recordColorUsage(
      undefined,
      { kind: 'color', color: 'orange' },
      '/color orange',
    )
    const resumed = await runClaude(
      [
        '-p',
        '--resume',
        sessionId,
        '/color cyan',
        '--max-turns',
        '1',
        '--output-format',
        'json',
      ],
      canonicalWorkDirectory,
    )
    assert.equal(resumed.result, 'Session color set to: cyan')
    assert.equal(resumed.num_turns, 0, 'Claude resumed with a model request')
    assert.equal(resumed.session_id, sessionId)
    assert.equal(
      await service.readEffectiveAgentColor(sessionId),
      'cyan',
      'Claude did not preserve the effective color on the Praxis session',
    )

    for (let index = 0; index < 200; index += 1) {
      const selection = parseAgentColorInput('')
      assert.equal(selection.kind, 'color')
      assert(AGENT_COLORS.includes(selection.color))
    }
    assert.deepEqual(parseAgentColorInput('  Bogus '), {
      kind: 'invalid',
      input: 'bogus',
    })
    assert.deepEqual(parseAgentColorInput('Grey'), { kind: 'reset' })
    assert.deepEqual(parseAgentColorInput('none'), { kind: 'reset' })
    assert.equal(
      agentColorMessage({ kind: 'color', color: 'pink' }),
      'Session color set to: pink',
    )
    assert.equal(
      agentColorMessage({ kind: 'reset' }),
      'Session color reset to default',
    )
    assert.equal(
      agentColorMessage({ kind: 'invalid', input: 'nope' }),
      'Invalid color "nope". Available colors: red, blue, green, yellow, purple, orange, pink, cyan, default',
    )
    console.log(
      'Proof 5 passed: Claude resumes Praxis color sessions; parse contract holds',
    )
  }

  // Proof 6: the built Praxis CLI runs /color provider-free end to end in
  // text, JSON, and stream-json modes, including explicit ids, session
  // routing, and the no-persistence flag.
  {
    const cliWorkDirectory = join(probeRoot, 'work-cli')
    await mkdir(cliWorkDirectory, { recursive: true })
    const cliCwd = await realpath(cliWorkDirectory)

    const text = runPraxisCli(['-p', '/color purple'], cliCwd)
    assert.equal(text, 'Session color set to: purple\n')
    const textSessionFiles = await readdir(
      resolveClaudePaths({
        configDir: configRoot,
        cwd: cliCwd,
        sessionId: '00000000-0000-4000-8000-000000000000',
      }).projectRoot,
    )
    assert.equal(textSessionFiles.length, 1)
    const textSessionId = textSessionFiles[0].slice(0, -6)
    const textEntries = await sessionEntries(textSessionId, cliCwd)
    assert.deepEqual(textEntries[0], {
      type: 'agent-color',
      agentColor: 'purple',
      sessionId: textSessionId,
    })
    assert(
      textEntries.some(
        (entry) =>
          entry.type === 'system' &&
          entry.content.includes(
            '<local-command-stdout>Session color set to: purple</local-command-stdout>',
          ),
      ),
    )

    const json = runPraxisCli(
      ['-p', '--output-format', 'json', '/color orange'],
      cliCwd,
    )
    const jsonEnvelope = JSON.parse(json)
    assert.deepEqual(
      {
        type: jsonEnvelope.type,
        subtype: jsonEnvelope.subtype,
        is_error: jsonEnvelope.is_error,
        duration_api_ms: jsonEnvelope.duration_api_ms,
        num_turns: jsonEnvelope.num_turns,
        result: jsonEnvelope.result,
        stop_reason: jsonEnvelope.stop_reason,
        total_cost_usd: jsonEnvelope.total_cost_usd,
        usage: jsonEnvelope.usage,
        modelUsage: jsonEnvelope.modelUsage,
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_api_ms: 0,
        num_turns: 0,
        result: 'Session color set to: orange',
        stop_reason: null,
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        modelUsage: {},
      },
    )
    const jsonSessionId = jsonEnvelope.session_id
    assert(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        jsonSessionId,
      ),
    )

    const continued = JSON.parse(
      runPraxisCli(
        ['-p', '--continue', '--output-format', 'json', '/color yellow'],
        cliCwd,
      ),
    )
    assert.equal(continued.result, 'Session color set to: yellow')
    assert.equal(continued.num_turns, 0)
    assert.equal(
      continued.session_id,
      jsonSessionId,
      '--continue must reuse the most recent local session',
    )

    const streamInput = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '/color red' },
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '/color blue' },
      }),
      '',
    ].join('\n')
    const stream = runPraxisCli(
      [
        'run',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
      ],
      cliCwd,
      streamInput,
    )
    const streamRecords = stream
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.deepEqual(
      streamRecords.map((record) => record.type),
      ['system', 'assistant', 'result', 'system', 'assistant', 'result'],
      'stream-json must emit init, synthetic assistant, and result per turn',
    )
    assert.equal(streamRecords[0].type, 'system')
    assert.equal(streamRecords[0].subtype, 'init')
    assert.equal(streamRecords[0].session_id, streamRecords[2].session_id)
    assert.equal(streamRecords[1].message.model, '<synthetic>')
    assert.equal(streamRecords[1].message.stop_reason, 'stop_sequence')
    assert.equal(streamRecords[1].message.stop_sequence, '')
    assert.equal(streamRecords[1].message.usage.input_tokens, 0)
    assert.equal(streamRecords[1].message.usage.output_tokens, 0)
    assert.equal(streamRecords[1].parent_tool_use_id, null)
    assert.equal(
      streamRecords[1].message.content[0].text,
      'Session color set to: red',
    )
    assert.equal(streamRecords[2].subtype, 'success')
    assert.equal(streamRecords[2].num_turns, 0)
    assert.equal(streamRecords[2].duration_api_ms, 0)
    assert.equal(streamRecords[2].total_cost_usd, 0)
    assert.deepEqual(streamRecords[2].usage, {
      input_tokens: 0,
      output_tokens: 0,
    })
    assert.deepEqual(streamRecords[2].modelUsage, {})
    assert.equal(streamRecords[2].stop_reason, null)
    assert.equal(streamRecords[3].type, 'system')
    assert.equal(streamRecords[3].subtype, 'init')
    assert.equal(streamRecords[3].session_id, streamRecords[2].session_id)
    assert.equal(
      streamRecords[4].message.content[0].text,
      'Session color set to: blue',
    )
    assert.equal(streamRecords[4].session_id, streamRecords[2].session_id)
    assert.equal(streamRecords[5].num_turns, 0)
    assert.equal(streamRecords[5].session_id, streamRecords[2].session_id)
    const streamEntries = await sessionEntries(
      streamRecords[2].session_id,
      cliCwd,
    )
    assert.deepEqual(
      streamEntries.filter((entry) => entry.type === 'agent-color'),
      [
        {
          type: 'agent-color',
          agentColor: 'red',
          sessionId: streamRecords[2].session_id,
        },
        {
          type: 'agent-color',
          agentColor: 'blue',
          sessionId: streamRecords[2].session_id,
        },
      ],
    )

    const explicitId = '26262626-2626-4262-8262-262626262626'
    const explicit = JSON.parse(
      runPraxisCli(
        [
          '-p',
          '--session-id',
          explicitId,
          '--output-format',
          'json',
          '/color green',
        ],
        cliCwd,
      ),
    )
    assert.equal(explicit.result, 'Session color set to: green')
    assert.equal(explicit.session_id, explicitId)
    const explicitEntries = await sessionEntries(explicitId, cliCwd)
    assert.deepEqual(explicitEntries[0], {
      type: 'agent-color',
      agentColor: 'green',
      sessionId: explicitId,
    })

    assert.throws(
      () =>
        runPraxisCli(
          [
            '-p',
            '--session-id',
            explicitId,
            '--output-format',
            'json',
            '/color pink',
          ],
          cliCwd,
        ),
      (error) => {
        if (error.stdout === undefined) return false
        const envelope = JSON.parse(error.stdout)
        return (
          envelope.subtype === 'error_during_execution' &&
          envelope.num_turns === 0 &&
          envelope.errors[0] === `Session ID ${explicitId} is already in use`
        )
      },
    )

    const invalidId = '27272727-2727-4272-8272-272727272727'
    const invalid = JSON.parse(
      runPraxisCli(
        [
          '-p',
          '--session-id',
          invalidId,
          '--output-format',
          'json',
          '/color bogus',
        ],
        cliCwd,
      ),
    )
    assert.equal(
      invalid.result,
      'Invalid color "bogus". Available colors: red, blue, green, yellow, purple, orange, pink, cyan, default',
    )
    assert.equal(invalid.num_turns, 0)
    assert.equal(invalid.session_id, invalidId)
    const invalidEntries = await sessionEntries(invalidId, cliCwd)
    assert(
      invalidEntries.some((entry) => entry.type === 'agent-color') === false,
      'an invalid color must not write an agent-color entry',
    )

    const resumed = JSON.parse(
      runPraxisCli(
        [
          '-p',
          '--resume',
          jsonSessionId,
          '--output-format',
          'json',
          '/color red',
        ],
        cliCwd,
      ),
    )
    assert.equal(resumed.result, 'Session color set to: red')
    assert.equal(resumed.num_turns, 0)
    assert.equal(resumed.session_id, jsonSessionId)

    const forkId = '28282828-2828-4282-8282-282828282828'
    const forked = JSON.parse(
      runPraxisCli(
        [
          '-p',
          '--resume',
          jsonSessionId,
          '--fork-session',
          '--session-id',
          forkId,
          '--output-format',
          'json',
          '/color cyan',
        ],
        cliCwd,
      ),
    )
    assert.equal(forked.result, 'Session color set to: cyan')
    assert.equal(forked.num_turns, 0)
    assert.equal(forked.session_id, forkId)
    const forkEntries = await sessionEntries(forkId, cliCwd)
    assert.deepEqual(
      forkEntries.filter((entry) => entry.type === 'agent-color'),
      [
        { type: 'agent-color', agentColor: 'red', sessionId: forkId },
        { type: 'agent-color', agentColor: 'cyan', sessionId: forkId },
      ],
      'the fork must carry the effective color and the new selection',
    )
    assert.equal(
      getClaudeEffectiveAgentColor(forkEntries, forkId),
      'cyan',
      'the forked session must end with the new selection effective',
    )

    const beforeNoPersistence = await stat(
      join(configRoot, 'history.jsonl'),
    ).then((meta) => meta.size)
    const ephemeral = JSON.parse(
      runPraxisCli(
        [
          '-p',
          '--no-session-persistence',
          '--output-format',
          'json',
          '/color pink',
        ],
        cliCwd,
      ),
    )
    assert.equal(ephemeral.result, 'Session color set to: pink')
    assert.equal(ephemeral.num_turns, 0)
    const afterNoPersistence = await stat(
      join(configRoot, 'history.jsonl'),
    ).then((meta) => meta.size)
    assert.equal(
      afterNoPersistence,
      beforeNoPersistence,
      '--no-session-persistence must not write input history',
    )
    const sessionFilesAfter = await readdir(
      resolveClaudePaths({
        configDir: configRoot,
        cwd: cliCwd,
        sessionId: '00000000-0000-4000-8000-000000000000',
      }).projectRoot,
    )
    assert(
      sessionFilesAfter.includes(`${ephemeral.session_id}.jsonl`) === false,
      '--no-session-persistence must not write a transcript',
    )

    assert.throws(
      () =>
        runPraxisCli(
          ['-p', '--disable-slash-commands', '/color purple'],
          cliCwd,
        ),
      (error) =>
        error.stderr?.includes(
          'PRAXIS_API_KEY and a model (--model or PRAXIS_MODEL) are required',
        ) === true,
      '--disable-slash-commands must follow the ordinary provider path',
    )

    console.log(
      'Proof 6 passed: Praxis CLI /color runs provider-free end to end',
    )
  }

  assert.equal(providerCalls, 0, 'a /color command invoked the model provider')
  console.log(`Claude ${version} /color parity passed: all six proofs`)
} finally {
  await rm(probeRoot, { recursive: true })
}
