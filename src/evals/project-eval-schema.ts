import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { Minimatch, minimatch } from 'minimatch'
import type {
  EvalDeterministicGrader,
  EvalFocus,
  EvalToolMatch,
} from './eval-contract.js'

export const PROJECT_EVAL_SCHEMA_VERSION = '1.1'
export const PROJECT_EVAL_RISKS = ['low', 'medium', 'high', 'release'] as const
export type ProjectEvalRisk = (typeof PROJECT_EVAL_RISKS)[number]
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
export const PROJECT_EVAL_MAX_ITEMS = 256
const MAX_STRING = 16 * 1024
const MAX_BYTES = 1024 * 1024
const DEFAULT_PROJECT_EVAL_ALLOWED_TOOLS = ['Read', 'Glob', 'Grep'] as const
function validateBounds(
  value: unknown,
  label = 'case',
  depth = 0,
  state = { nodes: 0 },
): void {
  state.nodes += 1
  if (state.nodes > 4096) throw new Error(`${label} exceeds object node limit`)
  if (depth > 16) throw new Error(`${label} exceeds object depth limit`)
  if (typeof value === 'string' && value.length > MAX_STRING)
    throw new Error(`${label} contains oversized string`)
  if (Array.isArray(value)) {
    if (value.length > PROJECT_EVAL_MAX_ITEMS)
      throw new Error(`${label} contains oversized array`)
    for (const item of value) validateBounds(item, label, depth + 1, state)
  } else if (value && typeof value === 'object') {
    const entries = Object.entries(value)
    if (entries.length > PROJECT_EVAL_MAX_ITEMS)
      throw new Error(`${label} contains oversized object`)
    for (const [key, item] of entries) {
      if (key.length > 256) throw new Error(`${label} contains oversized key`)
      validateBounds(item, label, depth + 1, state)
    }
  }
}
export interface ProjectEvalCase {
  schemaVersion: '1.1'
  name: string
  risk: ProjectEvalRisk
  dir: string
  fixture: string
  tags: readonly string[]
  runs: number
  execution: {
    prompt: string
    maxTurns: number
    timeoutSeconds: number
    allowedTools: readonly string[]
    model?: string
    appendSystemPrompt?: string
    env: Readonly<Record<string, string>>
  }
  verification: readonly {
    name: string
    command: string
    args: readonly string[]
    timeoutSeconds: number
    required: true
    expect: 'pass'
  }[]
  graders: readonly EvalDeterministicGrader[]
  expect: {
    allowedChangedPaths: readonly string[]
    expectedChangedPaths: readonly string[]
    forbiddenChangedPaths: readonly string[]
  }
}
function obj(v: unknown, label: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new Error(`${label} must be an object`)
  return v as Record<string, unknown>
}
function strict(
  v: Record<string, unknown>,
  keys: readonly string[],
  label: string,
) {
  const bad = Object.keys(v).find((k) => !keys.includes(k))
  if (bad) throw new Error(`${label} has unknown field: ${bad}`)
}
function str(v: unknown, label: string, required = true): string {
  if (v === undefined && !required) return ''
  if (typeof v !== 'string' || !v.trim() || v.length > MAX_STRING)
    throw new Error(`${label} must be a non-empty string`)
  return v
}
function path(v: unknown, label: string): string {
  const s = str(v, label)
  const p = s.replaceAll('\\', '/')
  if (
    isAbsolute(s) ||
    s.includes('\0') ||
    p.split('/').some((x) => !x || x === '..' || x === '.') ||
    /^[A-Za-z]:\//u.test(p)
  )
    throw new Error(`${label} must be a contained relative path`)
  return p
}
function list(v: unknown, label: string): string[] {
  if (v === undefined) return []
  if (
    !Array.isArray(v) ||
    v.length > PROJECT_EVAL_MAX_ITEMS ||
    v.some((x) => typeof x !== 'string' || !x || x.length > MAX_STRING)
  )
    throw new Error(`${label} must be a bounded string array`)
  return v.map((x) => String(x))
}
function integer(
  v: unknown,
  label: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = v ?? fallback
  if (!Number.isInteger(n) || Number(n) < min || Number(n) > max)
    throw new Error(`${label} must be an integer from ${min} to ${max}`)
  return Number(n)
}
function glob(v: unknown, label: string): string {
  const s = path(v, label)
  if (!hasBalancedGlobDelimiters(s)) throw new Error(`${label} is invalid`)
  try {
    const matcher = new Minimatch(s, { nonegate: true, nocomment: true })
    if (!matcher.makeRe()) throw new Error('invalid')
  } catch {
    throw new Error(`${label} is invalid`)
  }
  return s
}

function focus(v: unknown, label: string, fallback: EvalFocus): EvalFocus {
  if (v === undefined) return fallback
  if (v === 'last_message' || v === 'trace' || v === 'files')
    return v as EvalFocus
  const item = obj(v, label)
  strict(item, ['source', 'path'], label)
  if (item.source !== 'file') throw new Error(`${label}.source must be file`)
  return { source: 'file', path: path(item.path, `${label}.path`) }
}

function toolMatch(v: unknown, label: string): EvalToolMatch {
  if (typeof v === 'string' && v.length > 0) return str(v, label)
  const item = obj(v, label)
  strict(item, ['tool', 'input_match'], label)
  if (item.input_match !== undefined) validateBounds(item.input_match, label)
  return {
    tool: str(item.tool, `${label}.tool`),
    ...(item.input_match === undefined
      ? {}
      : { input_match: obj(item.input_match, `${label}.input_match`) }),
  }
}

function projectGrader(v: unknown, index: number): EvalDeterministicGrader {
  const item = obj(v, `graders[${index}]`)
  const name = str(item.name, `graders[${index}].name`)
  if (!NAME.test(name))
    throw new Error(`graders[${index}].name must be a safe eval identifier`)
  if (item.arm !== undefined)
    throw new Error(`${name}.arm is not supported in project eval graders`)
  const type = str(item.type, `${name}.type`)
  const weight = item.weight === undefined ? 1 : Number(item.weight)
  if (!(weight > 0) || !Number.isFinite(weight))
    throw new Error(`${name}.weight must be positive`)
  const base = { name, weight }
  if (type === 'regex') {
    strict(
      item,
      ['type', 'name', 'weight', 'target', 'pattern', 'flags', 'match'],
      name,
    )
    const match = item.match === undefined ? 'contains' : String(item.match)
    if (
      !['contains', 'not_contains'].includes(match) &&
      !/^count:\d+$/u.test(match)
    )
      throw new Error(`${name}.match is invalid`)
    const flags = item.flags === undefined ? '' : String(item.flags)
    const pattern = str(item.pattern, `${name}.pattern`)
    try {
      new RegExp(pattern, flags)
    } catch {
      throw new Error(`${name}.pattern or flags are invalid`)
    }
    return {
      ...base,
      type: 'regex',
      target: focus(item.target, `${name}.target`, 'last_message'),
      pattern,
      flags,
      match: match as 'contains' | 'not_contains' | `count:${number}`,
    }
  }
  if (type === 'tool_order') {
    strict(item, ['type', 'name', 'weight', 'before', 'after'], name)
    return {
      ...base,
      type: 'tool_order',
      before: toolMatch(item.before, `${name}.before`),
      after: toolMatch(item.after, `${name}.after`),
    }
  }
  if (type === 'tool_used') {
    strict(
      item,
      ['type', 'name', 'weight', 'tool', 'input_match', 'min', 'max'],
      name,
    )
    const min = integer(item.min, `${name}.min`, 1, 0, Number.MAX_SAFE_INTEGER)
    const max =
      item.max === undefined
        ? Number.POSITIVE_INFINITY
        : integer(item.max, `${name}.max`, 0, 0, Number.MAX_SAFE_INTEGER)
    if (max < min) throw new Error(`${name}.max must be at least min`)
    return {
      ...base,
      type: 'tool_used',
      tool: str(item.tool, `${name}.tool`),
      ...(item.input_match === undefined
        ? {}
        : { input_match: obj(item.input_match, `${name}.input_match`) }),
      min,
      max,
    }
  }
  if (type === 'file_exists') {
    strict(item, ['type', 'name', 'weight', 'path', 'exists'], name)
    if (item.exists !== undefined && typeof item.exists !== 'boolean')
      throw new Error(`${name}.exists must be boolean`)
    return {
      ...base,
      type: 'file_exists',
      path: glob(item.path, `${name}.path`),
      exists: item.exists !== false,
    }
  }
  if (type === 'llm' || type === 'baseline')
    throw new Error(
      `Project eval grader ${name} does not support paid type ${type}`,
    )
  throw new Error(`Unsupported project grader type: ${type}`)
}

function hasBalancedGlobDelimiters(value: string): boolean {
  const depths: Record<'[' | '{' | '(', number> = { '[': 0, '{': 0, '(': 0 }
  const opening: Record<string, '[' | '{' | '(' | undefined> = {
    ']': '[',
    '}': '{',
    ')': '(',
  }
  for (const character of value) {
    if (character === '[' || character === '{' || character === '(') {
      depths[character] += 1
      continue
    }
    const opener = opening[character]
    if (opener !== undefined && --depths[opener] < 0) return false
  }
  return Object.values(depths).every((depth) => depth === 0)
}
export function parseProjectEvalCase(
  raw: unknown,
  dir: string,
): ProjectEvalCase {
  const r = obj(raw, 'case')
  validateBounds(r)
  strict(
    r,
    [
      'schema_version',
      'name',
      'risk',
      'tags',
      'runs',
      'fixture',
      'execution',
      'verification',
      'graders',
      'expect',
    ],
    'case',
  )
  if (r.schema_version !== '1.1')
    throw new Error(`Unsupported schema_version: ${String(r.schema_version)}`)
  const name = str(r.name, 'name')
  if (!NAME.test(name)) throw new Error('name must be a safe eval identifier')
  if (!PROJECT_EVAL_RISKS.includes(r.risk as ProjectEvalRisk))
    throw new Error('risk must be one of: low, medium, high, release')
  const ex = obj(r.execution, 'execution')
  strict(
    ex,
    [
      'prompt',
      'max_turns',
      'timeout_seconds',
      'allowed_tools',
      'model',
      'append_system_prompt',
      'env',
    ],
    'execution',
  )
  const expect = obj(r.expect, 'expect')
  strict(
    expect,
    [
      'allowed_changed_paths',
      'expected_changed_paths',
      'forbidden_changed_paths',
    ],
    'expect',
  )
  const allowed = list(
    expect.allowed_changed_paths,
    'expect.allowed_changed_paths',
  ).map((x) => glob(x, 'expect.allowed_changed_paths'))
  const fixture = path(r.fixture, 'fixture')
  const env = obj(ex.env ?? {}, 'execution.env')
  for (const [k, v] of Object.entries(env))
    if (!/^EVAL_[A-Z0-9_]+$/u.test(k) || typeof v !== 'string')
      throw new Error(`Invalid eval environment variable: ${k}`)
  const vr = r.verification === undefined ? [] : r.verification
  if (!Array.isArray(vr) || vr.length > PROJECT_EVAL_MAX_ITEMS)
    throw new Error('verification must be a bounded array')
  const verification = vr.map((x, i) => {
    const q = obj(x, `verification[${i}]`)
    strict(
      q,
      ['name', 'command', 'args', 'timeout_seconds', 'required', 'expect'],
      `verification[${i}]`,
    )
    const verifierName = str(q.name, `verification[${i}].name`)
    if (!NAME.test(verifierName))
      throw new Error(`verification[${i}].name must be a safe eval identifier`)
    if (q.required !== true)
      throw new Error(`verification[${i}].required must be true`)
    if (q.expect !== 'pass')
      throw new Error(`verification[${i}].expect must be pass`)
    return {
      name: verifierName,
      command: str(q.command, `verification[${i}].command`),
      args: list(q.args, `verification[${i}].args`),
      timeoutSeconds: integer(
        q.timeout_seconds,
        `verification[${i}].timeout_seconds`,
        120,
        1,
        3600,
      ),
      required: true as const,
      expect: 'pass' as const,
    }
  })
  if (
    new Set(verification.map((item) => item.name)).size !== verification.length
  )
    throw new Error('Project eval verifier names must be unique')
  const gradersRaw = r.graders === undefined ? [] : r.graders
  if (!Array.isArray(gradersRaw) || gradersRaw.length > PROJECT_EVAL_MAX_ITEMS)
    throw new Error('graders must be a bounded array')
  const graders = gradersRaw.map(projectGrader)
  if (new Set(graders.map((item) => item.name)).size !== graders.length)
    throw new Error('Project grader names must be unique')
  return {
    schemaVersion: '1.1',
    name,
    risk: r.risk as ProjectEvalRisk,
    dir,
    fixture,
    tags: list(r.tags, 'tags'),
    runs: integer(r.runs, 'runs', 1, 1, 50),
    execution: {
      prompt: str(ex.prompt, 'execution.prompt'),
      maxTurns: integer(ex.max_turns, 'execution.max_turns', 10, 1, 200),
      timeoutSeconds: integer(
        ex.timeout_seconds,
        'execution.timeout_seconds',
        120,
        1,
        3600,
      ),
      allowedTools: list(ex.allowed_tools, 'execution.allowed_tools').length
        ? list(ex.allowed_tools, 'execution.allowed_tools')
        : [...DEFAULT_PROJECT_EVAL_ALLOWED_TOOLS],
      ...(ex.model === undefined
        ? {}
        : { model: str(ex.model, 'execution.model') }),
      ...(ex.append_system_prompt === undefined
        ? {}
        : {
            appendSystemPrompt: str(
              ex.append_system_prompt,
              'execution.append_system_prompt',
            ),
          }),
      env: Object.fromEntries(
        Object.entries(env).map(([k, v]) => [k, String(v)]),
      ),
    },
    verification,
    graders,
    expect: {
      allowedChangedPaths: allowed,
      expectedChangedPaths: list(
        expect.expected_changed_paths,
        'expect.expected_changed_paths',
      ).map((x) => glob(x, 'expect.expected_changed_paths')),
      forbiddenChangedPaths: list(
        expect.forbidden_changed_paths,
        'expect.forbidden_changed_paths',
      ).map((x) => glob(x, 'expect.forbidden_changed_paths')),
    },
  }
}
export async function loadProjectEvalCase(
  dir: string,
): Promise<ProjectEvalCase> {
  const root = await realpath(resolve(dir))
  const definition = join(root, 'case.yaml')
  const definitionStat = await lstat(definition)
  if (definitionStat.isSymbolicLink() || !definitionStat.isFile())
    throw new Error('case.yaml must be a regular file')
  if (definitionStat.size > MAX_BYTES)
    throw new Error('case.yaml exceeds 1 MiB')
  const content = await readFile(definition, 'utf8')
  if (Buffer.byteLength(content) > MAX_BYTES)
    throw new Error('case.yaml exceeds 1 MiB')
  const raw = parseYaml(content, { maxAliasCount: 20 })
  validateBounds(raw)
  const c = parseProjectEvalCase(raw, root)
  const fixturePath = resolve(root, c.fixture)
  const fixtureStat = await lstat(fixturePath)
  if (fixtureStat.isSymbolicLink() || !fixtureStat.isDirectory())
    throw new Error('fixture must be a regular directory')
  const fixture = await realpath(fixturePath)
  if (fixture !== root && !fixture.startsWith(`${root}${sep}`))
    throw new Error('fixture escapes case directory')
  return { ...c, fixture }
}
export async function discoverProjectEvalCases(
  target: string,
  filter?: string,
  tags: readonly string[] = [],
): Promise<ProjectEvalCase[]> {
  if (filter !== undefined) {
    if (
      !filter ||
      filter.includes('\\') ||
      filter.includes('/') ||
      filter.includes('\0') ||
      filter.length > MAX_STRING ||
      /^[A-Za-z]:/u.test(filter) ||
      !hasBalancedGlobDelimiters(filter)
    )
      throw new Error('Invalid case glob')
    try {
      if (!new Minimatch(filter, { nonegate: true, nocomment: true }).makeRe())
        throw new Error('invalid')
    } catch {
      throw new Error('Invalid case glob')
    }
  }
  const root = await realpath(resolve(target))
  const discovered: ProjectEvalCase[] = []
  async function walk(d: string, depth = 0): Promise<void> {
    if (depth > 16) throw new Error('eval discovery exceeds depth 16')
    const entries = (await readdir(d, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )
    const inspected = await Promise.all(
      entries.map(async (entry) => {
        const path = join(d, entry.name)
        const entryStat = await lstat(path)
        if (entryStat.isSymbolicLink())
          throw new Error(`Eval definition tree contains symlink: ${path}`)
        if (!entryStat.isFile() && !entryStat.isDirectory())
          throw new Error(`Unsupported eval definition entry: ${path}`)
        return { entry, entryStat, path }
      }),
    )
    const definition = inspected.find(({ entry }) => entry.name === 'case.yaml')
    if (definition) {
      if (!definition.entryStat.isFile())
        throw new Error('case.yaml must be a regular file')
      const parsed = await loadProjectEvalCase(d)
      discovered.push(parsed)
      return
    }
    for (const { entry, entryStat, path } of inspected) {
      if (
        entry.name === 'results' ||
        entry.name === '.git' ||
        entry.name === 'node_modules' ||
        entry.name === '.claude'
      )
        continue
      if (entryStat.isDirectory()) await walk(path, depth + 1)
    }
  }
  const evalRoot = join(root, 'evals')
  const evalRootStat = await lstat(evalRoot).catch(() => null)
  if (
    !evalRootStat ||
    evalRootStat.isSymbolicLink() ||
    !evalRootStat.isDirectory()
  )
    throw new Error(`No evals directory in ${root}`)
  await walk(evalRoot)
  if (new Set(discovered.map((c) => c.name)).size !== discovered.length)
    throw new Error('Project eval case names must be unique')
  const out = discovered.filter(
    (parsed) =>
      (!filter || minimatch(parsed.name, filter)) &&
      (!tags.length || tags.some((tag) => parsed.tags.includes(tag))),
  )
  if (!out.length) throw new Error('No selected project eval cases')
  return out
}
