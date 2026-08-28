import { describe, expect, it } from 'vitest'

import { TuiEffectRunner } from './tui-effect-runner.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('TuiEffectRunner', () => {
  it('starts at generation zero and assigns the first run generation one', async () => {
    const runner = new TuiEffectRunner()
    expect(runner.generation).toBe(0)
    const run = runner.run(() => 'ready')
    expect(run.generation).toBe(1)
    expect(runner.generation).toBe(1)
    await expect(run.promise).resolves.toBe('ready')
  })

  it('cancels replacement, aborts its signal, and suppresses stale success', async () => {
    const runner = new TuiEffectRunner()
    const first = deferred<string>()
    let signal!: AbortSignal
    const old = runner.run((context) => {
      signal = context.signal
      return first.promise
    })
    const next = runner.run(() => 'new')
    first.resolve('old')
    await expect(old.promise).resolves.toBeUndefined()
    await expect(next.promise).resolves.toBe('new')
    expect(signal.aborted).toBe(true)
  })

  it('suppresses stale errors but propagates the current error', async () => {
    const runner = new TuiEffectRunner()
    const first = deferred<never>()
    const old = runner.run(() => first.promise)
    const next = runner.run(() => {
      throw new Error('current')
    })
    first.reject(new Error('stale'))
    await expect(old.promise).resolves.toBeUndefined()
    await expect(next.promise).rejects.toThrow('current')
  })

  it('exposes nested current-generation checks', async () => {
    const runner = new TuiEffectRunner()
    const checks: boolean[] = []
    const run = runner.run(async (context) => {
      checks.push(context.isCurrent(), runner.isCurrent(context.generation))
      await Promise.resolve()
      checks.push(context.isCurrent(), runner.isCurrent(context.generation))
      return 42
    })
    await expect(run.promise).resolves.toBe(42)
    expect(checks).toEqual([true, true, true, true])
  })

  it('cancels idempotently and disposes active and future effects', async () => {
    const runner = new TuiEffectRunner()
    let signal!: AbortSignal
    const active = runner.run(({ signal: currentSignal }) => {
      signal = currentSignal
      return new Promise<string>(() => undefined)
    })
    await Promise.resolve()
    const generation = runner.generation
    runner.cancel()
    runner.cancel()
    expect(signal.aborted).toBe(true)
    expect(runner.generation).toBe(generation + 2)
    await expect(active.promise).resolves.toBeUndefined()

    runner.dispose()
    runner.dispose()
    const future = runner.run(() => 'never')
    expect(future.generation).toBe(runner.generation)
    await expect(future.promise).resolves.toBeUndefined()
    expect(runner.isCurrent(future.generation)).toBe(false)
  })
})
