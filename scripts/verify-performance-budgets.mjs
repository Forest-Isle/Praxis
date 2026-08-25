import { spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createElement } from 'react'
import { clearTimeout, setTimeout } from 'node:timers'
import { render as renderInk } from 'ink-testing-library'

import {
  minimumPercentileSampleCount,
  percentile,
} from './performance-statistics.mjs'

import { ClaudeSessionService } from '../dist/application/session-service.js'
import { Transcript } from '../dist/cli/tui/claude-style.js'
import { TuiThemeProvider } from '../dist/cli/tui/theme.js'
import {
  appendTuiHistory,
  projectTuiView,
} from '../dist/cli/tui/tui-view-model.js'
import { resolveClaudePaths } from '../dist/compatibility/claude/paths.js'
import { selectClaudeSchemaAdapter } from '../dist/compatibility/claude/schema.js'
import {
  createClaudeLastPromptEntry,
  translateProviderEvents,
} from '../dist/compatibility/claude/translation.js'
import { ClaudeTranscriptStore } from '../dist/persistence/claude-transcript-store.js'

const budgets = {
  cliColdStartP95Ms: 1_000,
  sessionListP95Ms: 500,
  transcriptLoadP95Ms: 750,
  transcriptLoadHeapMiB: 96,
  transcriptAppendP95Ms: 750,
  transcriptSyntaxRenderP95Ms: 1_500,
  tuiColdProjection120kMedianMs: 1_000,
  tuiRetainedAppend120kP95Ms: 50,
  tuiRetainedScroll120kP95Ms: 25,
  tuiRetainedHeapMiB: 128,
  tuiActiveStreamRerenderP95Ms: 50,
}
const sessionCount = 500
const transcriptEntryCount = 20_000
const cliTimeoutMs = 5_000
const cliColdStartSampleCount = 21
const transcriptSyntaxRenderSampleCount = minimumPercentileSampleCount(95)
if (typeof globalThis.gc !== 'function') {
  throw new Error(
    'Performance heap probe requires Node.js --expose-gc; use npm run test:performance',
  )
}
const probeRoot = await mkdtemp(join(tmpdir(), 'praxis-performance-'))

async function samples(count, action) {
  await action()
  const durations = []
  for (let index = 0; index < count; index += 1) {
    const startedAt = performance.now()
    await action()
    durations.push(performance.now() - startedAt)
  }
  return durations
}

function formatMs(value) {
  return `${value.toFixed(1)}ms`
}

function assertBudget(label, actual, limit, unit = 'ms') {
  if (actual <= limit) return
  throw new Error(
    `${label} exceeded budget: ${actual.toFixed(1)}${unit} > ${limit}${unit}`,
  )
}

function runActiveStreamBenchmark(repositoryRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--expose-gc',
        new URL('./verify-active-stream-performance.mjs', import.meta.url)
          .pathname,
      ],
      {
        cwd: repositoryRoot,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Active-stream benchmark failed (${code}): ${stderr.trim() || stdout.trim()}`,
          ),
        )
        return
      }
      try {
        resolve(JSON.parse(stdout.trim()))
      } catch (error) {
        reject(
          new Error(
            `Active-stream benchmark produced invalid JSON: ${error.message}`,
          ),
        )
      }
    })
  })
}

function runProjectionBenchmark(repositoryRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--expose-gc',
        new URL('./verify-projection-scaling.mjs', import.meta.url).pathname,
      ],
      {
        cwd: repositoryRoot,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('close', (code) => {
      try {
        const result = JSON.parse(stdout.trim())
        if (code !== 0) {
          reject(
            new Error(
              `Projection benchmark failed (${code}): ${stderr.trim() || stdout.trim()}`,
            ),
          )
          return
        }
        resolve(result)
      } catch (error) {
        reject(
          new Error(
            `Projection benchmark produced invalid JSON: ${error.message}`,
          ),
        )
      }
    })
  })
}

function runCli(repositoryRoot, expectedVersion) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/cli.js', '--version'], {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let killTimer
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000)
    }, cliTimeoutMs)
    const settle = (action) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      action()
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', (error) => settle(() => reject(error)))
    child.once('close', (code) => {
      settle(() => {
        if (timedOut) {
          reject(
            new Error(
              `CLI startup exceeded ${cliTimeoutMs}ms: ${stderr.trim()}`,
            ),
          )
          return
        }
        if (code !== 0) {
          reject(new Error(`CLI startup failed (${code}): ${stderr.trim()}`))
          return
        }
        if (stdout.trim() !== expectedVersion) {
          reject(new Error(`CLI startup returned unexpected output: ${stdout}`))
          return
        }
        resolve()
      })
    })
  })
}

function verifyDisabledTeamModules(repositoryRoot) {
  return new Promise((resolve, reject) => {
    const script = `
      import { registerHooks } from 'node:module'
      const loaded = []
      registerHooks({
        resolve(specifier, context, nextResolve) {
          const result = nextResolve(specifier, context)
          if (/\\/dist\\/(application|core|persistence|tools)\\/team-[^/]+\\.js$/.test(result.url)) loaded.push(result.url)
          return result
        },
      })
      await import(${JSON.stringify(pathToFileURL(join(repositoryRoot, 'dist/cli-runtime.js')).href)})
      if (loaded.length > 0) throw new Error(JSON.stringify(loaded))
    `
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        cwd: repositoryRoot,
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => key !== 'PRAXIS_ENABLE_TEAMS',
          ),
        ),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    let stderr = ''
    let settled = false
    let killTimer
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000)
    }, cliTimeoutMs)
    const settle = (action) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      action()
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', (error) => settle(() => reject(error)))
    child.once('close', (code) =>
      settle(() => {
        if (code !== 0)
          reject(
            new Error(
              `Disabled Team module probe failed (${code}): ${stderr.trim() || stdout.trim()}`,
            ),
          )
        else resolve()
      }),
    )
  })
}

function sessionFixture(sessionId, index, cwd) {
  const prompt = `performance session ${index}`
  const entries = translateProviderEvents(
    [
      { type: 'user-text', text: prompt },
      {
        type: 'assistant-text',
        text: 'fixture response',
        providerMessageId: `msg_performance_${index}`,
        model: 'praxis/performance-fixture',
      },
    ],
    {
      sessionId,
      parentUuid: null,
      cwd,
      claudeVersion: '2.1.208',
      gitBranch: null,
    },
  )
  const leafUuid = entries.at(-1)?.uuid
  if (typeof leafUuid !== 'string') {
    throw new Error('Could not create session performance fixture')
  }
  entries.push(
    createClaudeLastPromptEntry({
      sessionId,
      lastPrompt: prompt,
      leafUuid,
    }),
  )
  return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`
}

try {
  const repositoryRoot = process.cwd()
  const packageJson = JSON.parse(
    await readFile(join(repositoryRoot, 'package.json'), 'utf8'),
  )
  if (typeof packageJson.version !== 'string') {
    throw new Error('package.json version is missing')
  }
  const configRoot = join(probeRoot, 'config')
  const workDirectory = join(probeRoot, 'work')
  await mkdir(workDirectory, { recursive: true })
  const cwd = await realpath(workDirectory)

  const cliP95Ms = percentile(
    await samples(cliColdStartSampleCount, () =>
      runCli(repositoryRoot, packageJson.version),
    ),
    95,
  )
  assertBudget('CLI cold start p95', cliP95Ms, budgets.cliColdStartP95Ms)
  await verifyDisabledTeamModules(repositoryRoot)

  const fixturePaths = resolveClaudePaths({
    configDir: configRoot,
    cwd,
    sessionId: randomUUID(),
  })
  await mkdir(fixturePaths.projectRoot, { recursive: true })
  await Promise.all(
    Array.from({ length: sessionCount }, async (_, index) => {
      const sessionId = randomUUID()
      await writeFile(
        join(fixturePaths.projectRoot, `${sessionId}.jsonl`),
        sessionFixture(sessionId, index, cwd),
      )
    }),
  )
  const sessionService = new ClaudeSessionService({
    configRoot,
    cwd,
    claudeVersion: '2.1.208',
  })
  const sessionListP95Ms = percentile(
    await samples(5, async () => {
      const sessions = await sessionService.sessions()
      if (sessions.length !== sessionCount) {
        throw new Error(
          `Session fixture count changed: ${sessions.length} !== ${sessionCount}`,
        )
      }
    }),
    95,
  )
  assertBudget(
    '500-session listing p95',
    sessionListP95Ms,
    budgets.sessionListP95Ms,
  )

  const largeSessionId = randomUUID()
  const largePaths = resolveClaudePaths({
    configDir: configRoot,
    cwd,
    sessionId: largeSessionId,
  })
  const payload = 'transcript-payload-'.repeat(24)
  const largeSource = `${Array.from(
    { length: transcriptEntryCount },
    (_, index) =>
      JSON.stringify({
        type: 'progress',
        uuid: `${largeSessionId}-${index}`,
        sessionId: largeSessionId,
        payload,
      }),
  ).join('\n')}\n`
  await mkdir(dirname(largePaths.sessionFile), { recursive: true })
  await writeFile(largePaths.sessionFile, largeSource)
  const transcriptMiB = Buffer.byteLength(largeSource) / 1024 / 1024
  if (transcriptMiB < 8) {
    throw new Error(`Large transcript fixture is only ${transcriptMiB} MiB`)
  }
  const store = new ClaudeTranscriptStore({
    sessionFile: largePaths.sessionFile,
    lockFile: join(largePaths.praxisRoot, 'locks', `${largeSessionId}.lock`),
    schema: selectClaudeSchemaAdapter('2.1.208'),
  })
  const transcriptLoadP95Ms = percentile(
    await samples(5, async () => {
      const snapshot = await store.load()
      if (snapshot.entries.length !== transcriptEntryCount) {
        throw new Error(
          `Transcript fixture count changed: ${snapshot.entries.length} !== ${transcriptEntryCount}`,
        )
      }
    }),
    95,
  )
  assertBudget(
    'Large transcript load p95',
    transcriptLoadP95Ms,
    budgets.transcriptLoadP95Ms,
  )

  globalThis.gc()
  const heapBefore = process.memoryUsage().heapUsed
  let snapshot = await store.load()
  globalThis.gc()
  const transcriptLoadHeapMiB = Math.max(
    0,
    (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024,
  )
  if (snapshot.entries.length !== transcriptEntryCount) {
    throw new Error('Heap probe loaded an incomplete transcript')
  }
  assertBudget(
    'Large transcript heap growth',
    transcriptLoadHeapMiB,
    budgets.transcriptLoadHeapMiB,
    'MiB',
  )

  const appendDurations = []
  for (let index = 0; index < 3; index += 1) {
    const [entry] = translateProviderEvents(
      [{ type: 'user-text', text: `performance append ${index}` }],
      {
        sessionId: largeSessionId,
        parentUuid: snapshot.tail.lastUuid,
        cwd,
        claudeVersion: '2.1.208',
        gitBranch: null,
      },
    )
    if (!entry) throw new Error('Could not create append performance fixture')
    const startedAt = performance.now()
    const appendResult = await store.append(snapshot.tail, entry)
    appendDurations.push(performance.now() - startedAt)
    if (appendResult.status !== 'appended') {
      throw new Error(`Transcript append conflicted: ${appendResult.reason}`)
    }
    snapshot = {
      entries: [...snapshot.entries, entry],
      tail: appendResult.tail,
    }
  }
  const transcriptAppendP95Ms = percentile(appendDurations, 95)
  assertBudget(
    'Large transcript append p95',
    transcriptAppendP95Ms,
    budgets.transcriptAppendP95Ms,
  )

  const syntaxBlock = `\`\`\`typescript\n${Array.from(
    { length: 20 },
    (_, index) =>
      `const renderedLine${index} = "syntax-highlighted transcript payload"`,
  ).join('\n')}\n\`\`\``
  const syntaxItems = Array.from({ length: 200 }, (_, index) => ({
    kind: 'assistant',
    text: `${syntaxBlock}\nRender marker ${index}`,
  }))
  const transcriptSyntaxRenderP95Ms = percentile(
    await samples(transcriptSyntaxRenderSampleCount, async () => {
      const { transcriptEntries } = projectTuiView({
        initialHistory: syntaxItems,
        history: syntaxItems,
        resume: true,
        fixedViewport: true,
        screenReader: false,
        rows: 36,
        width: 100,
        scrollOffset: 0,
        detailedTranscript: false,
      })
      const app = renderInk(
        createElement(
          TuiThemeProvider,
          {
            settings: {
              theme: 'dark',
              syntaxHighlightingDisabled: false,
            },
          },
          createElement(Transcript, {
            entries: transcriptEntries,
            activeText: '',
            screenReader: false,
          }),
        ),
      )
      if (!app.lastFrame()?.includes('Render marker 199')) {
        throw new Error('Long transcript syntax render was incomplete')
      }
      app.unmount()
    }),
    95,
  )
  assertBudget(
    'Long transcript syntax render p95',
    transcriptSyntaxRenderP95Ms,
    budgets.transcriptSyntaxRenderP95Ms,
  )

  const projectionResult = await runProjectionBenchmark(process.cwd())
  const projectionSizes = projectionResult.projectionSizes
  const projectionFixtures = projectionSizes.map((size) =>
    Array.from({ length: size }, (_, index) => ({
      kind: 'assistant',
      text: `projection marker ${index}`,
    })),
  )
  const projectionMedians = projectionResult.projectionMedians
  const projectionRatio60k = projectionResult.projectionRatio60k
  const projectionRatio120k = projectionResult.projectionRatio120k
  assertBudget(
    '120k projection median',
    projectionMedians[2],
    budgets.tuiColdProjection120kMedianMs,
  )

  const retainedHistory = projectionFixtures[2]
  const retainedBase = {
    initialHistory: retainedHistory,
    history: retainedHistory,
    resume: true,
    fixedViewport: true,
    screenReader: false,
    rows: 36,
    width: 100,
    scrollOffset: 0,
    detailedTranscript: false,
    historyChange: { revision: 0, changedFrom: 0 },
  }
  const retainedBaseView = projectTuiView(retainedBase)
  const stableTailEntry = retainedBaseView.transcriptEntries.at(-1)
  if (!stableTailEntry)
    throw new Error('Retained append fixture did not project a visible tail')
  const retainedAppend = appendTuiHistory(1, retainedHistory, [
    { kind: 'assistant', text: 'retained append marker' },
  ])
  const retainedAppendedHistory = retainedAppend.history
  const pendingReadHistory = [
    ...retainedHistory,
    {
      kind: 'tool',
      call: {
        id: 'retained-append-read',
        name: 'Read',
        input: { file_path: '/tmp/retained-read' },
      },
      detail: '',
    },
  ]
  const pendingReadView = projectTuiView({
    ...retainedBase,
    initialHistory: pendingReadHistory,
    history: pendingReadHistory,
  })
  const completedReadAppend = appendTuiHistory(1, pendingReadHistory, [
    {
      kind: 'tool-result',
      callId: 'retained-append-read',
      text: 'retained read result marker',
      isError: false,
    },
  ])
  const completedReadHistory = completedReadAppend.history
  const retainedAppendSamples = minimumPercentileSampleCount(95)
  const retainedAppendDurations = await samples(retainedAppendSamples, () => {
    const nextView = projectTuiView(
      {
        ...retainedBase,
        history: retainedAppendedHistory,
        historyChange: retainedAppend.change,
      },
      retainedBaseView,
    )
    if (
      !nextView.transcriptEntries.some(
        (entry) =>
          entry.kind === 'item' &&
          entry.item.kind === 'assistant' &&
          entry.item.text === 'retained append marker',
      )
    )
      throw new Error('Retained append lost the visible tail marker')
    const reusedTailEntry = nextView.transcriptEntries.find(
      (entry) => entry.key === stableTailEntry.key,
    )
    if (reusedTailEntry !== stableTailEntry) {
      throw new Error('Retained append did not preserve entry identity')
    }
    const readView = projectTuiView(
      {
        ...retainedBase,
        initialHistory: pendingReadHistory,
        history: completedReadHistory,
        historyChange: completedReadAppend.change,
      },
      pendingReadView,
    )
    if (
      !readView.transcriptEntries.some(
        (entry) =>
          entry.kind === 'read-summary' &&
          entry.key === `read-summary-${retainedHistory.length}` &&
          entry.count === 1,
      )
    )
      throw new Error('Retained Read append did not produce its tail summary')
  })
  const tuiRetainedAppendP95Ms = percentile(retainedAppendDurations, 95)
  assertBudget(
    '120k retained append p95',
    tuiRetainedAppendP95Ms,
    budgets.tuiRetainedAppend120kP95Ms,
  )

  const scrollHistory = [
    ...projectionFixtures[2],
    {
      kind: 'tool',
      call: { id: 'retained-tail', name: 'Bash', input: { command: 'pwd' } },
      detail: '',
    },
    {
      kind: 'tool',
      call: {
        id: 'retained-read',
        name: 'Read',
        input: { file_path: '/tmp/a' },
      },
      detail: '',
    },
    {
      kind: 'tool-result',
      callId: 'retained-read',
      text: 'read marker',
      isError: false,
    },
  ]
  const scrollBase = {
    ...retainedBase,
    initialHistory: scrollHistory,
    history: scrollHistory,
    fixedViewport: true,
    rows: 36,
  }
  const scrollView = projectTuiView(scrollBase)
  const scrollAppend = appendTuiHistory(1, scrollHistory, [
    {
      kind: 'tool-result',
      callId: 'retained-tail',
      text: 'pending result marker',
      isError: false,
    },
  ])
  const scrollAppendedHistory = scrollAppend.history
  const scrollAppendChange = scrollAppend.change
  const scrollAppendedView = projectTuiView(
    {
      ...scrollBase,
      history: scrollAppendedHistory,
      historyChange: scrollAppendChange,
    },
    scrollView,
  )
  const tuiRetainedScrollDurations = await samples(
    retainedAppendSamples,
    () => {
      const selected = projectTuiView(
        {
          ...scrollBase,
          history: scrollAppendedHistory,
          scrollOffset: scrollAppendedView.maxTranscriptScrollOffset,
          historyChange: scrollAppendChange,
        },
        scrollAppendedView,
      )
      if (!selected.transcriptEntries.some((entry) => entry.key === 'item-0'))
        throw new Error('Retained scroll lost the oldest entry marker')
    },
  )
  const tuiRetainedShortScrollP95Ms = percentile(tuiRetainedScrollDurations, 95)
  assertBudget(
    '120k retained short-entry scroll-selection p95',
    tuiRetainedShortScrollP95Ms,
    budgets.tuiRetainedScroll120kP95Ms,
  )

  globalThis.gc()
  const tuiHeapBefore = process.memoryUsage().heapUsed
  const heapHistory = projectionFixtures[2]
  const heapView = projectTuiView({
    ...retainedBase,
    initialHistory: heapHistory,
    history: heapHistory,
  })
  const heapAppend = appendTuiHistory(1, heapHistory, [
    { kind: 'assistant', text: 'heap append' },
  ])
  const heapAppendedHistory = heapAppend.history
  const heapNext = projectTuiView(
    {
      ...retainedBase,
      initialHistory: heapHistory,
      history: heapAppendedHistory,
      historyChange: heapAppend.change,
    },
    heapView,
  )
  if (
    !heapNext.transcriptEntries.some(
      (entry) =>
        entry.kind === 'item' &&
        entry.item.kind === 'assistant' &&
        entry.item.text === 'heap append',
    )
  )
    throw new Error('Retained heap fixture lost its visible append')
  const retainedHeapRoots = [heapView, heapNext]
  globalThis.gc()
  const tuiHeapAfter = process.memoryUsage().heapUsed
  if (retainedHeapRoots[0] !== heapView || retainedHeapRoots[1] !== heapNext)
    throw new Error('Retained heap fixture roots changed during measurement')
  const tuiRetainedHeapMiB = Math.max(
    0,
    (tuiHeapAfter - tuiHeapBefore) / 1024 / 1024,
  )
  assertBudget(
    'Retained TUI projection heap growth',
    tuiRetainedHeapMiB,
    budgets.tuiRetainedHeapMiB,
    'MiB',
  )

  const oversizedHistory = [
    {
      kind: 'assistant',
      text: Array.from(
        { length: 120_000 },
        (_, index) => `oversized-row-${index} alpha beta`,
      ).join('\n'),
    },
  ]
  const oversizedBase = {
    ...retainedBase,
    initialHistory: oversizedHistory,
    history: oversizedHistory,
  }
  const oversizedView = projectTuiView(oversizedBase)
  const oversizedScrollOffset = Math.floor(
    oversizedView.maxTranscriptScrollOffset / 2,
  )
  const oversizedScrollDurations = await samples(retainedAppendSamples, () => {
    const selected = projectTuiView(
      { ...oversizedBase, scrollOffset: oversizedScrollOffset },
      oversizedView,
    )
    if (
      !selected.transcriptEntries.some(
        (entry) =>
          entry.kind === 'item' &&
          entry.item.kind === 'assistant' &&
          entry.item.text.includes('oversized-row-'),
      )
    )
      throw new Error('Oversized retained scroll lost its visible row marker')
  })
  const tuiOversizedScrollP95Ms = percentile(oversizedScrollDurations, 95)
  assertBudget(
    '120k-row oversized-entry scroll-selection p95',
    tuiOversizedScrollP95Ms,
    budgets.tuiRetainedScroll120kP95Ms,
  )
  const tuiRetainedScrollP95Ms = Math.max(
    tuiRetainedShortScrollP95Ms,
    tuiOversizedScrollP95Ms,
  )

  // Keep the active-stream renderer in a fresh process. This prevents the
  // preceding heap-heavy probes from perturbing Node's JIT/GC state while
  // retaining the same 50ms p95 gate and sample collection.
  const activeStreamResult = await runActiveStreamBenchmark(process.cwd())
  const tuiActiveStreamRerenderP95Ms = activeStreamResult.p95Ms
  assertBudget(
    'Unchanged-history active-stream rerender p95',
    tuiActiveStreamRerenderP95Ms,
    budgets.tuiActiveStreamRerenderP95Ms,
  )

  console.log(
    [
      'Praxis performance budgets passed',
      `CLI cold start p95 ${formatMs(cliP95Ms)}/${budgets.cliColdStartP95Ms}ms`,
      `500 sessions p95 ${formatMs(sessionListP95Ms)}/${budgets.sessionListP95Ms}ms`,
      `${transcriptMiB.toFixed(1)} MiB transcript load p95 ${formatMs(transcriptLoadP95Ms)}/${budgets.transcriptLoadP95Ms}ms`,
      `heap +${transcriptLoadHeapMiB.toFixed(1)} MiB/${budgets.transcriptLoadHeapMiB}MiB`,
      `append p95 ${formatMs(transcriptAppendP95Ms)}/${budgets.transcriptAppendP95Ms}ms`,
      `syntax render p95 ${formatMs(transcriptSyntaxRenderP95Ms)}/${budgets.transcriptSyntaxRenderP95Ms}ms`,
      `projection medians ${formatMs(projectionMedians[0])}/${formatMs(projectionMedians[1])}/${formatMs(projectionMedians[2])} (ratios ${projectionRatio60k.toFixed(2)}x/${projectionRatio120k.toFixed(2)}x)`,
      `TUI cold 120k median ${formatMs(projectionMedians[2])}/${budgets.tuiColdProjection120kMedianMs}ms`,
      `TUI retained append p95 ${formatMs(tuiRetainedAppendP95Ms)}/${budgets.tuiRetainedAppend120kP95Ms}ms`,
      `TUI retained scroll p95 ${formatMs(tuiRetainedScrollP95Ms)}/${budgets.tuiRetainedScroll120kP95Ms}ms`,
      `TUI retained heap +${tuiRetainedHeapMiB.toFixed(1)}MiB/${budgets.tuiRetainedHeapMiB}MiB`,
      `TUI active-stream rerender p95 ${formatMs(tuiActiveStreamRerenderP95Ms)}/${budgets.tuiActiveStreamRerenderP95Ms}ms`,
    ].join('; '),
  )
} finally {
  await rm(probeRoot, { recursive: true })
}
