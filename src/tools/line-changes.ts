import { structuredPatch } from 'diff'

export interface LineChanges {
  linesAdded: number
  linesRemoved: number
}

const AMPERSAND_SENTINEL = '<<:AMPERSAND_TOKEN:>>'
const DOLLAR_SENTINEL = '<<:DOLLAR_TOKEN:>>'

export function countLineChanges(
  before: string,
  after: string,
  options?: { newFile?: boolean },
): LineChanges {
  if (before === after) {
    return { linesAdded: 0, linesRemoved: 0 }
  }
  if (options?.newFile === true) {
    if (after.length === 0) {
      return { linesAdded: 0, linesRemoved: 0 }
    }
    return { linesAdded: after.split(/\r?\n/u).length, linesRemoved: 0 }
  }

  const patch = structuredPatch(
    '',
    '',
    substituteSentinels(before),
    substituteSentinels(after),
    '',
    '',
    { context: 3, timeout: 5000 },
  )
  if (!patch) {
    return { linesAdded: 0, linesRemoved: 0 }
  }

  let linesAdded = 0
  let linesRemoved = 0
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) linesAdded += 1
      if (line.startsWith('-')) linesRemoved += 1
    }
  }
  return { linesAdded, linesRemoved }
}

function substituteSentinels(content: string): string {
  return content
    .replaceAll('&', AMPERSAND_SENTINEL)
    .replaceAll('$', DOLLAR_SENTINEL)
}
