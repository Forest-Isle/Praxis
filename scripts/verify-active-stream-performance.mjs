import { performance } from 'node:perf_hooks'
import { createElement } from 'react'
import { render as renderInk } from 'ink-testing-library'

import { percentile } from './performance-statistics.mjs'
import { Transcript } from '../dist/cli/tui/claude-style.js'
import { TuiThemeProvider } from '../dist/cli/tui/theme.js'
import { projectTuiView } from '../dist/cli/tui/tui-view-model.js'

const fixtureEntryCount = 120_000
const warmupSampleCount = 20
const measuredSampleCount = 40
const budgetMs = 50
const injectionEnv = 'PRAXIS_ACTIVE_STREAM_INJECT_MS'

function busyWait(durationMs) {
  const deadline = performance.now() + durationMs
  while (performance.now() < deadline) {
    // Deliberately consume synchronous time for the harness regression proof.
  }
}

function rerender(app, entries, marker, injectionMs) {
  app.rerender(
    createElement(
      TuiThemeProvider,
      { settings: { theme: 'dark', syntaxHighlightingDisabled: true } },
      createElement(Transcript, {
        entries,
        activeText: `active stream marker ${marker}`,
        screenReader: false,
      }),
    ),
  )
  if (injectionMs > 0) busyWait(injectionMs)
  if (!app.lastFrame()?.includes(`active stream marker ${marker}`)) {
    throw new Error('Active-stream rerender marker was incomplete')
  }
}

const injectionMs = Number.parseFloat(process.env[injectionEnv] ?? '0')
if (!Number.isFinite(injectionMs) || injectionMs < 0) {
  throw new Error(`${injectionEnv} must be a non-negative number`)
}

let app
try {
  const history = Array.from({ length: fixtureEntryCount }, (_, index) => ({
    kind: 'assistant',
    text: `projection marker ${index}`,
  }))
  const view = projectTuiView({
    initialHistory: history,
    history,
    resume: true,
    fixedViewport: true,
    screenReader: false,
    rows: 36,
    width: 100,
    scrollOffset: 0,
    detailedTranscript: false,
    historyChange: { revision: 0, changedFrom: 0 },
  })
  app = renderInk(
    createElement(
      TuiThemeProvider,
      { settings: { theme: 'dark', syntaxHighlightingDisabled: true } },
      createElement(Transcript, {
        entries: view.transcriptEntries,
        activeText: '',
        screenReader: false,
      }),
    ),
  )
  for (let marker = 0; marker < warmupSampleCount; marker += 1) {
    rerender(app, view.transcriptEntries, `warmup-${marker}`, injectionMs)
  }
  if (typeof globalThis.gc === 'function') globalThis.gc()
  const durations = []
  for (let marker = 0; marker < measuredSampleCount; marker += 1) {
    const startedAt = performance.now()
    rerender(app, view.transcriptEntries, marker, injectionMs)
    durations.push(performance.now() - startedAt)
  }
  const p95Ms = percentile(durations, 95)
  process.stdout.write(
    `${JSON.stringify({
      benchmark: 'tui-active-stream-rerender',
      fixtureEntryCount,
      warmupSampleCount,
      measuredSampleCount,
      p95Ms,
      limitMs: budgetMs,
      injectionMs,
    })}\n`,
  )
  if (p95Ms > budgetMs) {
    console.error(
      `Active-stream rerender p95 ${p95Ms.toFixed(1)}ms exceeded ${budgetMs}ms budget`,
    )
    process.exitCode = 1
  }
} finally {
  app?.unmount()
}
