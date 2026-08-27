import type { NativeTranscriptEntry } from './schema.js'

export interface ClaudePrLink {
  prNumber: number
  prUrl: string
  prRepository: string
  timestamp: string
}

export interface ClaudePrReference {
  prNumber: number
  prRepository?: string
}

function parsePrNumber(value: string): number | null {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

export function parseClaudePrReference(value: string): ClaudePrReference {
  const source = value.trim()
  const direct = /^#?([1-9]\d*)$/u.exec(source)
  const directNumber = direct?.[1] ? parsePrNumber(direct[1]) : null
  if (directNumber !== null) {
    return { prNumber: directNumber }
  }

  const url =
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/([1-9]\d*)(?:[/?#].*)?$/iu.exec(
      source,
    )
  const urlNumber = url?.[3] ? parsePrNumber(url[3]) : null
  if (url?.[1] && url[2] && urlNumber !== null) {
    return {
      prNumber: urlNumber,
      prRepository: `${url[1]}/${url[2]}`,
    }
  }

  const shorthand = /^([^/\s#]+)\/([^/\s#]+)#([1-9]\d*)$/u.exec(source)
  const shorthandNumber = shorthand?.[3] ? parsePrNumber(shorthand[3]) : null
  if (shorthand?.[1] && shorthand[2] && shorthandNumber !== null) {
    return {
      prNumber: shorthandNumber,
      prRepository: `${shorthand[1]}/${shorthand[2]}`,
    }
  }

  throw new Error(
    `Invalid PR reference ${value}; expected a PR number, GitHub pull URL, or owner/repo#number`,
  )
}

export function getClaudePrLink(
  entries: readonly NativeTranscriptEntry[],
  sessionId: string,
): ClaudePrLink | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry?.type !== 'pr-link' || entry.sessionId !== sessionId) continue
    if (
      typeof entry.prNumber !== 'number' ||
      !Number.isSafeInteger(entry.prNumber) ||
      entry.prNumber < 1 ||
      typeof entry.prUrl !== 'string' ||
      entry.prUrl.length === 0 ||
      typeof entry.prRepository !== 'string' ||
      entry.prRepository.length === 0 ||
      typeof entry.timestamp !== 'string' ||
      entry.timestamp.length === 0
    ) {
      continue
    }
    return {
      prNumber: entry.prNumber,
      prUrl: entry.prUrl,
      prRepository: entry.prRepository,
      timestamp: entry.timestamp,
    }
  }
  return null
}

export function matchesClaudePrReference(
  link: Pick<ClaudePrLink, 'prNumber'> & { prRepository?: string },
  reference: ClaudePrReference,
): boolean {
  return (
    link.prNumber === reference.prNumber &&
    (reference.prRepository === undefined ||
      (typeof link.prRepository === 'string' &&
        link.prRepository.toLowerCase() ===
          reference.prRepository.toLowerCase()))
  )
}

export function createClaudePrSessionFilter<
  T extends { prNumber?: number; prRepository?: string },
>(selector: string | true): (session: T) => boolean {
  if (selector === true) {
    return (session) =>
      typeof session.prNumber === 'number' &&
      Number.isSafeInteger(session.prNumber) &&
      session.prNumber > 0
  }
  const reference = parseClaudePrReference(selector)
  return (session) =>
    typeof session.prNumber === 'number' &&
    matchesClaudePrReference(
      {
        prNumber: session.prNumber,
        ...(session.prRepository === undefined
          ? {}
          : { prRepository: session.prRepository }),
      },
      reference,
    )
}

export function filterClaudePrLinkedSessions<
  T extends { prNumber?: number; prRepository?: string },
>(sessions: readonly T[], selector: string | true): T[] {
  return sessions.filter(createClaudePrSessionFilter<T>(selector))
}
