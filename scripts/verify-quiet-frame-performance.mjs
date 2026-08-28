import { performance } from 'node:perf_hooks'
import { Buffer } from 'node:buffer'

import { AnsiFullscreenRenderer } from '../dist/cli/tui/ansi-frame-renderer.js'
import { projectQuietFrame } from '../dist/cli/tui/quiet-frame.js'
import {
  minimumPercentileSampleCount,
  percentile,
} from './performance-statistics.mjs'

const WIDTH = 120
const ROWS = 40
const PERCENTILE = 95
const WARMUP_SAMPLE_COUNT = 12
const MEASURED_SAMPLE_COUNT = Math.max(
  40,
  minimumPercentileSampleCount(PERCENTILE),
)
const INPUT_ECHO_LIMIT_MS = 50
const NORMAL_FRAME_LIMIT_MS = 16.7
const LOW_CAPABILITY_FRAME_LIMIT_MS = 33
const LATEST_TRANSCRIPT_MARKER = 'transcript marker 59'
const STATUS_MARKER = 'status marker'

const TRUECOLOR_STYLES = {
  heading: '\u001b[38;2;160;240;210m',
  body: '\u001b[38;2;220;225;230m',
  muted: '\u001b[38;2;145;155;170m',
  input: '\u001b[38;2;130;220;180m',
  warning: '\u001b[38;2;245;190;100m',
  selection: '\u001b[38;2;255;255;255m',
}

const ANSI16_STYLES = {
  heading: '\u001b[96m',
  body: '\u001b[37m',
  muted: '\u001b[90m',
  input: '\u001b[92m',
  warning: '\u001b[93m',
  selection: '\u001b[97m',
}

class CountingWriter {
  #markers
  bytes = 0
  chunks = 0
  seenMarkers = new Set()

  constructor(markers) {
    this.#markers = markers
  }

  write(chunk) {
    this.bytes += Buffer.byteLength(chunk)
    this.chunks += 1
    for (const marker of this.#markers) {
      if (chunk.includes(marker)) this.seenMarkers.add(marker)
    }
  }

  snapshot() {
    return { bytes: this.bytes, chunks: this.chunks }
  }

  hasAllMarkers() {
    return this.#markers.every((marker) => this.seenMarkers.has(marker))
  }
}

function row(key, text, role = 'body') {
  return {
    key,
    segments: [{ text, role }],
    height: 1,
    source: `quiet-performance:${key}`,
  }
}

const transcriptRows = Array.from({ length: 60 }, (_, index) =>
  row(
    `transcript:${index}`,
    `transcript marker ${index} · semantic response row ${index} with representative content`,
    index % 5 === 0 ? 'heading' : index % 3 === 0 ? 'muted' : 'body',
  ),
)

const baseInput = {
  screen: {
    presentation: { screenReader: false },
    body: {
      kind: 'conversation',
      intro: 'identity',
      sessionLabel: 'quiet-performance',
      transcript: {
        rows: transcriptRows,
        active: { visible: false, text: '', thinking: '' },
      },
    },
  },
  width: WIDTH,
  rows: ROWS,
  composerText: 'echo baseline composer marker',
  composerCursor: 6,
  shellMode: false,
  busy: false,
  status: `Ready · ${STATUS_MARKER}`,
  display: {
    cwd: '/tmp/praxis-quiet-performance',
    model: 'local-fixture-model',
    version: '0.42.0',
  },
  focusRows: [],
}

function inputForSample(index) {
  const composerText = `echo sample ${index} composer marker`
  return {
    ...baseInput,
    composerText,
    composerCursor: Math.max(0, composerText.length - (index % 4)),
  }
}

function frameContains(frame, marker) {
  return frame.lines.some((line) =>
    line.segments.some((segment) => segment.text.includes(marker)),
  )
}

function assertFixture(frame, path) {
  if (!frameContains(frame, LATEST_TRANSCRIPT_MARKER))
    throw new Error(`${path} fixture lost the latest transcript marker`)
  if (!frameContains(frame, STATUS_MARKER))
    throw new Error(`${path} fixture lost the status marker`)
  if (frame.lines.length !== ROWS)
    throw new Error(
      `${path} fixture projected ${frame.lines.length} rows, expected ${ROWS}`,
    )
  if (frame.cursor?.rowKey !== 'quiet:composer')
    throw new Error(`${path} fixture did not expose the composer cursor`)
}

function assertFiniteMeasurements(name, samples) {
  if (
    samples.length < MEASURED_SAMPLE_COUNT ||
    samples.some((sample) => !Number.isFinite(sample))
  )
    throw new Error(`${name} produced non-finite or insufficient measurements`)
}

function measureInputEcho() {
  const writer = new CountingWriter([LATEST_TRANSCRIPT_MARKER, STATUS_MARKER])
  const renderer = new AnsiFullscreenRenderer({
    writer,
    styles: TRUECOLOR_STYLES,
  })
  renderer.mount()
  const initialFrame = projectQuietFrame(baseInput)
  assertFixture(initialFrame, 'Input echo')
  renderer.draw(initialFrame)
  const durations = []

  for (
    let index = 0;
    index < WARMUP_SAMPLE_COUNT + MEASURED_SAMPLE_COUNT;
    index += 1
  ) {
    const before = writer.snapshot()
    const startedAt = performance.now()
    const frame = projectQuietFrame(inputForSample(index))
    renderer.draw(frame)
    const durationMs = performance.now() - startedAt
    const after = writer.snapshot()
    assertFixture(frame, 'Input echo')
    if (after.bytes <= before.bytes)
      throw new Error(`Input echo sample ${index} emitted no ANSI output`)
    if (index >= WARMUP_SAMPLE_COUNT) {
      if (after.chunks - before.chunks >= frame.lines.length)
        throw new Error(
          `Input echo sample ${index} redrew the complete ${frame.lines.length}-row frame`,
        )
      durations.push(durationMs)
    }
  }
  renderer.dispose()
  if (!writer.hasAllMarkers())
    throw new Error(
      'Input echo output lost a required transcript or status marker',
    )
  assertFiniteMeasurements('Input echo', durations)
  return percentile(durations, PERCENTILE)
}

function measureFullFrame(styles, path) {
  const durations = []
  for (
    let index = 0;
    index < WARMUP_SAMPLE_COUNT + MEASURED_SAMPLE_COUNT;
    index += 1
  ) {
    const writer = new CountingWriter([LATEST_TRANSCRIPT_MARKER, STATUS_MARKER])
    const renderer = new AnsiFullscreenRenderer({ writer, styles })
    renderer.mount()
    try {
      const startedAt = performance.now()
      const frame = projectQuietFrame(baseInput)
      renderer.draw(frame)
      const durationMs = performance.now() - startedAt
      assertFixture(frame, path)
      const output = writer.snapshot()
      if (output.bytes <= 0 || output.chunks <= 0)
        throw new Error(`${path} sample ${index} emitted no ANSI output`)
      if (!writer.hasAllMarkers())
        throw new Error(`${path} sample ${index} output lost a required marker`)
      if (index >= WARMUP_SAMPLE_COUNT) durations.push(durationMs)
    } finally {
      renderer.dispose()
    }
  }
  assertFiniteMeasurements(path, durations)
  return percentile(durations, PERCENTILE)
}

const inputEchoP95Ms = measureInputEcho()
const normalFrameP95Ms = measureFullFrame(TRUECOLOR_STYLES, 'Normal frame')
const lowCapabilityFrameP95Ms = measureFullFrame(
  ANSI16_STYLES,
  'Low-capability frame',
)

const budgets = [
  ['input echo', inputEchoP95Ms, INPUT_ECHO_LIMIT_MS],
  ['normal full ANSI frame', normalFrameP95Ms, NORMAL_FRAME_LIMIT_MS],
  [
    'low-capability full ANSI frame',
    lowCapabilityFrameP95Ms,
    LOW_CAPABILITY_FRAME_LIMIT_MS,
  ],
]
for (const [name, measured, limit] of budgets) {
  if (!Number.isFinite(measured))
    throw new Error(`${name} p95 was non-finite (limit ${limit} ms)`)
  if (measured >= limit)
    throw new Error(
      `${name} p95 ${measured.toFixed(2)} ms exceeded ${limit} ms limit`,
    )
}

process.stdout.write(
  `Quiet frame performance passed: input echo p95 ${inputEchoP95Ms.toFixed(2)} ms/<${INPUT_ECHO_LIMIT_MS} ms, normal frame p95 ${normalFrameP95Ms.toFixed(2)} ms/<${NORMAL_FRAME_LIMIT_MS} ms, low-capability frame p95 ${lowCapabilityFrameP95Ms.toFixed(2)} ms/<${LOW_CAPABILITY_FRAME_LIMIT_MS} ms\n`,
)
