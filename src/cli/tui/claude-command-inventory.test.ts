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

  it('keeps deferred single-user commands as explicit completion blockers', () => {
    expect(CLAUDE_2_1_208_COMMAND_BY_NAME.get('output-style')).toMatchObject({
      disposition: 'included',
      visibility: 'hidden',
    })
    expect(CLAUDE_2_1_208_COMMAND_BY_NAME.get('heapdump')).toMatchObject({
      disposition: 'deferred',
      visibility: 'hidden',
    })
    expect(CLAUDE_2_1_208_COMMAND_BY_NAME.get('chrome')).toMatchObject({
      disposition: 'deferred',
      visibility: 'conditional',
    })
    expect(CLAUDE_2_1_208_COMMAND_BY_NAME.get('workflows')).toMatchObject({
      disposition: 'included',
      visibility: 'conditional',
    })
  })
})
