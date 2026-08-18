import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileAtomically } from '../platform/atomic-write.js'
import { ExclusiveFileLease } from '../platform/exclusive-file-lease.js'

const SIDECAR_VERSION = 1

export interface UnknownCostSidecarOptions {
  sidecarPath: string
  lockFile?: string
}

interface UnknownCostSidecarRecord {
  readonly hasUnknownModelCost: boolean
}

interface UnknownCostSidecarDocument {
  readonly version: 1
  readonly sessions: Readonly<Record<string, UnknownCostSidecarRecord>>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertNonBlank(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must not be blank`)
  }
}

function emptyDocument(): UnknownCostSidecarDocument {
  return { version: SIDECAR_VERSION, sessions: {} }
}

/**
 * Praxis-private sidecar for the `/cost` unknown-model flag. The native
 * `.claude.json` project record must stay Claude-compatible, so this flag lives
 * in a disposable JSON document keyed by session ID. Reads fail closed to
 * `false` when the sidecar is missing or malformed.
 */
export class UnknownCostSidecar {
  private readonly sidecarPath: string
  private readonly lockFile: string
  private readonly lease: ExclusiveFileLease

  constructor(options: UnknownCostSidecarOptions) {
    assertNonBlank(options.sidecarPath, 'sidecarPath')
    this.sidecarPath = options.sidecarPath
    this.lockFile =
      options.lockFile ??
      join(dirname(options.sidecarPath), 'locks', 'unknown-cost-sidecar.lock')
    this.lease = new ExclusiveFileLease(this.lockFile)
  }

  async readFlag(sessionId: string): Promise<boolean> {
    assertNonBlank(sessionId, 'sessionId')
    const document = await this.readDocument()
    if (document === null) return false
    return document.sessions[sessionId]?.hasUnknownModelCost === true
  }

  async writeFlag(sessionId: string, flag: boolean): Promise<void> {
    assertNonBlank(sessionId, 'sessionId')
    if (typeof flag !== 'boolean') {
      throw new TypeError('flag must be a boolean')
    }
    const handle = await this.acquireLease()
    try {
      const document = (await this.readDocument()) ?? emptyDocument()
      const sessions: Record<string, UnknownCostSidecarRecord> = {
        ...document.sessions,
        [sessionId]: { hasUnknownModelCost: flag },
      }
      const content = `${JSON.stringify({ version: SIDECAR_VERSION, sessions }, null, 2)}\n`
      await writeFileAtomically(this.sidecarPath, content, { mode: 0o600 })
    } finally {
      await handle.release()
    }
  }

  private async readDocument(): Promise<UnknownCostSidecarDocument | null> {
    const content = await this.readContent()
    if (content === null) return null
    return this.parseDocument(content)
  }

  private async readContent(): Promise<string | null> {
    let handle: Awaited<ReturnType<typeof open>>
    try {
      handle = await open(
        this.sidecarPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      )
    } catch {
      return null
    }
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) return null
      return await handle.readFile('utf8')
    } catch {
      return null
    } finally {
      await handle.close().catch(() => undefined)
    }
  }

  private parseDocument(content: string): UnknownCostSidecarDocument | null {
    let root: unknown
    try {
      root = JSON.parse(content)
    } catch {
      return null
    }
    if (!isObject(root) || root.version !== SIDECAR_VERSION) return null
    const rawSessions = root.sessions
    if (!isObject(rawSessions)) return null
    const sessions: Record<string, UnknownCostSidecarRecord> = {}
    for (const [sessionId, value] of Object.entries(rawSessions)) {
      if (sessionId.trim() === '') return null
      if (!isObject(value)) return null
      if (typeof value.hasUnknownModelCost !== 'boolean') return null
      sessions[sessionId] = { hasUnknownModelCost: value.hasUnknownModelCost }
    }
    return { version: SIDECAR_VERSION, sessions }
  }

  private async acquireLease(): Promise<{ release(): Promise<void> }> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const handle = await this.lease.tryAcquire()
      if (handle) return handle
      await sleep(5)
    }
    throw new Error(
      `Timed out acquiring unknown-cost sidecar lock for ${this.sidecarPath}`,
    )
  }
}
