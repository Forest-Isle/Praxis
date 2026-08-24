import React from 'react'
import { Box, Text, useStdout } from 'ink'
import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  tuiInkRenderOptions,
  useTuiPresentationEnvironment,
} from './presentation-environment.js'

type Environment = ReturnType<typeof useTuiPresentationEnvironment>
type ProbeProps = {
  renderer?: 'default' | 'fullscreen'
  screenReader?: boolean
  override?: Readonly<{ columns?: number; rows?: number }>
  onEnvironment?: (environment: Environment) => void
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function testStdout(columns: number, rows: number) {
  return { columns, rows }
}

function Probe(props: ProbeProps) {
  const environment = useTuiPresentationEnvironment({
    renderer: props.renderer ?? 'fullscreen',
    screenReader: props.screenReader ?? false,
    ...(props.override === undefined
      ? {}
      : { viewportOverride: props.override }),
  })
  props.onEnvironment?.(environment)
  return React.createElement(Text, null, JSON.stringify(environment.viewport))
}

function StdoutFixture({
  children,
  columns,
  rows,
}: {
  children: React.ReactElement
  columns: number
  rows: number
}) {
  const { stdout } = useStdout()
  Object.defineProperty(stdout, 'columns', {
    configurable: true,
    writable: true,
    value: columns,
  })
  Object.defineProperty(stdout, 'rows', {
    configurable: true,
    writable: true,
    value: rows,
  })
  Object.defineProperty(stdout, 'isTTY', {
    configurable: true,
    writable: true,
    value: true,
  })
  return React.createElement(Box, null, children)
}

function fixture(
  stdout: { columns: number; rows: number },
  probe: React.ReactElement,
) {
  return React.createElement(StdoutFixture, {
    columns: stdout.columns,
    rows: stdout.rows,
    children: probe,
  })
}

function setStdoutDimensions(stdout: object, columns: number, rows: number) {
  Object.defineProperty(stdout, 'columns', {
    configurable: true,
    writable: true,
    value: columns,
  })
  Object.defineProperty(stdout, 'rows', {
    configurable: true,
    writable: true,
    value: rows,
  })
}

describe('tuiInkRenderOptions', () => {
  it('publishes the explicit 30 FPS policy for every presentation mode', () => {
    expect(tuiInkRenderOptions('fullscreen', false)).toEqual({
      incrementalRendering: false,
      alternateScreen: true,
      isScreenReaderEnabled: false,
      maxFps: 30,
      concurrent: false,
    })
    expect(tuiInkRenderOptions('default', false)).toEqual({
      incrementalRendering: true,
      alternateScreen: false,
      isScreenReaderEnabled: false,
      maxFps: 30,
      concurrent: false,
    })
    expect(tuiInkRenderOptions('fullscreen', true)).toEqual({
      incrementalRendering: false,
      alternateScreen: false,
      isScreenReaderEnabled: true,
      maxFps: 30,
      concurrent: false,
    })
  })
})

describe('useTuiPresentationEnvironment', () => {
  it('keeps the truthful initial terminal viewport, including narrow dimensions', () => {
    const stdout = testStdout(20, 7)
    const observed: Environment[] = []
    render(
      fixture(
        stdout,
        React.createElement(Probe, {
          onEnvironment: (environment) => observed.push(environment),
        }),
      ),
    )

    expect(observed.at(-1)?.viewport).toEqual({
      columns: 20,
      rows: 7,
      revision: 0,
      source: 'terminal',
    })
  })

  it('publishes only the latest complete resize tuple in a burst', async () => {
    vi.useFakeTimers()
    const stdout = testStdout(20, 7)
    const observed: Environment[] = []
    const app = render(
      fixture(
        stdout,
        React.createElement(Probe, {
          onEnvironment: (environment) => observed.push(environment),
        }),
      ),
    )

    Object.assign(app.stdout, { columns: 100, rows: 30 })
    app.stdout.emit('resize')
    Object.assign(app.stdout, { columns: 80, rows: 24 })
    app.stdout.emit('resize')
    expect(observed.at(-1)?.viewport.revision).toBe(0)

    vi.advanceTimersByTime(33)
    await vi.runOnlyPendingTimersAsync()
    expect(observed.at(-1)?.viewport).toEqual({
      columns: 80,
      rows: 24,
      revision: 1,
      source: 'terminal',
    })
  })

  it('never combines dimensions from separate pending observations', async () => {
    vi.useFakeTimers()
    const stdout = testStdout(20, 7)
    const observed: Environment[] = []
    const app = render(
      fixture(
        stdout,
        React.createElement(Probe, {
          onEnvironment: (environment) => observed.push(environment),
        }),
      ),
    )

    Object.assign(app.stdout, { columns: 100, rows: Number.NaN })
    app.stdout.emit('resize')
    Object.assign(app.stdout, { columns: Number.NaN, rows: 30 })
    app.stdout.emit('resize')

    vi.advanceTimersByTime(33)
    await vi.runOnlyPendingTimersAsync()

    expect(observed.at(-1)?.viewport).toEqual({
      columns: 20,
      rows: 30,
      revision: 1,
      source: 'terminal',
    })
  })

  it('uses one atomic override and suppresses terminal resize updates', async () => {
    vi.useFakeTimers()
    const stdout = testStdout(120, 40)
    const observed: Environment[] = []
    const app = render(
      fixture(
        stdout,
        React.createElement(Probe, {
          override: { columns: 20, rows: 7 },
          onEnvironment: (environment) => observed.push(environment),
        }),
      ),
    )

    expect(observed.at(-1)).toMatchObject({
      viewport: { columns: 20, rows: 7, source: 'override' },
    })
    Object.assign(app.stdout, { columns: 80, rows: 24 })
    app.stdout.emit('resize')
    vi.advanceTimersByTime(33)
    await vi.runOnlyPendingTimersAsync()
    expect(observed.at(-1)).toMatchObject({
      viewport: { columns: 20, rows: 7, source: 'override' },
    })
  })

  it('preserves identity and revision for duplicate and invalid observations', async () => {
    vi.useFakeTimers()
    const stdout = testStdout(20, 7)
    const observed: Environment[] = []
    const app = render(
      fixture(
        stdout,
        React.createElement(Probe, {
          onEnvironment: (environment) => observed.push(environment),
        }),
      ),
    )
    const initial = observed.at(-1)
    setStdoutDimensions(app.stdout, 80, 24)
    app.stdout.emit('resize')
    vi.advanceTimersByTime(33)
    await vi.runOnlyPendingTimersAsync()
    const published = observed.at(-1)
    expect(published?.viewport).toMatchObject({
      columns: 80,
      rows: 24,
      revision: 1,
    })

    app.stdout.emit('resize')
    vi.advanceTimersByTime(33)
    await vi.runOnlyPendingTimersAsync()
    expect(observed.at(-1)?.viewport).toBe(published?.viewport)

    setStdoutDimensions(app.stdout, Infinity, Number.NaN)
    app.stdout.emit('resize')
    vi.advanceTimersByTime(33)
    await vi.runOnlyPendingTimersAsync()
    expect(observed.at(-1)?.viewport).toBe(published?.viewport)
    expect(initial?.viewport).toMatchObject({ columns: 20, rows: 7 })
  })

  it('uses fallback geometry when the initial terminal dimensions are invalid', () => {
    const stdout = testStdout(Number.NaN, 0)
    const observed: Environment[] = []
    render(
      fixture(
        stdout,
        React.createElement(Probe, {
          onEnvironment: (environment) => observed.push(environment),
        }),
      ),
    )

    expect(observed.at(-1)?.viewport).toEqual({
      columns: 80,
      rows: undefined,
      revision: 0,
      source: 'fallback',
    })
  })

  it('gives screen-reader presentation precedence and remains unbounded', () => {
    const stdout = testStdout(20, 7)
    const observed: Environment[] = []
    render(
      fixture(
        stdout,
        React.createElement(Probe, {
          renderer: 'fullscreen',
          screenReader: true,
          onEnvironment: (environment) => observed.push(environment),
        }),
      ),
    )

    expect(observed.at(-1)).toMatchObject({
      kind: 'screen-reader',
      fixedViewport: false,
      screenReader: true,
      viewport: { columns: 20, rows: 7 },
    })
  })

  it('removes the resize listener and cancels pending publication on cleanup', async () => {
    vi.useFakeTimers()
    const stdout = testStdout(20, 7)
    const observed: Environment[] = []
    const app = render(
      fixture(
        stdout,
        React.createElement(Probe, {
          onEnvironment: (environment) => observed.push(environment),
        }),
      ),
    )
    const listenersWhileMounted = app.stdout.listenerCount('resize')
    setStdoutDimensions(app.stdout, 80, 24)
    app.stdout.emit('resize')
    app.unmount()
    vi.advanceTimersByTime(33)
    await vi.runOnlyPendingTimersAsync()

    expect(app.stdout.listenerCount('resize')).toBeLessThan(
      listenersWhileMounted,
    )
    expect(observed).toHaveLength(1)
  })
})
