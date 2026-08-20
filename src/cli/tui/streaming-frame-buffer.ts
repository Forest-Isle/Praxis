/**
 * Provider-neutral streaming frame buffer for the interactive CLI.
 *
 * High-frequency RuntimeEvent text/thinking deltas are appended here and
 * coalesced into bounded presentation frames published at a fixed cadence
 * (default ~30 FPS). Deltas are never lost or reordered: each stream keeps a
 * committed prefix (the last published value) plus an accumulating pending
 * tail, and every published frame is the exact concatenation of every delta
 * received since the previous frame.
 *
 * `flush()` publishes any pending deltas immediately and is used at lifecycle
 * boundaries (thinking-stop, tool-call/result, permission/dialog transitions,
 * turn completion/cancellation) so the transcript boundary state is always
 * published after the streaming text that preceded it. `dispose()` cancels
 * pending schedules and ignores later appends after the mounted app is torn
 * down.
 *
 * Scheduling is injected so tests can drive frames deterministically without
 * fixed sleeps.
 */

export interface StreamingFrame {
  /** Full accumulated assistant text for the active stream. */
  readonly text: string
  /** Full accumulated thinking text for the active stream. */
  readonly thinking: string
}

export interface StreamingFrameScheduler {
  /** Schedule `callback` after `delayMs`; returns an opaque cancel handle. */
  schedule(callback: () => void, delayMs: number): unknown
  /** Cancel a previously scheduled callback. */
  cancel(handle: unknown): void
}

export const DEFAULT_FRAME_INTERVAL_MS = 33

const timeoutScheduler: StreamingFrameScheduler = {
  schedule(callback, delayMs) {
    return setTimeout(callback, delayMs)
  },
  cancel(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

export interface StreamingFrameBufferOptions {
  /** Called with every published frame. */
  publish: (frame: StreamingFrame) => void
  /** Bounded cadence between frames; defaults to ~30 FPS. */
  frameIntervalMs?: number
  /** Injected timer hook for deterministic tests. */
  scheduler?: StreamingFrameScheduler
}

export class StreamingFrameBuffer {
  private readonly publishFrame: (frame: StreamingFrame) => void
  private readonly frameIntervalMs: number
  private readonly scheduler: StreamingFrameScheduler
  private committedText = ''
  private committedThinking = ''
  private pendingText: string | null = null
  private pendingThinking: string | null = null
  private scheduled = false
  private scheduledHandle: unknown = undefined
  private disposed = false

  constructor(options: StreamingFrameBufferOptions) {
    this.publishFrame = options.publish
    this.frameIntervalMs = options.frameIntervalMs ?? DEFAULT_FRAME_INTERVAL_MS
    this.scheduler = options.scheduler ?? timeoutScheduler
  }

  /** Full effective text, including any deltas not yet published. */
  get text(): string {
    return this.pendingText ?? this.committedText
  }

  /** Full effective thinking, including any deltas not yet published. */
  get thinking(): string {
    return this.pendingThinking ?? this.committedThinking
  }

  get hasPending(): boolean {
    return this.pendingText !== null || this.pendingThinking !== null
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /** Append an assistant text delta and schedule a frame publish. */
  appendText(delta: string): void {
    if (this.disposed) return
    this.pendingText = (this.pendingText ?? this.committedText) + delta
    this.scheduleFrame()
  }

  /** Append a thinking delta and schedule a frame publish. */
  appendThinking(delta: string): void {
    if (this.disposed) return
    this.pendingThinking =
      (this.pendingThinking ?? this.committedThinking) + delta
    this.scheduleFrame()
  }

  /** Discard pending text and clear the active text on the next frame. */
  resetText(): void {
    if (this.disposed) return
    if (
      this.pendingText === '' ||
      (this.pendingText === null && this.committedText === '')
    ) {
      return
    }
    this.pendingText = ''
    this.scheduleFrame()
  }

  /** Discard pending thinking and clear the active thinking on the next frame. */
  resetThinking(): void {
    if (this.disposed) return
    if (
      this.pendingThinking === '' ||
      (this.pendingThinking === null && this.committedThinking === '')
    ) {
      return
    }
    this.pendingThinking = ''
    this.scheduleFrame()
  }

  /** Publish every pending delta immediately, canceling any scheduled frame. */
  flush(): void {
    if (this.disposed) return
    this.cancelScheduledFrame()
    this.publishPending()
  }

  /** Cancel pending schedules and ignore all later appends. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelScheduledFrame()
    this.pendingText = null
    this.pendingThinking = null
  }

  private scheduleFrame(): void {
    if (this.scheduled || this.disposed) return
    this.scheduled = true
    this.scheduledHandle = this.scheduler.schedule(() => {
      this.scheduled = false
      this.scheduledHandle = undefined
      this.publishPending()
    }, this.frameIntervalMs)
  }

  private cancelScheduledFrame(): void {
    if (this.scheduledHandle !== undefined) {
      this.scheduler.cancel(this.scheduledHandle)
      this.scheduledHandle = undefined
      this.scheduled = false
    }
  }

  private publishPending(): void {
    if (this.disposed) return
    if (this.pendingText === null && this.pendingThinking === null) return
    if (this.pendingText !== null) this.committedText = this.pendingText
    if (this.pendingThinking !== null) {
      this.committedThinking = this.pendingThinking
    }
    this.pendingText = null
    this.pendingThinking = null
    this.publishFrame({
      text: this.committedText,
      thinking: this.committedThinking,
    })
  }
}
