import { copyFile, mkdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { writeFileAtomically } from '../platform/atomic-write.js'
import { discoverClaudePluginEvals } from './claude-plugin-eval-discovery.js'
import {
  gradeClaudePluginEvalRun,
  type EvalGraderResult,
  type EvalJudge,
} from './claude-plugin-eval-graders.js'
import {
  runClaudePluginEvalOnce,
  type PluginEvalRuntimeFactory,
} from './claude-plugin-eval-runner.js'

export const PLUGIN_EVAL_HELP = `Usage: praxis plugin eval [options] [command] [target]

Run eval cases (evals/**/case.yaml or evals/**/prompt.md + graders/*.md) against
a plugin and report scored results. Target is a path, a plugin name, or a
\`plugin@marketplace\` id — installed and skills-dir plugins both resolve (and add
a no-plugin baseline arm).

Options:
  --ablation <mode>        Ablation mode: none or with-without (default depends on target)
  --allow-tools <tools...> Operator grant for gated case tools such as Bash or Write
  --case <glob>            Filter safe case names with a glob
  --json                   Print aggregate JSON
  --judge-model <model>    Judge model (default: haiku)
  --keep-temp              Keep isolated run directories
  --max-cost-usd <usd>     Stop before next run at ceiling; one active run may overrun
  --model <model>          Override case model
  --no-scaffold            Disable opt-in scaffold scripts (default)
  --output-dir <dir>       Results directory (default: evals/results/<timestamp>)
  --runs <n>               Override case run count
  --scaffold               Enable contained, bounded scaffold scripts
  --tag <tag...>           Include cases matching any tag
  --threshold <0..1>       Passing score (default: 1.0)
  --verbose                Print run progress
  -h, --help               Display help for command

Commands:
  init [options] [name]    Create an eval case
`

export const PLUGIN_EVAL_INIT_HELP = `Usage: praxis plugin eval init [options] [name]

Options:
  --bare      Write starter files without an interview
  -h, --help  Display help for command
`

export interface PluginEvalIo {
  stdout(message: string): void
  stderr(message: string): void
  isTTY?: boolean
}
export interface PluginEvalDependencies {
  runtimeFactory: PluginEvalRuntimeFactory
  judge?: EvalJudge
  interactiveInit?(options: { cwd: string; name?: string }): Promise<number>
  claudeVersion?: string
}

interface EvalOptions {
  target?: string
  ablation?: 'none' | 'with-without'
  allowTools: string[]
  caseGlob?: string
  json: boolean
  judgeModel: string
  keepTemp: boolean
  maxCostUsd?: number
  model?: string
  outputDir?: string
  runs?: number
  scaffold: boolean
  tags: string[]
  threshold: number
  verbose: boolean
}

function numberValue(value: string | undefined, flag: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${flag} requires a number`)
  return parsed
}

function parseOptions(argv: readonly string[]): EvalOptions {
  const result: EvalOptions = {
    allowTools: [],
    json: false,
    judgeModel: 'haiku',
    keepTemp: false,
    scaffold: false,
    tags: [],
    threshold: 1,
    verbose: false,
  }
  const operands: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === undefined) continue
    const take = () => {
      const next = argv[++index]
      if (!next || next.startsWith('--'))
        throw new Error(`${value} requires a value`)
      return next
    }
    if (value === '--json') result.json = true
    else if (value === '--keep-temp') result.keepTemp = true
    else if (value === '--scaffold') result.scaffold = true
    else if (value === '--no-scaffold') result.scaffold = false
    else if (value === '--verbose') result.verbose = true
    else if (value === '--ablation') {
      const mode = take()
      if (mode !== 'none' && mode !== 'with-without')
        throw new Error('--ablation must be none or with-without')
      result.ablation = mode
    } else if (value === '--case') result.caseGlob = take()
    else if (value === '--judge-model') result.judgeModel = take()
    else if (value === '--max-cost-usd') {
      result.maxCostUsd = numberValue(take(), value)
      if (result.maxCostUsd < 0)
        throw new Error('--max-cost-usd must be non-negative')
    } else if (value === '--model') result.model = take()
    else if (value === '--output-dir') result.outputDir = take()
    else if (value === '--runs') {
      result.runs = numberValue(take(), value)
      if (!Number.isInteger(result.runs) || result.runs < 1 || result.runs > 50)
        throw new Error('--runs must be an integer from 1 to 50')
    } else if (value === '--threshold') {
      result.threshold = numberValue(take(), value)
      if (result.threshold < 0 || result.threshold > 1)
        throw new Error('--threshold must be from 0 to 1')
    } else if (value === '--tag' || value === '--allow-tools') {
      const target = value === '--tag' ? result.tags : result.allowTools
      while (argv[index + 1] && !argv[index + 1]?.startsWith('-')) {
        const next = argv[++index]
        if (next !== undefined) target.push(next)
      }
      if (target.length === 0)
        throw new Error(`${value} requires at least one value`)
    } else if (value.startsWith('-'))
      throw new Error(`Unknown plugin eval option: ${value}`)
    else operands.push(value)
  }
  if (operands.length > 1) throw new Error('plugin eval accepts one target')
  if (operands[0] !== undefined) result.target = operands[0]
  return result
}

const INIT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
async function writeEvalTemplate(options: {
  cwd: string
  name: string
  prompt: string
  grader: string
}): Promise<void> {
  if (!INIT_NAME.test(options.name) || options.name === '..')
    throw new Error(`Eval name must match ${INIT_NAME}`)
  const dir = join(options.cwd, 'evals', options.name)
  try {
    await stat(dir)
    throw new Error(`Eval case already exists: ${dir}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    await mkdir(join(dir, 'graders'), { recursive: true })
    await writeFileAtomically(join(dir, 'prompt.md'), options.prompt)
    await writeFileAtomically(
      join(dir, 'graders', 'criteria.md'),
      options.grader,
    )
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}

async function interactiveEvalInit(options: {
  cwd: string
  name?: string
}): Promise<number> {
  const { createInterface } = await import('node:readline/promises')
  const interview = createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  const ask = async (question: string): Promise<string> => {
    const answer = (await interview.question(question)).trim()
    if (!answer) throw new Error('Eval interview answers must not be empty')
    return answer
  }
  try {
    const name = options.name ?? (await ask('Eval case name: '))
    const prompt = await ask('Task prompt: ')
    const criteria = await ask('Success criteria: ')
    await writeEvalTemplate({
      cwd: options.cwd,
      name,
      prompt: `---\nmax_turns: 10\nallowed_tools: [Read, Glob, Grep, Skill]\n---\n${prompt}\n`,
      grader: `---\ntype: llm\nweight: 1\n---\n${criteria}\n`,
    })
    return 0
  } finally {
    interview.close()
  }
}

export async function initClaudePluginEval(options: {
  cwd: string
  name?: string
  bare: boolean
  interactive: boolean
  isTTY: boolean
  interactiveInit?: PluginEvalDependencies['interactiveInit']
}): Promise<number> {
  if (!options.name && (!options.isTTY || options.bare))
    throw new Error(
      options.bare
        ? 'plugin eval init --bare requires a name'
        : 'plugin eval init requires a name when stdin is not a TTY',
    )
  if (!options.bare && (options.interactive || options.isTTY)) {
    return (options.interactiveInit ?? interactiveEvalInit)({
      cwd: options.cwd,
      ...(options.name ? { name: options.name } : {}),
    })
  }
  const name = options.name as string
  await writeEvalTemplate({
    cwd: options.cwd,
    name,
    prompt:
      '---\nmax_turns: 10\nallowed_tools: [Read, Glob, Grep, Skill]\n---\nInspect the current directory and summarize relevant findings.\n',
    grader: '---\ntype: regex\nweight: 1\nmatch: contains\n---\n.+\n',
  })
  return 0
}

export interface EvalRunReport {
  score: number
  turns: number
  cost_usd: number
  judge_cost_usd: number
  graders: EvalGraderResult[]
  trace_path: string
  error: string | null
  skipped_paid_graders: boolean
  temp_root?: string
}
interface EvalCaseReport {
  name: string
  dir: string
  source: string
  score: number
  pass_rate: number
  runs: EvalRunReport[]
  runs_without?: EvalRunReport[]
  score_without?: number
  pass_rate_without?: number
  delta?: number
}

export async function runClaudePluginEval(
  options: EvalOptions & {
    cwd: string
    configRoot: string
    dependencies: PluginEvalDependencies
    signal?: AbortSignal
  },
): Promise<{ code: number; aggregate: Record<string, unknown> }> {
  if (!options.target) throw new Error('plugin eval requires a target')
  const defaultAblation =
    options.ablation ??
    (options.target.includes('/') || options.target.startsWith('.')
      ? 'none'
      : 'with-without')
  const discovered = await discoverClaudePluginEvals({
    target: options.target,
    cwd: options.cwd,
    configRoot: options.configRoot,
    ...(options.caseGlob ? { caseGlob: options.caseGlob } : {}),
    ...(options.tags.length ? { tags: options.tags } : {}),
    ablation: defaultAblation,
  })
  if (discovered.cases.length === 0) throw new Error('No eval cases found')
  const timestamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const outputDir = resolve(
    options.cwd,
    options.outputDir ?? join('evals', 'results', timestamp),
  )
  await mkdir(outputDir, { recursive: true })
  const started = Date.now()
  let totalCost = 0
  let partial = false
  let partialReason: string | undefined
  let interrupted = false
  const reports: EvalCaseReport[] = []
  let stop = false
  for (const caseDef of discovered.cases) {
    const arms =
      defaultAblation === 'with-without'
        ? (['with', 'without'] as const)
        : (['with'] as const)
    const armReports: EvalRunReport[][] = []
    for (const arm of arms) {
      const runs: EvalRunReport[] = []
      for (let index = 0; index < (options.runs ?? caseDef.runs); index += 1) {
        if (options.signal?.aborted) {
          interrupted = true
          partial = true
          partialReason = 'interrupted'
          stop = true
          break
        }
        if (
          options.maxCostUsd !== undefined &&
          totalCost >= options.maxCostUsd
        ) {
          partial = true
          partialReason = 'cost_ceiling'
          stop = true
          break
        }
        if (options.verbose)
          process.stderr.write(`Running ${caseDef.name} ${arm} ${index + 1}\n`)
        const single = await runClaudePluginEvalOnce({
          case: caseDef,
          factory: options.dependencies.runtimeFactory,
          pluginDirectories:
            arm === 'with' ? discovered.plugins.map((item) => item.path) : [],
          ...(options.model ? { model: options.model } : {}),
          allowTools: options.allowTools,
          scaffold: options.scaffold,
          ...(options.signal ? { signal: options.signal } : {}),
        })
        const resultDir = join(outputDir, caseDef.name, arm, String(index + 1))
        await mkdir(resultDir, { recursive: true })
        const savedTrace = join(resultDir, 'trace.jsonl')
        let report: EvalRunReport
        try {
          await copyFile(single.tracePath, savedTrace)
          if (options.maxCostUsd !== undefined && !single.costKnown)
            throw new Error(
              'Cannot enforce --max-cost-usd: eval model cost is unavailable',
            )
          const remaining =
            options.maxCostUsd === undefined
              ? undefined
              : options.maxCostUsd - totalCost - single.costUsd
          const graded = await gradeClaudePluginEvalRun({
            case: caseDef,
            artifacts: single.artifacts,
            ...(options.dependencies.judge
              ? { judge: options.dependencies.judge }
              : {}),
            judgeModel: options.judgeModel,
            arm,
            ...(options.signal ? { signal: options.signal } : {}),
            skipPaid:
              single.error !== null ||
              (remaining !== undefined && remaining <= 0),
          })
          report = {
            score: graded.score,
            turns: single.turns,
            cost_usd: single.costUsd,
            judge_cost_usd: graded.judgeCostUsd,
            graders: graded.graders,
            trace_path: savedTrace,
            error: single.error,
            skipped_paid_graders: graded.skippedPaidGraders,
            ...(options.keepTemp && single.tempRoot
              ? { temp_root: single.tempRoot }
              : {}),
          }
        } catch (error) {
          report = {
            score: 0,
            turns: single.turns,
            cost_usd: single.costUsd,
            judge_cost_usd: 0,
            graders: [],
            trace_path: savedTrace,
            error: error instanceof Error ? error.message : String(error),
            skipped_paid_graders: false,
            ...(options.keepTemp && single.tempRoot
              ? { temp_root: single.tempRoot }
              : {}),
          }
        } finally {
          if (!options.keepTemp && single.tempRoot)
            await rm(single.tempRoot, { recursive: true, force: true })
        }
        runs.push(report)
        totalCost += report.cost_usd + report.judge_cost_usd
        await writeFileAtomically(
          join(resultDir, 'result.json'),
          `${JSON.stringify(report, null, 2)}\n`,
        )
        if (single.termination === 'interrupted') {
          interrupted = true
          partial = true
          partialReason = 'interrupted'
          stop = true
          break
        }
        if (options.signal?.aborted) {
          interrupted = true
          partial = true
          partialReason = 'interrupted'
          stop = true
          break
        }
      }
      armReports.push(runs)
      if (stop) break
    }
    const average = (runs: EvalRunReport[]) =>
      runs.length
        ? runs.reduce((sum, item) => sum + item.score, 0) / runs.length
        : 0
    const passRate = (runs: EvalRunReport[]) =>
      runs.length
        ? runs.filter((item) => item.score >= options.threshold).length /
          runs.length
        : 0
    const withScore = average(armReports[0] ?? [])
    const report: EvalCaseReport = {
      name: caseDef.name,
      dir: caseDef.dir,
      source: caseDef.source,
      score: withScore,
      pass_rate: passRate(armReports[0] ?? []),
      runs: armReports[0] ?? [],
    }
    if (armReports[1]) {
      const withoutScore = average(armReports[1])
      report.runs_without = armReports[1]
      report.score_without = withoutScore
      report.pass_rate_without = passRate(armReports[1])
      if (
        ![...report.runs, ...armReports[1]].some(
          (item) => item.skipped_paid_graders,
        )
      )
        report.delta = withScore - withoutScore
    }
    reports.push(report)
    if (stop) break
  }
  const aggregate: Record<string, unknown> = {
    schema_version: '1.0',
    claude_version: options.dependencies.claudeVersion ?? 'unknown',
    started_at: new Date(started).toISOString(),
    duration_seconds: (Date.now() - started) / 1000,
    cost_usd: totalCost,
    partial,
    ...(partialReason ? { partial_reason: partialReason } : {}),
    plugins: discovered.plugins,
    warnings: discovered.warnings,
    cases: reports,
  }
  await writeFileAtomically(
    join(outputDir, 'aggregate-result.json'),
    `${JSON.stringify(aggregate, null, 2)}\n`,
  )
  const failed = reports.some(
    (item) =>
      item.score < options.threshold ||
      [...item.runs, ...(item.runs_without ?? [])].some((run) => run.error),
  )
  return {
    code: interrupted
      ? 130
      : partialReason === 'cost_ceiling'
        ? 2
        : failed
          ? 1
          : 0,
    aggregate,
  }
}

export async function executeClaudePluginEvalCommand(
  argv: readonly string[],
  io: PluginEvalIo,
  dependencies: PluginEvalDependencies,
  signal?: AbortSignal,
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout(argv[0] === 'init' ? PLUGIN_EVAL_INIT_HELP : PLUGIN_EVAL_HELP)
    return 0
  }
  if (argv[0] === 'init') {
    let bare = false
    const operands: string[] = []
    for (const value of argv.slice(1)) {
      if (value === '--bare') bare = true
      else if (value.startsWith('-'))
        throw new Error(`Unknown plugin eval init option: ${value}`)
      else operands.push(value)
    }
    if (operands.length > 1)
      throw new Error('plugin eval init accepts one name')
    if (!io.isTTY && operands[0] && !bare)
      io.stderr('Warning: no TTY; creating bare eval template.\n')
    return initClaudePluginEval({
      cwd: process.cwd(),
      ...(operands[0] ? { name: operands[0] } : {}),
      bare: bare || !io.isTTY,
      interactive: false,
      isTTY: Boolean(io.isTTY),
      ...(dependencies.interactiveInit
        ? { interactiveInit: dependencies.interactiveInit }
        : {}),
    })
  }
  const parsed = parseOptions(argv)
  const result = await runClaudePluginEval({
    ...parsed,
    cwd: process.cwd(),
    configRoot: resolve(
      process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
    ),
    dependencies,
    ...(signal ? { signal } : {}),
  })
  if (parsed.json) io.stdout(`${JSON.stringify(result.aggregate)}\n`)
  else
    io.stdout(
      `Evaluated ${(result.aggregate.cases as unknown[]).length} case(s). Results written.\n`,
    )
  return result.code
}
