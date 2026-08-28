import {
  workspaceTrustDecisionKey,
  type WorkspaceTrustInventory,
} from '../security/workspace-trust.js'

export interface WorkspaceTrustPromptIO {
  input?: AsyncIterable<string>
  output?: (text: string) => void
  signal?: AbortSignal
}

export function createWorkspaceTrustDecisionCache(
  decide: (inventory: WorkspaceTrustInventory) => boolean | Promise<boolean>,
): (inventory: WorkspaceTrustInventory) => Promise<boolean> {
  const decisions = new Map<string, boolean>()
  return async (inventory) => {
    const key = workspaceTrustDecisionKey(inventory)
    const cached = decisions.get(key)
    if (cached !== undefined) return cached
    const decision = await decide(inventory)
    decisions.set(key, decision)
    return decision
  }
}

export function safeWorkspaceTrustDisplayField(value: string): string {
  return [...value]
    .map((character) => {
      return /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(character) ? '?' : character
    })
    .join('')
    .slice(0, 512)
}

export async function promptWorkspaceTrust(
  inventory: WorkspaceTrustInventory,
  io: WorkspaceTrustPromptIO = {},
): Promise<boolean> {
  const output = io.output ?? ((text: string) => process.stderr.write(text))
  if (io.signal?.aborted) return false
  output(
    `Workspace executable resources found for ${safeWorkspaceTrustDisplayField(inventory.canonicalPath)}\n`,
  )
  for (const origin of inventory.origins)
    output(
      `  ${origin.kind} (${origin.scope}) ${safeWorkspaceTrustDisplayField(origin.path)}: ${safeWorkspaceTrustDisplayField(origin.label)}\n`,
    )
  output('Trust these workspace executables? [y/N] ')
  const input = io.input ?? (process.stdin as unknown as AsyncIterable<string>)
  const iterator = input[Symbol.asyncIterator]()
  const abortedResult = Symbol('workspace-trust-prompt-aborted')
  let abort: (() => void) | undefined
  try {
    const aborted = new Promise<typeof abortedResult>((resolve) => {
      abort = () => resolve(abortedResult)
      io.signal?.addEventListener('abort', abort, { once: true })
      if (io.signal?.aborted) abort()
    })
    const result = await Promise.race([iterator.next(), aborted])
    if (result === abortedResult) return false
    if (result.done) return false
    return /^(?:y|yes)$/iu.test(String(result.value).trim())
  } finally {
    if (abort) io.signal?.removeEventListener('abort', abort)
  }
}
