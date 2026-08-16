import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { createClaudeNativeFork } from './fork.js'
import {
  selectClaudeSchemaAdapter,
  type ClaudeTranscriptEntry,
} from './schema.js'

const fixtureRoot = new URL(
  '../../../test/fixtures/claude-code/2.1.208/',
  import.meta.url,
)

async function fixture(name: string): Promise<ClaudeTranscriptEntry[]> {
  return (await readFile(new URL(name, fixtureRoot), 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as ClaudeTranscriptEntry)
}

async function completeFixture(
  source: ClaudeTranscriptEntry[],
): Promise<ClaudeTranscriptEntry[]> {
  const uuids = new Set(
    source
      .map((entry) => entry.uuid)
      .filter((uuid): uuid is string => typeof uuid === 'string'),
  )
  const missingParents = new Set(
    source
      .flatMap((entry) => [entry.parentUuid, entry.logicalParentUuid])
      .filter(
        (uuid): uuid is string => typeof uuid === 'string' && !uuids.has(uuid),
      ),
  )
  if (missingParents.size === 0) return source
  if (missingParents.size !== 1) throw new Error('fixture has multiple roots')
  const [template] = await fixture('basic-session.jsonl')
  if (!template) throw new Error('fixture missing')
  return [
    {
      ...template,
      uuid: [...missingParents][0],
      sessionId: source[0]?.sessionId,
    },
    ...source,
  ]
}

describe('createClaudeNativeFork', () => {
  it.each([
    'basic-session.jsonl',
    'tool-session.jsonl',
    'compact-session.jsonl',
    'media-error-session.jsonl',
    'interrupted-session.jsonl',
  ])('preserves the native %s profile with a new session ID', async (name) => {
    const source = await completeFixture(await fixture(name))
    const sourceSessionId = String(source[0]?.sessionId)
    const sessionId = '99999999-9999-4999-8999-999999999999'
    const fork = createClaudeNativeFork({
      source,
      sourceSessionId,
      sessionId,
    })
    const expected = source.map((entry) => ({ ...entry, sessionId }))
    const schema = selectClaudeSchemaAdapter('2.1.208')

    expect(fork).toEqual(expected)
    expect(fork.map((entry) => schema.serializeForFork(entry))).toEqual(
      expected.map((entry) => JSON.stringify(entry)),
    )
  })

  it('copies title metadata first and drops transient queue state', async () => {
    const [user, assistant, lastPrompt] = await fixture('basic-session.jsonl')
    if (!user || !assistant || !lastPrompt) throw new Error('fixture missing')
    const source = [
      {
        type: 'queue-operation',
        operation: 'enqueue',
        sessionId: user.sessionId,
      },
      user,
      assistant,
      lastPrompt,
      { type: 'mode', mode: 'normal', sessionId: user.sessionId },
      {
        type: 'permission-mode',
        permissionMode: 'default',
        sessionId: user.sessionId,
      },
      {
        type: 'pr-link',
        sessionId: user.sessionId,
        prNumber: 42,
        prUrl: 'https://github.com/owner/repo/pull/42',
        prRepository: 'owner/repo',
        timestamp: '2026-08-08T00:00:00.000Z',
      },
      { type: 'file-history-snapshot', snapshot: {}, messageId: 'snapshot' },
      { type: 'ai-title', aiTitle: 'Native fork', sessionId: user.sessionId },
      {
        type: 'custom-title',
        customTitle: 'Named session',
        sessionId: user.sessionId,
      },
      {
        type: 'agent-name',
        agentName: 'Named session',
        sessionId: user.sessionId,
      },
    ]
    const sessionId = '99999999-9999-4999-8999-999999999999'

    expect(
      createClaudeNativeFork({
        source,
        sourceSessionId: String(user.sessionId),
        sessionId,
      }),
    ).toEqual([
      { type: 'ai-title', aiTitle: 'Native fork', sessionId },
      { type: 'mode', mode: 'normal', sessionId },
      { type: 'permission-mode', permissionMode: 'default', sessionId },
      {
        type: 'pr-link',
        sessionId,
        prNumber: 42,
        prUrl: 'https://github.com/owner/repo/pull/42',
        prRepository: 'owner/repo',
        timestamp: '2026-08-08T00:00:00.000Z',
      },
      { ...user, sessionId },
      { ...assistant, sessionId },
      { type: 'custom-title', customTitle: 'Named session', sessionId },
      { type: 'agent-name', agentName: 'Named session', sessionId },
      { ...lastPrompt, sessionId },
    ])
  })

  it('copies exactly one effective agent-color before mode metadata', async () => {
    const [user, assistant, lastPrompt] = await fixture('basic-session.jsonl')
    if (!user || !assistant || !lastPrompt) throw new Error('fixture missing')
    const source = [
      { type: 'agent-color', agentColor: 'red', sessionId: user.sessionId },
      user,
      assistant,
      lastPrompt,
      { type: 'mode', mode: 'normal', sessionId: user.sessionId },
      {
        type: 'permission-mode',
        permissionMode: 'default',
        sessionId: user.sessionId,
      },
      { type: 'agent-color', agentColor: 'blue', sessionId: user.sessionId },
      { type: 'agent-color', agentColor: 'cyan', sessionId: user.sessionId },
    ]
    const sessionId = '99999999-9999-4999-8999-999999999999'

    expect(
      createClaudeNativeFork({
        source,
        sourceSessionId: String(user.sessionId),
        sessionId,
      }),
    ).toEqual([
      { type: 'agent-color', agentColor: 'cyan', sessionId },
      { type: 'mode', mode: 'normal', sessionId },
      { type: 'permission-mode', permissionMode: 'default', sessionId },
      { ...user, sessionId },
      { ...assistant, sessionId },
      { ...lastPrompt, sessionId },
    ])
  })

  it('preserves the default agent-color sentinel as the effective fork value', async () => {
    const [user, assistant, lastPrompt] = await fixture('basic-session.jsonl')
    if (!user || !assistant || !lastPrompt) throw new Error('fixture missing')
    const source = [
      { type: 'agent-color', agentColor: 'purple', sessionId: user.sessionId },
      user,
      assistant,
      lastPrompt,
      { type: 'mode', mode: 'normal', sessionId: user.sessionId },
      {
        type: 'permission-mode',
        permissionMode: 'default',
        sessionId: user.sessionId,
      },
      { type: 'agent-color', agentColor: 'default', sessionId: user.sessionId },
    ]
    const sessionId = '99999999-9999-4999-8999-999999999999'

    expect(
      createClaudeNativeFork({
        source,
        sourceSessionId: String(user.sessionId),
        sessionId,
      }),
    ).toEqual([
      { type: 'agent-color', agentColor: 'default', sessionId },
      { type: 'mode', mode: 'normal', sessionId },
      { type: 'permission-mode', permissionMode: 'default', sessionId },
      { ...user, sessionId },
      { ...assistant, sessionId },
      { ...lastPrompt, sessionId },
    ])
  })

  it('preserves ordinary Claude metadata without requiring a Praxis writer', async () => {
    const [user, assistant, lastPrompt] = await fixture('basic-session.jsonl')
    if (!user || !assistant || !lastPrompt) throw new Error('fixture missing')
    const sourceSessionId = String(user.sessionId)
    const sessionId = '99999999-9999-4999-8999-999999999999'
    const system = {
      type: 'system',
      subtype: 'turn_duration',
      parentUuid: assistant.uuid,
      isSidechain: false,
      uuid: '44444444-4444-4444-8444-444444444444',
      timestamp: '2026-08-04T00:00:02.000Z',
      userType: 'external',
      cwd: user.cwd,
      sessionId: sourceSessionId,
      version: '2.1.208',
      durationMs: 12,
      messageCount: 2,
    }
    const attachment = {
      type: 'attachment',
      parentUuid: system.uuid,
      isSidechain: false,
      uuid: '55555555-5555-4555-8555-555555555555',
      timestamp: '2026-08-04T00:00:03.000Z',
      userType: 'external',
      entrypoint: 'cli',
      cwd: user.cwd,
      sessionId: sourceSessionId,
      version: '2.1.208',
      gitBranch: null,
      attachment: {
        type: 'task_reminder',
        content: 'Continue the task.',
        itemCount: 1,
      },
    }
    const source = [
      { type: 'ai-title', aiTitle: 'Metadata', sessionId: sourceSessionId },
      { type: 'mode', mode: 'normal', sessionId: sourceSessionId },
      {
        type: 'permission-mode',
        permissionMode: 'default',
        sessionId: sourceSessionId,
      },
      { type: 'file-history-delta', messageId: 'ignored' },
      user,
      assistant,
      system,
      attachment,
      { ...lastPrompt, leafUuid: attachment.uuid },
    ]
    const fork = createClaudeNativeFork({
      source,
      sourceSessionId,
      sessionId,
    })
    const schema = selectClaudeSchemaAdapter('2.1.208')

    expect(fork.map((entry) => schema.serializeForFork(entry))).toHaveLength(8)
    expect(fork.map((entry) => entry.type)).toEqual([
      'ai-title',
      'mode',
      'permission-mode',
      'user',
      'assistant',
      'system',
      'attachment',
      'last-prompt',
    ])
  })

  it('fails closed for unknown/mismatched entries and excludes sidechains', async () => {
    const [user] = await fixture('basic-session.jsonl')
    if (!user) throw new Error('fixture missing')
    const sessionId = '99999999-9999-4999-8999-999999999999'

    expect(() =>
      createClaudeNativeFork({
        source: [user, { type: 'future', sessionId: user.sessionId }],
        sourceSessionId: String(user.sessionId),
        sessionId,
      }),
    ).toThrow('not forkable')
    expect(() =>
      createClaudeNativeFork({
        source: [user, { ...user, sessionId: 'another' }],
        sourceSessionId: String(user.sessionId),
        sessionId,
      }),
    ).toThrow('wrong sessionId')
    expect(() =>
      createClaudeNativeFork({
        source: [user, { type: 'queue-operation', operation: 'pop' }],
        sourceSessionId: String(user.sessionId),
        sessionId,
      }),
    ).toThrow('wrong sessionId')
    expect(() =>
      createClaudeNativeFork({
        source: [
          user,
          { type: 'queue-operation', sessionId: 'another', operation: 'pop' },
        ],
        sourceSessionId: String(user.sessionId),
        sessionId,
      }),
    ).toThrow('wrong sessionId')
    expect(
      createClaudeNativeFork({
        source: [
          user,
          {
            ...user,
            uuid: 'sidechain',
            isSidechain: true,
            sessionId: 'subagent-session',
          },
        ],
        sourceSessionId: String(user.sessionId),
        sessionId,
      }),
    ).toEqual([{ ...user, sessionId }])
    expect(() =>
      createClaudeNativeFork({
        source: [
          user,
          {
            type: 'future',
            isSidechain: true,
            sessionId: 'subagent-session',
          },
        ],
        sourceSessionId: String(user.sessionId),
        sessionId,
      }),
    ).toThrow('not forkable')
  })

  it('does not treat session naming metadata as native conversation history', () => {
    const sourceSessionId = '11111111-1111-4111-8111-111111111111'

    expect(() =>
      createClaudeNativeFork({
        source: [
          {
            type: 'custom-title',
            customTitle: 'Named session',
            sessionId: sourceSessionId,
          },
          {
            type: 'agent-name',
            agentName: 'Named session',
            sessionId: sourceSessionId,
          },
        ],
        sourceSessionId,
        sessionId: '99999999-9999-4999-8999-999999999999',
      }),
    ).toThrow('no native history')
  })

  it('validates graph and tool links independently of physical record order', async () => {
    const tool = await fixture('tool-session.jsonl')
    const [root] = await completeFixture(tool)
    const [assistant, result] = tool
    if (!root || !assistant || !result) throw new Error('tool fixture missing')
    const sessionId = '99999999-9999-4999-8999-999999999999'

    expect(
      createClaudeNativeFork({
        source: [result, assistant, root],
        sourceSessionId: String(assistant.sessionId),
        sessionId,
      }),
    ).toEqual([
      { ...result, sessionId },
      { ...assistant, sessionId },
      { ...root, sessionId },
    ])
  })

  it('keeps last-prompt only when it identifies the current graph tail', async () => {
    const [user, assistant, lastPrompt] = await fixture('basic-session.jsonl')
    if (!user || !assistant || !lastPrompt) throw new Error('fixture missing')
    const sourceSessionId = String(user.sessionId)
    const sessionId = '99999999-9999-4999-8999-999999999999'
    const laterAssistant = {
      ...assistant,
      uuid: '44444444-4444-4444-8444-444444444444',
      parentUuid: assistant.uuid,
    }

    expect(
      createClaudeNativeFork({
        source: [user, assistant, lastPrompt, laterAssistant],
        sourceSessionId,
        sessionId,
      }),
    ).toEqual([
      { ...user, sessionId },
      { ...assistant, sessionId },
      { ...laterAssistant, sessionId },
    ])
  })

  it('validates compact logical tails while ignoring hook audit attachments', async () => {
    const [user, assistant] = await fixture('basic-session.jsonl')
    const [boundary, summary] = await fixture('compact-session.jsonl')
    if (!user || !assistant || !boundary || !summary) {
      throw new Error('fixture missing')
    }
    const sourceSessionId = String(user.sessionId)
    const sessionId = '99999999-9999-4999-8999-999999999999'
    const hookAttachment = {
      type: 'attachment',
      parentUuid: assistant.uuid,
      isSidechain: false,
      uuid: '44444444-4444-4444-8444-444444444444',
      timestamp: '2026-08-04T00:00:02.000Z',
      userType: 'external',
      entrypoint: 'sdk-cli',
      cwd: user.cwd,
      sessionId: sourceSessionId,
      version: '2.1.208',
      gitBranch: null,
      attachment: {
        type: 'hook_success',
        hookName: 'PostToolUse:Bash',
        toolUseID: 'call_hook',
        hookEvent: 'PostToolUse',
        content: '',
        stdout: '',
        stderr: '',
        exitCode: 0,
        command: 'node hook.mjs',
        durationMs: 4,
      },
    }
    const boundaryUuid = '55555555-5555-4555-8555-555555555555'
    const summaryUuid = '66666666-6666-4666-8666-666666666666'
    const compactBoundary = {
      ...boundary,
      uuid: boundaryUuid,
      sessionId: sourceSessionId,
      logicalParentUuid: assistant.uuid,
      compactMetadata: {
        ...(boundary.compactMetadata as Record<string, unknown>),
        preservedSegment: {
          ...((boundary.compactMetadata as Record<string, unknown>)
            .preservedSegment as Record<string, unknown>),
          headUuid: assistant.uuid,
          tailUuid: assistant.uuid,
        },
      },
    }
    const compactSummary = {
      ...summary,
      uuid: summaryUuid,
      parentUuid: boundaryUuid,
      sessionId: sourceSessionId,
    }

    expect(
      createClaudeNativeFork({
        source: [
          user,
          assistant,
          hookAttachment,
          compactBoundary,
          compactSummary,
        ],
        sourceSessionId,
        sessionId,
      }),
    ).toEqual([
      { ...user, sessionId },
      { ...assistant, sessionId },
      { ...hookAttachment, sessionId },
      { ...compactBoundary, sessionId },
      { ...compactSummary, sessionId },
    ])
  })

  it('fails closed for broken native history links', async () => {
    const [user, assistant, lastPrompt] = await fixture('basic-session.jsonl')
    const tool = await fixture('tool-session.jsonl')
    const compact = await fixture('compact-session.jsonl')
    if (!user || !assistant || !lastPrompt) throw new Error('fixture missing')
    const sourceSessionId = String(user.sessionId)
    const sessionId = '99999999-9999-4999-8999-999999999999'
    const create = (source: ClaudeTranscriptEntry[]) =>
      createClaudeNativeFork({ source, sourceSessionId, sessionId })

    expect(() => create([user, { ...assistant, uuid: user.uuid }])).toThrow(
      'duplicate UUID',
    )
    expect(() =>
      create([
        { ...user, parentUuid: String(assistant.uuid) },
        { ...assistant, parentUuid: String(user.uuid) },
      ]),
    ).toThrow('cycle')
    expect(() =>
      create([user, { ...assistant, parentUuid: 'different-missing-parent' }]),
    ).toThrow('dangling parentUuid')
    expect(() =>
      create([{ ...user, parentUuid: 'single-missing-parent' }]),
    ).toThrow('dangling parentUuid')
    expect(
      create([{ ...lastPrompt, sessionId: user.sessionId }, user]),
    ).toEqual([{ ...user, sessionId }])

    const toolResult = tool.find((entry) => entry.type === 'user')
    if (!toolResult) throw new Error('tool fixture missing')
    expect(() =>
      create([{ ...toolResult, parentUuid: null, sessionId: user.sessionId }]),
    ).toThrow('unmatched tool_result')

    const boundary = compact.find(
      (entry) => entry.subtype === 'compact_boundary',
    )
    if (!boundary) throw new Error('compact fixture missing')
    const compactRoot = {
      ...user,
      uuid: boundary.logicalParentUuid,
      sessionId: user.sessionId,
    }
    expect(() =>
      create([compactRoot, { ...boundary, sessionId: user.sessionId }]),
    ).toThrow('no adjacent summary')

    const summary = compact.find((entry) => entry.isCompactSummary === true)
    if (!summary) throw new Error('compact fixture missing')
    const invalidLogicalParent = 'missing-logical-parent'
    const invalidBoundary = {
      ...boundary,
      sessionId: user.sessionId,
      logicalParentUuid: invalidLogicalParent,
      compactMetadata: {
        ...(boundary.compactMetadata as Record<string, unknown>),
        preservedSegment: {
          ...((boundary.compactMetadata as Record<string, unknown>)
            .preservedSegment as Record<string, unknown>),
          headUuid: invalidLogicalParent,
          tailUuid: invalidLogicalParent,
        },
      },
    }
    expect(() =>
      create([
        compactRoot,
        invalidBoundary,
        { ...summary, sessionId: user.sessionId },
      ]),
    ).toThrow('logical parent')
  })
})
