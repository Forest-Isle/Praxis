import { performance } from 'node:perf_hooks'
import { projectTuiView } from '../dist/cli/tui/tui-view-model.js'
import { transcriptPresentationLineCount } from '../dist/cli/tui/transcript-viewport.js'
import { percentile } from './performance-statistics.mjs'

const sizes = [30_000, 60_000, 120_000]
const warmupSampleCount = 8
const measuredSampleCount = 20
const ratioLimit = 3.25
const medianLimitMs = 1_000
const injectionMs = Number.parseFloat(
  process.env.PRAXIS_PROJECTION_INJECT_MS ?? '0',
)
if (!Number.isFinite(injectionMs) || injectionMs < 0)
  throw new Error('PRAXIS_PROJECTION_INJECT_MS must be non-negative')

const fixtures = sizes.map((size) =>
  Array.from({ length: size }, (_, index) => ({
    kind: 'assistant',
    text: `projection marker ${index}`,
  })),
)
const medians = []
for (let fixtureIndex = 0; fixtureIndex < sizes.length; fixtureIndex += 1) {
  const size = sizes[fixtureIndex]
  const history = fixtures[fixtureIndex]
  const newestMarker = `projection marker ${size - 1}`
  const project = () => {
    const startedAt = performance.now()
    const result = projectTuiView({
      initialHistory: history,
      history,
      resume: true,
      fixedViewport: true,
      screenReader: false,
      rows: 36,
      width: 100,
      scrollOffset: 0,
      detailedTranscript: false,
    })
    const visibleRows = transcriptPresentationLineCount(
      result.transcriptEntries,
      100,
      'normal',
    )
    if (visibleRows <= 0 || visibleRows > result.transcriptPageRows)
      throw new Error(`Projection row bounds failed for ${size}`)
    if (
      !result.transcriptEntries.some(
        (entry) =>
          entry.kind === 'item' && JSON.stringify(entry).includes(newestMarker),
      )
    )
      throw new Error(`Projection lost newest marker for ${size}`)
    const durationMs = performance.now() - startedAt
    return durationMs + (size === 120_000 ? injectionMs : 0)
  }
  for (let index = 0; index < warmupSampleCount; index += 1) project()
  if (typeof globalThis.gc === 'function') globalThis.gc()
  const durations = Array.from({ length: measuredSampleCount }, project)
  medians.push(percentile(durations, 50))
}
const ratio60k = medians[1] / medians[0]
const ratio120k = medians[2] / medians[1]
const result = {
  benchmark: 'tui-projection-scaling',
  projectionSizes: sizes,
  warmupSampleCount,
  measuredSampleCount,
  projectionMedians: medians,
  projectionRatio60k: ratio60k,
  projectionRatio120k: ratio120k,
  ratioLimit,
  medianLimitMs,
  injectionMs,
}
process.stdout.write(`${JSON.stringify(result)}\n`)
if (
  !Number.isFinite(ratio60k) ||
  !Number.isFinite(ratio120k) ||
  ratio60k > ratioLimit ||
  ratio120k > ratioLimit
) {
  console.error(
    `Projection scaling exceeded doubling budget: ${ratio60k.toFixed(2)}x/${ratio120k.toFixed(2)}x`,
  )
  process.exitCode = 1
} else if (medians[2] > medianLimitMs) {
  console.error(
    `120k projection median ${medians[2].toFixed(1)}ms exceeded ${medianLimitMs}ms budget`,
  )
  process.exitCode = 1
}
