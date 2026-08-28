import { describe, expect, it } from 'vitest'

import { projectAnsiQuietFrame } from './ansi-surface.js'
import type { QuietFrame } from './quiet-frame.js'

describe('projectAnsiQuietFrame', () => {
  it('preserves a QuietFrame exactly without inventing legacy chrome', () => {
    const quiet: QuietFrame = {
      columns: 72,
      rows: 5,
      density: 'compact',
      lines: [
        {
          key: 'quiet:choice:heading',
          segments: [
            { text: 'Permission', role: 'heading' },
            { text: ' · Bash', role: 'muted' },
          ],
          height: 1,
          region: 'focus',
          accessibleText: 'Permission request for Bash',
        },
        {
          key: 'quiet:choice:allow',
          segments: [{ text: '❯ Allow once', role: 'selection' }],
          height: 1,
          region: 'focus',
        },
      ],
      cursor: { rowKey: 'quiet:choice:allow', column: 2 },
    }
    const projected = projectAnsiQuietFrame(quiet)
    expect(projected).toEqual({
      columns: 72,
      rows: 5,
      lines: quiet.lines,
      cursor: quiet.cursor,
    })
    expect(projected.lines).toBe(quiet.lines)
    expect(projected.cursor).toBe(quiet.cursor)
    expect(projected.lines.map((line) => line.key)).not.toContain('composer')
    expect(projected.lines.map((line) => line.key)).not.toContain('status')
    expect(projected.lines.map((line) => line.key)).not.toContain(
      'ansi:header:identity',
    )
  })
})
