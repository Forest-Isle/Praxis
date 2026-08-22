import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type ClaudeEnvironmentHookEvent =
  'Setup' | 'SessionStart' | 'CwdChanged' | 'FileChanged'

const ENV_FILE = /^(setup|sessionstart|cwdchanged|filechanged)-hook-(\d+)\.sh$/u
const PRIORITY: Readonly<Record<string, number>> = {
  setup: 0,
  sessionstart: 1,
  cwdchanged: 2,
  filechanged: 3,
}

export interface ClaudeSessionEnvironmentOptions {
  stateRoot: string
  warn?(message: string): void
}

export class ClaudeSessionEnvironment {
  private readonly cache = new Map<
    string,
    Readonly<Record<string, string>> | null
  >()

  constructor(private readonly options: ClaudeSessionEnvironmentOptions) {}

  async hookFile(
    sessionId: string,
    event: ClaudeEnvironmentHookEvent,
    hookIndex: number,
  ): Promise<string | undefined> {
    if (process.platform === 'win32') return undefined
    const directory = this.directory(sessionId)
    await mkdir(directory, { recursive: true })
    this.invalidate(sessionId)
    return join(directory, `${event.toLowerCase()}-hook-${hookIndex}.sh`)
  }

  invalidate(sessionId: string): void {
    this.cache.delete(sessionId)
  }

  async clearCwdFiles(sessionId: string): Promise<void> {
    const directory = this.directory(sessionId)
    try {
      const files = await readdir(directory)
      await Promise.all(
        files
          .filter(
            (file) =>
              ENV_FILE.test(file) &&
              (file.startsWith('cwdchanged-') ||
                file.startsWith('filechanged-')),
          )
          .map((file) => writeFile(join(directory, file), '')),
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.options.warn?.(
          `Could not clear hook environment: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }
    this.invalidate(sessionId)
  }

  async environment(
    sessionId: string,
  ): Promise<Readonly<Record<string, string>> | undefined> {
    if (process.platform === 'win32') return undefined
    const cached = this.cache.get(sessionId)
    if (cached !== undefined) return cached ?? undefined
    const directory = this.directory(sessionId)
    const environment: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >
    try {
      const files = (await readdir(directory))
        .filter((file) => ENV_FILE.test(file))
        .sort((left, right) => {
          const leftMatch = left.match(ENV_FILE)
          const rightMatch = right.match(ENV_FILE)
          const priority =
            (PRIORITY[leftMatch?.[1] ?? ''] ?? 99) -
            (PRIORITY[rightMatch?.[1] ?? ''] ?? 99)
          if (priority !== 0) return priority
          return Number(leftMatch?.[2] ?? 0) - Number(rightMatch?.[2] ?? 0)
        })
      for (const file of files) {
        const path = join(directory, file)
        const content = await readFile(path, 'utf8')
        for (const [index, line] of content.split(/\r?\n/u).entries()) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith('#')) continue
          const match = trimmed.match(
            /^export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u,
          )
          const name = match?.[1]
          const source = match?.[2]
          const value =
            source === undefined ? undefined : literalExportValue(source)
          if (!name || value === undefined) {
            this.options.warn?.(
              `Ignored unsafe CLAUDE_ENV_FILE entry at ${path}:${index + 1}`,
            )
            continue
          }
          environment[name] = value
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.options.warn?.(
          `Could not load hook environment: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }
    const result =
      Object.keys(environment).length > 0 ? { ...environment } : null
    this.cache.set(sessionId, result)
    return result ?? undefined
  }

  private directory(sessionId: string): string {
    return join(this.options.stateRoot, 'session-env', sessionId)
  }
}

function literalExportValue(source: string): string | undefined {
  const value = source.trim()
  if (value === '') return ''
  if (value.startsWith("'") && value.endsWith("'")) {
    const literal = value.slice(1, -1)
    return literal.includes("'") ? undefined : literal
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    const literal = value.slice(1, -1)
    if (literal.includes('$') || literal.includes('`')) return undefined
    return literal.replace(/\\(["\\])/gu, '$1')
  }
  return /^[A-Za-z0-9_./:@%+,=-]*$/u.test(value) ? value : undefined
}
