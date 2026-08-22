import { describe, expect, it } from 'vitest'

import {
  createClaudeDurableMetadataSnapshot,
  createClaudeTagEntry,
  mergeClaudeDurableMetadataSnapshot,
  reduceClaudeSessionMetadata,
} from './session-metadata.js'

describe('Claude session metadata', () => {
  it('reduces each known type last-wins while custom title outranks AI title', () => {
    const sessionId = '11111111-1111-4111-8111-111111111111'
    const entries = [
      { type: 'ai-title', aiTitle: 'old ai', sessionId },
      { type: 'custom-title', customTitle: 'user title', sessionId },
      { type: 'ai-title', aiTitle: 'new ai', sessionId },
      { type: 'tag', tag: 'old', sessionId },
      { type: 'tag', tag: 'current', sessionId },
      { type: 'agent-name', agentName: 'reviewer', sessionId },
      { type: 'agent-color', agentColor: 'cyan', sessionId },
      { type: 'agent-setting', agentSetting: 'plan', sessionId },
      { type: 'permission-mode', permissionMode: 'default', sessionId },
      { type: 'mode', mode: 'normal', sessionId },
      {
        type: 'worktree-state',
        worktreeSession: { active: true, path: '/tmp/worktree' },
        sessionId,
      },
      {
        type: 'pr-link',
        prNumber: 42,
        prUrl: 'https://github.com/owner/repo/pull/42',
        prRepository: 'owner/repo',
        sessionId,
      },
      {
        type: 'last-prompt',
        lastPrompt: 'continue',
        leafUuid: '22222222-2222-4222-8222-222222222222',
        sessionId,
      },
      { type: 'future-metadata', title: 'must not win', sessionId },
    ]

    expect(reduceClaudeSessionMetadata(entries, sessionId)).toEqual({
      customTitle: 'user title',
      aiTitle: 'new ai',
      title: 'user title',
      titleSource: 'custom-title',
      tag: 'current',
      agentName: 'reviewer',
      agentColor: 'cyan',
      agentSetting: 'plan',
      permissionMode: 'default',
      mode: 'normal',
      worktreeSession: { active: true, path: '/tmp/worktree' },
      prLink: {
        prNumber: 42,
        prUrl: 'https://github.com/owner/repo/pull/42',
        prRepository: 'owner/repo',
      },
      lastPrompt: 'continue',
      lastPromptLeafUuid: '22222222-2222-4222-8222-222222222222',
    })
  })

  it('reappends one durable snapshot without allowing AI title after rename', () => {
    const sessionId = '11111111-1111-4111-8111-111111111111'
    const snapshot = createClaudeDurableMetadataSnapshot(
      [
        { type: 'custom-title', customTitle: 'first', sessionId },
        { type: 'custom-title', customTitle: 'renamed', sessionId },
        { type: 'ai-title', aiTitle: 'late ai', sessionId },
        { type: 'tag', tag: 'ready', sessionId, future: true },
        { type: 'unknown', value: 'preserved only in transcript', sessionId },
      ],
      sessionId,
    )

    expect(snapshot).toEqual([
      { type: 'custom-title', customTitle: 'renamed', sessionId },
      { type: 'tag', tag: 'ready', sessionId, future: true },
    ])
  })

  it('creates a validated native tag record', () => {
    expect(createClaudeTagEntry('session', 'release')).toEqual({
      type: 'tag',
      tag: 'release',
      sessionId: 'session',
    })
    expect(() => createClaudeTagEntry('session', '')).toThrow(
      'Session tag must not be empty',
    )
  })

  it('keeps the full baseline while bounded observations override visible types', () => {
    const sessionId = '11111111-1111-4111-8111-111111111111'
    expect(
      mergeClaudeDurableMetadataSnapshot(
        [
          { type: 'custom-title', customTitle: 'middle title', sessionId },
          { type: 'tag', tag: 'middle-tag', sessionId },
          { type: 'mode', mode: 'default', sessionId },
        ],
        [{ type: 'tag', tag: 'external-tail-tag', sessionId }],
        sessionId,
      ),
    ).toEqual([
      { type: 'custom-title', customTitle: 'middle title', sessionId },
      { type: 'tag', tag: 'external-tail-tag', sessionId },
      { type: 'mode', mode: 'default', sessionId },
    ])
  })

  it('does not promote an abandoned assistant over the last committed leaf', () => {
    const sessionId = '11111111-1111-4111-8111-111111111111'
    const entries = [
      {
        type: 'user',
        uuid: 'root',
        parentUuid: null,
        sessionId,
        message: { role: 'user', content: 'prompt' },
      },
      {
        type: 'assistant',
        uuid: 'abandoned',
        parentUuid: 'root',
        sessionId,
        message: { role: 'assistant', content: [] },
      },
      {
        type: 'user',
        uuid: 'branch',
        parentUuid: 'root',
        sessionId,
        message: { role: 'user', content: 'branch' },
      },
      {
        type: 'assistant',
        uuid: 'active',
        parentUuid: 'branch',
        sessionId,
        message: { role: 'assistant', content: [] },
      },
      {
        type: 'last-prompt',
        lastPrompt: 'prompt',
        leafUuid: 'active',
        sessionId,
      },
      {
        type: 'user',
        uuid: 'failed-branch',
        parentUuid: 'root',
        sessionId,
        message: { role: 'user', content: 'retry' },
      },
      {
        type: 'assistant',
        uuid: 'failed-assistant',
        parentUuid: 'failed-branch',
        sessionId,
        message: { role: 'assistant', content: [] },
      },
    ]

    expect(
      createClaudeDurableMetadataSnapshot(entries, sessionId).at(-1),
    ).toMatchObject({ type: 'last-prompt', leafUuid: 'active' })
  })

  it('advances the committed hint through a completed local command', () => {
    const sessionId = '11111111-1111-4111-8111-111111111111'
    const entries = [
      {
        type: 'assistant',
        uuid: 'answer',
        parentUuid: null,
        sessionId,
        message: { role: 'assistant', content: [] },
      },
      {
        type: 'last-prompt',
        lastPrompt: 'prompt',
        leafUuid: 'answer',
        sessionId,
      },
      {
        type: 'system',
        subtype: 'local_command',
        uuid: 'command',
        parentUuid: 'answer',
        content: '<command-name>/cost</command-name>',
        sessionId,
      },
      {
        type: 'system',
        subtype: 'local_command',
        uuid: 'stdout',
        parentUuid: 'command',
        content: '<local-command-stdout>ok</local-command-stdout>',
        sessionId,
      },
    ]

    expect(
      createClaudeDurableMetadataSnapshot(entries, sessionId).at(-1),
    ).toEqual({
      type: 'last-prompt',
      leafUuid: 'stdout',
      sessionId,
    })
  })

  it('advances through a bounded local command chain when the committed leaf is outside the window', () => {
    const sessionId = '11111111-1111-4111-8111-111111111111'
    const baseline = [
      {
        type: 'last-prompt',
        lastPrompt: 'large prompt',
        leafUuid: 'large-answer',
        sessionId,
      },
    ]
    const observed = [
      {
        type: 'system',
        subtype: 'local_command',
        uuid: 'command',
        parentUuid: 'large-answer',
        content: '<command-name>/cd</command-name>',
        sessionId,
      },
      {
        type: 'system',
        subtype: 'local_command',
        uuid: 'stdout',
        parentUuid: 'command',
        content: '<local-command-stdout>moved</local-command-stdout>',
        sessionId,
      },
    ]

    expect(
      mergeClaudeDurableMetadataSnapshot(baseline, observed, sessionId).at(-1),
    ).toEqual({
      type: 'last-prompt',
      leafUuid: 'stdout',
      sessionId,
    })
  })

  it.each([
    {
      name: 'failed model branch',
      prefix: [
        {
          type: 'user',
          uuid: 'failed-user',
          parentUuid: 'large-answer',
          message: { role: 'user', content: 'retry' },
        },
        {
          type: 'assistant',
          uuid: 'failed-assistant',
          parentUuid: 'failed-user',
          message: { role: 'assistant', content: [] },
        },
      ],
      commandParentUuid: 'failed-assistant',
    },
    {
      name: 'unrelated branch',
      prefix: [],
      commandParentUuid: 'other-answer',
    },
  ])(
    'does not promote a local command on an $name',
    ({ prefix, commandParentUuid }) => {
      const sessionId = '11111111-1111-4111-8111-111111111111'
      const baseline = [
        {
          type: 'last-prompt',
          lastPrompt: 'large prompt',
          leafUuid: 'large-answer',
          sessionId,
        },
      ]
      const observed = [
        ...prefix.map((entry) => ({ ...entry, sessionId })),
        {
          type: 'system',
          subtype: 'local_command',
          uuid: 'command',
          parentUuid: commandParentUuid,
          content: '<command-name>/cd</command-name>',
          sessionId,
        },
        {
          type: 'system',
          subtype: 'local_command',
          uuid: 'stdout',
          parentUuid: 'command',
          content: '<local-command-stdout>moved</local-command-stdout>',
          sessionId,
        },
      ]

      expect(
        mergeClaudeDurableMetadataSnapshot(baseline, observed, sessionId).at(
          -1,
        ),
      ).toEqual(baseline[0])
    },
  )
})
