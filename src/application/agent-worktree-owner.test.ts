import { describe, expect, it } from 'vitest'

import {
  formatAgentWorktreeOwner,
  formatAgentWorktreeOwnerPrefix,
  parseAgentWorktreeOwner,
} from './agent-worktree-owner.js'

const identity = {
  sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  agentId: 'a0123456789abcdef',
  executionToken: 'token_01-abc',
} as const

describe('Agent worktree owner codec', () => {
  it('formats and parses the exact owner and prefix', () => {
    const owner = formatAgentWorktreeOwner(identity)
    expect(owner).toBe(
      'agent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:a0123456789abcdef:token_01-abc',
    )
    expect(parseAgentWorktreeOwner(owner)).toEqual(identity)
    expect(formatAgentWorktreeOwnerPrefix(identity)).toBe(
      'agent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:a0123456789abcdef:',
    )
  })

  it.each([
    'agent:not-a-session:a0123456789abcdef:token',
    'agent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:not-an-agent:token',
    'agent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:a0123456789abcdef:',
    'agent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:a0123456789abcdef:bad:extra',
    'agent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:a0123456789abcdef:bad token',
    'agent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:a0123456789abcdef:' +
      't'.repeat(129),
    'agent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:a0123456789abcdef',
  ])('rejects malformed owner ID %j', (owner) => {
    expect(parseAgentWorktreeOwner(owner)).toBeNull()
  })

  it('rejects malformed identities before formatting', () => {
    expect(() =>
      formatAgentWorktreeOwner({ ...identity, sessionId: 'bad' }),
    ).toThrow(/Invalid Agent worktree owner identity/u)
    expect(() =>
      formatAgentWorktreeOwnerPrefix({ ...identity, agentId: 'bad' }),
    ).toThrow(/Invalid Agent worktree owner identity/u)
    expect(() =>
      formatAgentWorktreeOwner({ ...identity, executionToken: 'bad token' }),
    ).toThrow(/Invalid Agent worktree owner identity/u)
  })
})
