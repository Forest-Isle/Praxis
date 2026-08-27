export type TuiEffectContext = {
  readonly signal: AbortSignal
  readonly generation: number
  readonly isCurrent: () => boolean
}

export type TuiEffect<T> = (context: TuiEffectContext) => Promise<T> | T

export class TuiEffectRunner {
  private _generation = 0
  private active: {
    generation: number
    controller: AbortController
    settleStale: () => void
  } | null = null
  private disposed = false

  get generation(): number {
    return this._generation
  }

  run<T>(effect: TuiEffect<T>): {
    generation: number
    promise: Promise<T | undefined>
    cancel: () => void
  } {
    if (this.disposed) {
      return {
        generation: this._generation,
        promise: Promise.resolve(undefined),
        cancel: () => undefined,
      }
    }

    if (this.active) {
      this.active.controller.abort()
      this.active.settleStale()
      this.active = null
    }
    const generation = ++this._generation
    const controller = new AbortController()
    let settled = false
    let resolvePromise!: (value: T | undefined) => void
    let rejectPromise!: (error: unknown) => void
    const promise = new Promise<T | undefined>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })
    const settleStale = () => {
      if (settled) return
      settled = true
      resolvePromise(undefined)
    }
    this.active = { generation, controller, settleStale }
    const context: TuiEffectContext = {
      signal: controller.signal,
      generation,
      isCurrent: () => this.isCurrent(generation),
    }
    Promise.resolve()
      .then(() => effect(context))
      .then(
        (value) => {
          if (!settled) {
            settled = true
            resolvePromise(this.isCurrent(generation) ? value : undefined)
          }
        },
        (error: unknown) => {
          if (settled) return
          settled = true
          if (this.isCurrent(generation)) rejectPromise(error)
          else resolvePromise(undefined)
        },
      )
      .finally(() => {
        if (this.active?.generation === generation) this.active = null
      })
    return {
      generation,
      promise,
      cancel: () => {
        if (this.isCurrent(generation)) this.cancel()
      },
    }
  }

  cancel(): void {
    if (this.active) this.active.controller.abort()
    this.active?.settleStale()
    this.active = null
    this._generation += 1
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancel()
  }

  isCurrent(generation: number): boolean {
    return (
      !this.disposed &&
      this._generation === generation &&
      this.active?.generation === generation
    )
  }
}
