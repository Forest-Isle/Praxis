import type { ModelMessage } from '../core/runtime.js'
import type {
  ProjectMemoryExtractionRuntime,
  ProjectMemoryMessage,
  ProjectMemoryRecallHandle,
  ProjectMemoryRecallRuntime,
} from './project-memory.js'

export interface TurnSessionMemoryRuntime {
  summary(): Promise<string>
  waitForCompact(): Promise<void>
  observeContext(
    currentTokens: number,
    turnToolCalls: number,
    messageId: string,
    messages?: readonly ModelMessage[],
  ): Promise<boolean>
}

export interface TurnMemoryCoordinatorOptions {
  sessionId: string
  session?: TurnSessionMemoryRuntime
  projectRecall?: ProjectMemoryRecallRuntime
  projectExtraction?: ProjectMemoryExtractionRuntime
  warn?: (message: string) => void
}

/** Turn-scoped, best-effort coordination for both derived memory stores. */
export class TurnMemoryCoordinator {
  private recall: ProjectMemoryRecallHandle | undefined

  constructor(private readonly options: TurnMemoryCoordinatorOptions) {}

  prefetch(input: {
    turnId: string
    prompt: string
    signal?: AbortSignal
  }): void {
    if (!this.options.projectRecall) return
    try {
      this.recall = this.options.projectRecall.prefetch({
        sessionId: this.options.sessionId,
        ...input,
      })
    } catch (error) {
      this.warn('Project memory recall prefetch failed', error)
    }
  }

  async sessionSummary(): Promise<string> {
    if (!this.options.session) return ''
    try {
      return await this.options.session.summary()
    } catch (error) {
      this.warn('Session memory summary failed', error)
      return ''
    }
  }

  consumeRecall(): { content: string; attachmentCount: number } | null {
    try {
      return this.recall?.consumeIfSettled() ?? null
    } catch (error) {
      this.warn('Project memory recall consumption failed', error)
      return null
    }
  }

  recordRead(path: string): void {
    try {
      this.options.projectRecall?.recordRead(this.options.sessionId, path)
    } catch (error) {
      this.warn('Project memory read observation failed', error)
    }
  }

  async beforeCompact(): Promise<void> {
    if (!this.options.session) return
    try {
      await this.options.session.waitForCompact()
    } catch (error) {
      this.warn('Session memory compact coordination failed', error)
    }
  }

  async afterCompact(): Promise<void> {
    try {
      this.options.projectRecall?.recordCompact(this.options.sessionId)
    } catch (error) {
      this.warn('Project memory compact observation failed', error)
    }
  }

  async observeSuccess(input: {
    messageId?: string
    occupancyTokens: number
    toolCalls: number
    messages: readonly ModelMessage[]
    projectMessages: readonly ProjectMemoryMessage[]
    directMaintenance?: boolean
  }): Promise<void> {
    if (this.options.session && input.messageId !== undefined) {
      try {
        await this.options.session.observeContext(
          input.occupancyTokens,
          input.toolCalls,
          input.messageId,
          input.messages,
        )
      } catch (error) {
        this.warn('Session memory observation failed', error)
      }
    }
    try {
      this.options.projectExtraction?.observe({
        sessionId: this.options.sessionId,
        messages: input.projectMessages,
        ...(input.directMaintenance === undefined
          ? {}
          : { directMaintenance: input.directMaintenance }),
      })
    } catch (error) {
      this.warn('Project memory extraction observation failed', error)
    }
  }

  private warn(prefix: string, error: unknown): void {
    try {
      this.options.warn?.(
        `${prefix}: ${error instanceof Error ? error.message : String(error)}`,
      )
    } catch {
      // Warning sinks are deliberately non-authoritative.
    }
  }
}
