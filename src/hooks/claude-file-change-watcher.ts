import { existsSync, watch } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'

export type ClaudeFileChangeEvent = 'add' | 'change' | 'unlink'

interface DirectoryWatcher {
  close(): void
  on(event: 'error', listener: (error: Error) => void): DirectoryWatcher
  unref?(): void
}

type WatchDirectory = (
  directory: string,
  listener: (filename: string | null) => void,
) => DirectoryWatcher

export interface ClaudeFileChangeWatcherOptions {
  cwd: string
  staticPaths: readonly string[]
  onFileChanged(
    filePath: string,
    event: ClaudeFileChangeEvent,
    signal: AbortSignal,
  ): Promise<readonly string[] | undefined>
  warn(message: string): void
  debounceMs?: number
  pathExists?(path: string): boolean
  watchDirectory?: WatchDirectory
}

function defaultWatchDirectory(
  directory: string,
  listener: (filename: string | null) => void,
): DirectoryWatcher {
  return watch(directory, (_event, filename) => {
    listener(filename)
  })
}

export class ClaudeFileChangeWatcher {
  private cwd: string
  private staticPaths: readonly string[]
  private dynamicPaths: readonly string[] = []
  private readonly watchers = new Map<string, DirectoryWatcher>()
  private readonly knownExistence = new Map<string, boolean>()
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly inFlight = new Map<Promise<void>, AbortController>()
  private readonly debounceMs: number
  private readonly pathExists: (path: string) => boolean
  private readonly watchDirectory: WatchDirectory
  private generation = 0
  private closed = false

  constructor(private readonly options: ClaudeFileChangeWatcherOptions) {
    this.cwd = options.cwd
    this.staticPaths = options.staticPaths
    this.debounceMs = options.debounceMs ?? 500
    this.pathExists = options.pathExists ?? existsSync
    this.watchDirectory = options.watchDirectory ?? defaultWatchDirectory
    this.rebuild()
  }

  updateForCwd(
    cwd: string,
    staticPaths: readonly string[],
    dynamicPaths: readonly string[],
  ): void {
    if (this.closed) return
    this.cwd = cwd
    this.staticPaths = staticPaths
    this.dynamicPaths = this.validDynamicPaths(dynamicPaths)
    this.rebuild()
  }

  updateDynamicPaths(paths: readonly string[]): void {
    if (this.closed) return
    const next = this.validDynamicPaths(paths)
    if (
      next.length === this.dynamicPaths.length &&
      next.every((path, index) => path === this.dynamicPaths[index])
    ) {
      return
    }
    this.dynamicPaths = next
    this.rebuild()
  }

  async close(timeoutMs = 5_000): Promise<void> {
    if (this.closed) return
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new Error('FileChanged watcher close timeout must be non-negative')
    }
    this.closed = true
    this.generation += 1
    this.clearResources()
    const pending = [...this.inFlight.keys()]
    if (pending.length === 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (
        (await Promise.race([
          Promise.allSettled(pending).then(() => 'settled' as const),
          new Promise<'timeout'>((resolveTimeout) => {
            timer = setTimeout(() => resolveTimeout('timeout'), timeoutMs)
          }),
        ])) === 'timeout'
      ) {
        for (const controller of this.inFlight.values()) controller.abort()
        this.inFlight.clear()
        await Promise.resolve()
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private validDynamicPaths(paths: readonly string[]): readonly string[] {
    const valid: string[] = []
    for (const path of paths) {
      if (!isAbsolute(path)) {
        this.options.warn(
          `FileChanged hook ignored non-absolute watch path: ${path}`,
        )
        continue
      }
      valid.push(resolve(path))
    }
    return [...new Set(valid)]
  }

  private targetPaths(): readonly string[] {
    return [
      ...new Set([
        ...this.staticPaths.map((path) =>
          isAbsolute(path) ? resolve(path) : resolve(this.cwd, path),
        ),
        ...this.dynamicPaths,
      ]),
    ]
  }

  private rebuild(): void {
    this.generation += 1
    this.clearResources()
    const targets = this.targetPaths()
    const byDirectory = new Map<string, Set<string>>()
    for (const target of targets) {
      this.knownExistence.set(target, this.pathExists(target))
      const directory = dirname(target)
      const names = byDirectory.get(directory) ?? new Set<string>()
      names.add(basename(target))
      byDirectory.set(directory, names)
    }
    for (const [directory, names] of byDirectory) {
      try {
        const watcher = this.watchDirectory(directory, (filename) => {
          if (filename === null) {
            for (const name of names) this.schedule(resolve(directory, name))
            return
          }
          if (names.has(filename)) this.schedule(resolve(directory, filename))
        })
        watcher.on('error', (error) => {
          this.options.warn(
            `FileChanged watcher failed for ${directory}: ${error.message}`,
          )
        })
        watcher.unref?.()
        this.watchers.set(directory, watcher)
      } catch (error) {
        this.options.warn(
          `FileChanged watcher could not watch ${directory}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }
  }

  private schedule(path: string): void {
    const previous = this.pending.get(path)
    if (previous) clearTimeout(previous)
    const generation = this.generation
    const timer = setTimeout(() => {
      this.pending.delete(path)
      if (this.closed || generation !== this.generation) return
      const controller = new AbortController()
      const dispatch = this.dispatch(path, generation, controller.signal)
      this.inFlight.set(dispatch, controller)
      void dispatch.finally(() => this.inFlight.delete(dispatch))
    }, this.debounceMs)
    timer.unref?.()
    this.pending.set(path, timer)
  }

  private async dispatch(
    path: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    const existed = this.knownExistence.get(path) ?? false
    const exists = this.pathExists(path)
    this.knownExistence.set(path, exists)
    if (!existed && !exists) return
    const event: ClaudeFileChangeEvent = !existed
      ? 'add'
      : !exists
        ? 'unlink'
        : 'change'
    try {
      const watchPaths = await this.options.onFileChanged(path, event, signal)
      if (
        !this.closed &&
        generation === this.generation &&
        watchPaths &&
        watchPaths.length > 0
      ) {
        this.updateDynamicPaths(watchPaths)
      }
    } catch (error) {
      this.options.warn(
        `FileChanged hook failed for ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  private clearResources(): void {
    for (const timer of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
    this.knownExistence.clear()
  }
}
