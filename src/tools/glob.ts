import { isAbsolute, join, resolve, sep } from 'node:path'
import { minimatch } from 'minimatch'
import {
  BoundedProcessRunner,
  joinedProcessOutput,
  type ProcessResult,
} from '../platform/bounded-process-runner.js'

const MAX_RESULTS = 100
const MAX_ENUMERATION_BYTES = 2 * 1024 * 1024
export interface GlobSearchRequest {
  root: string
  displayRoot: string
  absoluteRoot: string
  pattern: string
  signal?: AbortSignal
}
export interface GlobSearchResult {
  content: string
  isError: boolean
}
export interface GlobSearch {
  search(request: GlobSearchRequest): Promise<GlobSearchResult>
}
export interface RipgrepGlobSearchOptions {
  cwd: string
  timeoutMs: number
  environment?: Readonly<Record<string, string>>
  runner?: {
    run(options: {
      command: string
      args: readonly string[]
      cwd?: string
      timeoutMs: number
      signal?: AbortSignal
      env?: Readonly<Record<string, string>>
    }): Promise<ProcessResult>
  }
}
function portable(value: string): string {
  return sep === '/' ? value : value.split(sep).join('/')
}
function abortError(): DOMException {
  return new DOMException('Tool execution aborted', 'AbortError')
}
export class RipgrepGlobSearch implements GlobSearch {
  private readonly runner: NonNullable<RipgrepGlobSearchOptions['runner']>
  constructor(private readonly options: RipgrepGlobSearchOptions) {
    this.runner =
      options.runner ??
      new BoundedProcessRunner({
        cwd: options.cwd,
        maxOutputBytes: MAX_ENUMERATION_BYTES,
      })
  }
  async search(request: GlobSearchRequest): Promise<GlobSearchResult> {
    if (request.signal?.aborted) throw abortError()
    const hidden = this.options.environment?.CLAUDE_CODE_GLOB_HIDDEN !== 'false'
    const noIgnore =
      this.options.environment?.CLAUDE_CODE_GLOB_NO_IGNORE !== 'false'
    let result: ProcessResult
    try {
      result = await this.runner.run({
        command: 'rg',
        args: [
          '--files',
          '--null',
          '--sort',
          'modified',
          ...(hidden ? ['--hidden'] : []),
          ...(noIgnore ? ['--no-ignore'] : []),
        ],
        cwd: request.root,
        timeoutMs: this.options.timeoutMs,
        ...(request.signal ? { signal: request.signal } : {}),
        ...(this.options.environment ? { env: this.options.environment } : {}),
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Glob enumeration failed: ${message}`)
    }
    if (result.timedOut)
      return {
        content: `Search timed out after ${this.options.timeoutMs}ms`,
        isError: true,
      }
    if (result.truncated)
      throw new Error('Glob enumeration failed: output truncated')
    if (result.code !== 0) {
      if (result.code === 1 && !result.stdout && !result.stderr)
        return { content: 'No files found', isError: false }
      const output = joinedProcessOutput(result)
      throw new Error(
        `Glob enumeration failed with exit code ${result.code}${output ? `: ${output}` : ''}`,
      )
    }
    const pattern = portable(request.pattern)
    const absolutePattern = isAbsolute(request.pattern)
    const matchBase = !absolutePattern && !pattern.includes('/')
    const paths = result.stdout.split('\0').filter(Boolean)
    const matched = paths.filter((path) => {
      const relativePath = portable(path)
      const absolutePath = portable(resolve(request.absoluteRoot, relativePath))
      return (
        pattern === '' ||
        minimatch(absolutePattern ? absolutePath : relativePath, pattern, {
          dot: true,
          matchBase,
          noext: true,
        })
      )
    })
    if (matched.length === 0)
      return { content: 'No files found', isError: false }
    const display = matched.slice(0, MAX_RESULTS).map((path) => {
      const relativePath = portable(path)
      if (absolutePattern)
        return portable(resolve(request.absoluteRoot, relativePath))
      return portable(join(request.displayRoot, relativePath))
    })
    const content = display.join('\n')
    return {
      content:
        matched.length > MAX_RESULTS
          ? `${content}\n(Showing 100 of ${matched.length} matching files; ${matched.length - 100} more are not listed. Narrow the pattern or path to see the rest.)`
          : content,
      isError: false,
    }
  }
}
