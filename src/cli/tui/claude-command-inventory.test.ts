import { describe, expect, it } from 'vitest'

import {
  CLAUDE_2_1_208_COMMAND_BY_NAME,
  CLAUDE_2_1_208_COMMAND_INVENTORY,
} from './claude-command-inventory.js'

describe('Claude Code 2.1.208 external command inventory', () => {
  it('classifies every unique source-registry command exactly once', () => {
    expect(CLAUDE_2_1_208_COMMAND_INVENTORY).toHaveLength(83)
    expect(CLAUDE_2_1_208_COMMAND_BY_NAME.size).toBe(
      CLAUDE_2_1_208_COMMAND_INVENTORY.length,
    )
    for (const entry of CLAUDE_2_1_208_COMMAND_INVENTORY) {
      if (entry.disposition !== 'included') {
        expect(
          entry.reason,
          `/${entry.name} ${entry.disposition} classification requires evidence`,
        ).toBeTruthy()
      }
    }
  })

  it('keeps developer-core closure on exactly the required commands', () => {
    expect(
      CLAUDE_2_1_208_COMMAND_INVENTORY.filter(
        (entry) => entry.disposition === 'required',
      ).map((entry) => entry.name),
    ).toEqual(['doctor'])

    expect(CLAUDE_2_1_208_COMMAND_BY_NAME.get('cost')).toMatchObject({
      disposition: 'included',
      visibility: 'conditional',
    })
    expect(CLAUDE_2_1_208_COMMAND_BY_NAME.get('doctor')).toMatchObject({
      disposition: 'required',
      visibility: 'conditional',
    })
  })

  it('keeps only the specified optional commands deferred and non-blocking', () => {
    expect(
      CLAUDE_2_1_208_COMMAND_INVENTORY.filter(
        (entry) => entry.disposition === 'deferred',
      ).map((entry) => entry.name),
    ).toEqual(['advisor', 'fast', 'stats', 'insights', 'voice'])
  })

  it('excludes the specified subscription-bound, campaign, maintainer, and experimental commands', () => {
    const excludedByDecision = [
      'chrome',
      'heapdump',
      'think-back',
      'thinkback-play',
      'buddy',
      'proactive',
      'brief',
      'assistant',
      'torch',
    ]
    for (const name of excludedByDecision) {
      expect(
        CLAUDE_2_1_208_COMMAND_BY_NAME.get(name),
        `/${name} should be excluded`,
      ).toMatchObject({ disposition: 'excluded' })
    }
  })

  it('keeps representative hidden and conditional commands included', () => {
    expect(CLAUDE_2_1_208_COMMAND_BY_NAME.get('output-style')).toMatchObject({
      disposition: 'included',
      visibility: 'hidden',
    })
    expect(CLAUDE_2_1_208_COMMAND_BY_NAME.get('workflows')).toMatchObject({
      disposition: 'included',
      visibility: 'conditional',
    })
    expect(CLAUDE_2_1_208_COMMAND_BY_NAME.get('desktop')).toMatchObject({
      disposition: 'excluded',
      visibility: 'visible',
    })
  })
})
