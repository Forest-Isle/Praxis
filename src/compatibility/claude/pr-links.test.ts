import { describe, expect, it } from 'vitest'

import {
  createClaudePrSessionFilter,
  filterClaudePrLinkedSessions,
  getClaudePrLink,
  matchesClaudePrReference,
  parseClaudePrReference,
} from './pr-links.js'

describe('Claude PR links', () => {
  it('parses numbers, GitHub URLs, and repository shorthand', () => {
    expect(parseClaudePrReference('123')).toEqual({ prNumber: 123 })
    expect(parseClaudePrReference('#123')).toEqual({ prNumber: 123 })
    expect(
      parseClaudePrReference('https://github.com/Owner/Repo/pull/123/files'),
    ).toEqual({ prNumber: 123, prRepository: 'Owner/Repo' })
    expect(parseClaudePrReference('owner/repo#123')).toEqual({
      prNumber: 123,
      prRepository: 'owner/repo',
    })
    expect(() => parseClaudePrReference('not-a-pr')).toThrow(
      'Invalid PR reference',
    )
  })

  it('uses last valid native pr-link metadata', () => {
    expect(
      getClaudePrLink(
        [
          {
            type: 'pr-link',
            sessionId: 'session',
            prNumber: 1,
            prUrl: 'https://github.com/owner/repo/pull/1',
            prRepository: 'owner/repo',
            timestamp: '2026-08-08T00:00:00.000Z',
          },
          { type: 'pr-link', sessionId: 'session', prNumber: 2 },
          {
            type: 'pr-link',
            sessionId: 'session',
            prNumber: 3,
            prUrl: 'https://github.com/owner/repo/pull/3',
            prRepository: 'owner/repo',
            timestamp: '2026-08-08T00:00:01.000Z',
          },
        ],
        'session',
      ),
    ).toEqual({
      prNumber: 3,
      prUrl: 'https://github.com/owner/repo/pull/3',
      prRepository: 'owner/repo',
      timestamp: '2026-08-08T00:00:01.000Z',
    })
    expect(
      getClaudePrLink(
        [
          {
            type: 'pr-link',
            sessionId: 'other-session',
            prNumber: 4,
            prUrl: 'https://github.com/owner/repo/pull/4',
            prRepository: 'owner/repo',
            timestamp: '2026-08-08T00:00:02.000Z',
          },
        ],
        'session',
      ),
    ).toBeNull()
  })

  it('filters linked sessions by number and case-insensitive repository', () => {
    const sessions = [
      { id: 'a', prNumber: 12, prRepository: 'Owner/Repo' },
      { id: 'b', prNumber: 12, prRepository: 'other/repo' },
      { id: 'c' },
    ]
    expect(filterClaudePrLinkedSessions(sessions, true)).toEqual(
      sessions.slice(0, 2),
    )
    expect(filterClaudePrLinkedSessions(sessions, '12')).toEqual(
      sessions.slice(0, 2),
    )
    expect(filterClaudePrLinkedSessions(sessions, 'owner/repo#12')).toEqual([
      sessions[0],
    ])
    expect(
      sessions.filter(createClaudePrSessionFilter('other/repo#12')),
    ).toEqual([sessions[1]])
    expect(() => createClaudePrSessionFilter('not-a-pr')).toThrow(
      'Invalid PR reference',
    )
    expect(
      matchesClaudePrReference(
        { prNumber: 12, prRepository: 'Owner/Repo' },
        { prNumber: 12, prRepository: 'owner/repo' },
      ),
    ).toBe(true)
  })
})
