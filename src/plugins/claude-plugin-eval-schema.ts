import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'

import { parse as parseYaml } from 'yaml'

export const EVAL_SCHEMA_VERSION = '1.0'
export const MAX_EVAL_FILE_BYTES = 1024 * 1024
export const MAX_EVAL_GRADERS = 256
export const MAX_EVAL_ARRAY_ITEMS = 256
export const MAX_EVAL_STRING_LENGTH = 16 * 1024
export const MAX_EVAL_OBJECT_DEPTH = 16
export const MAX_EVAL_OBJECT_NODES = 4096

const EVAL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

export type EvalFocus =
  'last_message' | 'trace' | 'files' | { source: 'file'; path: string }
export type EvalArm = 'with-only' | 'both'

interface EvalGraderBase {
  name: string
  weight: number
  arm?: EvalArm
}

export type ClaudePluginEvalGrader =
  | (EvalGraderBase & {
      type: 'regex'
      target: EvalFocus
      pattern: string
      flags: string
      match: 'contains' | 'not_contains' | `count:${number}`
    })
  | (EvalGraderBase & {
      type: 'tool_order'
      before: EvalToolMatch
      after: EvalToolMatch
    })
  | (EvalGraderBase & {
      type: 'tool_used'
      tool: string
      input_match?: Record<string, unknown>
      min: number
      max: number
    })
  | (EvalGraderBase & { type: 'file_exists'; path: string; exists: boolean })
  | (EvalGraderBase & { type: 'llm'; criteria: string; focus: EvalFocus })
  | (EvalGraderBase & {
      type: 'baseline'
      baseline_file: string
      criteria: string
    })

export type EvalToolMatch =
  | string
  | {
      tool: string
      input_match?: Record<string, unknown>
    }

export interface ClaudePluginEvalCase {
  schemaVersion: string
  name: string
  description?: string
  tags: readonly string[]
  plugins?: readonly string[]
  context: {
    scaffoldScript?: string
    historyFile?: string
    addDirs: readonly string[]
  }
  execution: {
    prompt?: string
    maxTurns: number
    timeoutSeconds: number
    model?: string
    allowedTools: readonly string[]
    appendSystemPrompt?: string
    env: Readonly<Record<string, string>>
  }
  runs: number
  graders: readonly ClaudePluginEvalGrader[]
  expectedOutcome?: string
  dir: string
  source: 'case_yaml' | 'prose' | 'mixed'
}

type UnknownRecord = Record<string, unknown>

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as UnknownRecord
}

function strict(value: UnknownRecord, keys: readonly string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key))
  if (unknown.length)
    throw new Error(`${label} has unknown field: ${unknown[0]}`)
}

function text(
  value: unknown,
  label: string,
  required = false,
): string | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new Error(`${label} must be a non-empty string`)
  if (value.length > MAX_EVAL_STRING_LENGTH)
    throw new Error(`${label} exceeds ${MAX_EVAL_STRING_LENGTH} characters`)
  return value
}

function safeName(value: unknown, label: string): string {
  const selected = text(value, label, true) as string
  if (!EVAL_NAME.test(selected) || selected === '.' || selected === '..')
    throw new Error(`${label} must be a safe eval identifier`)
  return selected
}

function safeRelativePath(value: unknown, label: string): string {
  const selected = text(value, label, true) as string
  const segments = selected.replaceAll('\\', '/').split('/')
  if (
    isAbsolute(selected) ||
    selected.includes('\0') ||
    segments.includes('..') ||
    segments.includes('')
  )
    throw new Error(`${label} must be a contained relative path`)
  return selected
}

function boundedObject(value: unknown, label: string): Record<string, unknown> {
  const selected = record(value, label)
  let nodes = 0
  const visit = (item: unknown, depth: number): void => {
    nodes += 1
    if (nodes > MAX_EVAL_OBJECT_NODES)
      throw new Error(`${label} exceeds ${MAX_EVAL_OBJECT_NODES} nodes`)
    if (depth > MAX_EVAL_OBJECT_DEPTH)
      throw new Error(`${label} exceeds depth ${MAX_EVAL_OBJECT_DEPTH}`)
    if (typeof item === 'string' && item.length > MAX_EVAL_STRING_LENGTH)
      throw new Error(`${label} contains an oversized string`)
    if (Array.isArray(item)) {
      if (item.length > MAX_EVAL_ARRAY_ITEMS)
        throw new Error(`${label} contains an oversized array`)
      for (const child of item) visit(child, depth + 1)
    } else if (item && typeof item === 'object') {
      const entries = Object.entries(item as Record<string, unknown>)
      if (entries.length > MAX_EVAL_ARRAY_ITEMS)
        throw new Error(`${label} contains an oversized object`)
      for (const [key, child] of entries) {
        if (key.length > 256)
          throw new Error(`${label} contains an oversized key`)
        visit(child, depth + 1)
      }
    }
  }
  visit(selected, 0)
  return selected
}

function integer(
  value: unknown,
  label: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const selected = value ?? fallback
  if (
    !Number.isInteger(selected) ||
    (selected as number) < min ||
    (selected as number) > max
  )
    throw new Error(`${label} must be an integer from ${min} to ${max}`)
  return selected as number
}

function strings(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))
    throw new Error(`${label} must be a string array`)
  if (value.length > MAX_EVAL_ARRAY_ITEMS)
    throw new Error(`${label} exceeds ${MAX_EVAL_ARRAY_ITEMS} items`)
  for (const item of value)
    if (item.length === 0 || item.length > MAX_EVAL_STRING_LENGTH)
      throw new Error(`${label} contains an invalid string`)
  return [...value]
}

function focus(value: unknown, label: string, fallback: EvalFocus): EvalFocus {
  if (value === undefined) return fallback
  if (['last_message', 'trace', 'files'].includes(String(value)))
    return value as EvalFocus
  const item = record(value, label)
  strict(item, ['source', 'path'], label)
  if (item.source !== 'file') throw new Error(`${label}.source must be file`)
  return {
    source: 'file',
    path: safeRelativePath(item.path, `${label}.path`),
  }
}

function toolMatch(value: unknown, label: string): EvalToolMatch {
  if (typeof value === 'string' && value.length) return value
  const item = record(value, label)
  strict(item, ['tool', 'input_match'], label)
  return {
    tool: text(item.tool, `${label}.tool`, true) as string,
    ...(item.input_match === undefined
      ? {}
      : {
          input_match: boundedObject(item.input_match, `${label}.input_match`),
        }),
  }
}

function grader(value: unknown, index: number): ClaudePluginEvalGrader {
  const item = record(value, `graders[${index}]`)
  const type = text(item.type, `graders[${index}].type`, true)
  const name = safeName(item.name, `graders[${index}].name`)
  const weight = item.weight === undefined ? 1 : Number(item.weight)
  if (!(weight > 0) || !Number.isFinite(weight))
    throw new Error(`${name}.weight must be positive`)
  const arm = item.arm
  if (arm !== undefined && arm !== 'with-only' && arm !== 'both')
    throw new Error(`${name}.arm must be with-only or both`)
  const base: EvalGraderBase = {
    name,
    weight,
    ...(arm === undefined ? {} : { arm }),
  }
  if (type === 'regex') {
    strict(
      item,
      ['type', 'name', 'weight', 'arm', 'target', 'pattern', 'flags', 'match'],
      name,
    )
    const match = item.match === undefined ? 'contains' : String(item.match)
    if (
      !['contains', 'not_contains'].includes(match) &&
      !/^count:\d+$/u.test(match)
    )
      throw new Error(`${name}.match is invalid`)
    const flags = item.flags === undefined ? '' : String(item.flags)
    try {
      new RegExp('', flags)
    } catch {
      throw new Error(`${name}.flags is invalid`)
    }
    return {
      ...base,
      type,
      target: focus(item.target, `${name}.target`, 'last_message'),
      pattern: text(item.pattern, `${name}.pattern`, true) as string,
      flags,
      match: match as 'contains',
    }
  }
  if (type === 'tool_order') {
    strict(item, ['type', 'name', 'weight', 'arm', 'before', 'after'], name)
    return {
      ...base,
      type,
      before: toolMatch(item.before, `${name}.before`),
      after: toolMatch(item.after, `${name}.after`),
    }
  }
  if (type === 'tool_used') {
    strict(
      item,
      ['type', 'name', 'weight', 'arm', 'tool', 'input_match', 'min', 'max'],
      name,
    )
    const min = integer(item.min, `${name}.min`, 1, 0, Number.MAX_SAFE_INTEGER)
    const max =
      item.max === undefined
        ? Number.POSITIVE_INFINITY
        : integer(item.max, `${name}.max`, 0, 0, Number.MAX_SAFE_INTEGER)
    if (max < min) throw new Error(`${name}.max must be at least min`)
    const tool = text(item.tool, `${name}.tool`, true) as string
    return {
      ...base,
      ...(tool === 'Skill' && arm === undefined
        ? { arm: 'with-only' as const }
        : {}),
      type,
      tool,
      ...(item.input_match === undefined
        ? {}
        : {
            input_match: boundedObject(item.input_match, `${name}.input_match`),
          }),
      min,
      max,
    }
  }
  if (type === 'file_exists') {
    strict(item, ['type', 'name', 'weight', 'arm', 'path', 'exists'], name)
    if (item.exists !== undefined && typeof item.exists !== 'boolean')
      throw new Error(`${name}.exists must be boolean`)
    return {
      ...base,
      type,
      path: safeRelativePath(item.path, `${name}.path`),
      exists: item.exists !== false,
    }
  }
  if (type === 'llm') {
    strict(item, ['type', 'name', 'weight', 'arm', 'criteria', 'focus'], name)
    return {
      ...base,
      type,
      criteria: text(item.criteria, `${name}.criteria`, true) as string,
      focus: focus(item.focus, `${name}.focus`, 'last_message'),
    }
  }
  if (type === 'baseline') {
    strict(
      item,
      ['type', 'name', 'weight', 'arm', 'baseline_file', 'criteria'],
      name,
    )
    return {
      ...base,
      type,
      baseline_file: safeRelativePath(
        item.baseline_file,
        `${name}.baseline_file`,
      ),
      criteria: text(item.criteria, `${name}.criteria`, true) as string,
    }
  }
  throw new Error(`Unsupported grader type: ${type}`)
}

function frontmatter(
  content: string,
  label: string,
): { metadata: UnknownRecord; body: string } {
  if (!content.startsWith('---\n'))
    throw new Error(`${label} must start with YAML frontmatter`)
  const end = content.indexOf('\n---', 4)
  if (end < 0) throw new Error(`${label} has unterminated YAML frontmatter`)
  return {
    metadata: record(
      yaml(content.slice(4, end), `${label} frontmatter`) ?? {},
      `${label} frontmatter`,
    ),
    body: content
      .slice(end + 4)
      .replace(/^\r?\n/u, '')
      .trim(),
  }
}

async function boundedRead(path: string): Promise<string> {
  if ((await stat(path)).size > MAX_EVAL_FILE_BYTES)
    throw new Error(`${path} exceeds 1 MiB`)
  return readFile(path, 'utf8')
}

function yaml(content: string, label: string): unknown {
  const parsed = parseYaml(content, { maxAliasCount: 20 })
  if (parsed !== undefined) boundedObject(parsed, label)
  return parsed
}

function normalize(
  raw: UnknownRecord,
  dir: string,
  source: ClaudePluginEvalCase['source'],
): ClaudePluginEvalCase {
  strict(
    raw,
    [
      'schema_version',
      'name',
      'description',
      'tags',
      'plugins',
      'context',
      'execution',
      'runs',
      'graders',
      'expected_outcome',
    ],
    'case',
  )
  const version = text(raw.schema_version, 'schema_version', true) as string
  if (!/^1(?:\.|$)/u.test(version))
    throw new Error(`Unsupported schema_version: ${version}`)
  const context =
    raw.context === undefined ? {} : record(raw.context, 'context')
  strict(context, ['scaffold_script', 'history_file', 'add_dirs'], 'context')
  const execution =
    raw.execution === undefined ? {} : record(raw.execution, 'execution')
  strict(
    execution,
    [
      'prompt',
      'max_turns',
      'timeout_seconds',
      'model',
      'allowed_tools',
      'append_system_prompt',
      'env',
    ],
    'execution',
  )
  const env =
    execution.env === undefined ? {} : record(execution.env, 'execution.env')
  for (const [key, value] of Object.entries(env)) {
    if (!/^EVAL_[A-Z0-9_]+$/u.test(key) || typeof value !== 'string')
      throw new Error(`Invalid eval environment variable: ${key}`)
  }
  const prompt = text(execution.prompt, 'execution.prompt')
  const historyFile = text(context.history_file, 'context.history_file')
  if (!prompt && !historyFile)
    throw new Error('Case requires execution.prompt or context.history_file')
  const gradersRaw = raw.graders
  if (!Array.isArray(gradersRaw) || gradersRaw.length < 1)
    throw new Error('Case requires at least one grader')
  if (gradersRaw.length > MAX_EVAL_GRADERS)
    throw new Error(`Case exceeds ${MAX_EVAL_GRADERS} graders`)
  const graders = gradersRaw.map(grader)
  if (new Set(graders.map((item) => item.name)).size !== graders.length)
    throw new Error('Grader names must be unique')
  return {
    schemaVersion: version,
    name: safeName(raw.name, 'name'),
    ...(raw.description === undefined
      ? {}
      : { description: text(raw.description, 'description') as string }),
    tags: strings(raw.tags, 'tags'),
    ...(raw.plugins === undefined
      ? {}
      : { plugins: strings(raw.plugins, 'plugins') }),
    context: {
      ...(context.scaffold_script === undefined
        ? {}
        : {
            scaffoldScript: safeRelativePath(
              context.scaffold_script,
              'context.scaffold_script',
            ),
          }),
      ...(historyFile
        ? { historyFile: safeRelativePath(historyFile, 'context.history_file') }
        : {}),
      addDirs: strings(context.add_dirs, 'context.add_dirs').map((path) =>
        safeRelativePath(path, 'context.add_dirs'),
      ),
    },
    execution: {
      ...(prompt ? { prompt } : {}),
      maxTurns: integer(execution.max_turns, 'execution.max_turns', 10, 1, 200),
      timeoutSeconds: integer(
        execution.timeout_seconds,
        'execution.timeout_seconds',
        300,
        1,
        3600,
      ),
      ...(execution.model === undefined
        ? {}
        : { model: text(execution.model, 'execution.model') as string }),
      allowedTools: strings(execution.allowed_tools, 'execution.allowed_tools'),
      ...(execution.append_system_prompt === undefined
        ? {}
        : {
            appendSystemPrompt: text(
              execution.append_system_prompt,
              'execution.append_system_prompt',
            ) as string,
          }),
      env: Object.fromEntries(
        Object.entries(env).map(([key, value]) => [
          key,
          text(value, `execution.env.${key}`, true) as string,
        ]),
      ),
    },
    runs: integer(raw.runs, 'runs', 3, 1, 50),
    graders,
    ...(raw.expected_outcome === undefined
      ? {}
      : {
          expectedOutcome: text(
            raw.expected_outcome,
            'expected_outcome',
          ) as string,
        }),
    dir,
    source,
  }
}

export async function loadClaudePluginEvalCase(
  caseDir: string,
): Promise<ClaudePluginEvalCase> {
  const dir = await realpath(resolve(caseDir))
  let yamlRaw: UnknownRecord | undefined
  let proseRaw: UnknownRecord | undefined
  try {
    yamlRaw = record(
      yaml(await boundedRead(join(dir, 'case.yaml')), 'case.yaml'),
      'case.yaml',
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    const parsed = frontmatter(
      await boundedRead(join(dir, 'prompt.md')),
      'prompt.md',
    )
    const metadata = parsed.metadata
    const execution: UnknownRecord = {}
    for (const key of [
      'model',
      'max_turns',
      'timeout_seconds',
      'allowed_tools',
      'append_system_prompt',
      'env',
    ])
      if (metadata[key] !== undefined) {
        execution[key] = metadata[key]
        delete metadata[key]
      }
    execution.prompt = parsed.body
    proseRaw = { ...metadata, execution }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (!yamlRaw && !proseRaw)
    throw new Error(`No case.yaml or prompt.md in ${dir}`)
  const graderDir = join(dir, 'graders')
  const proseGraders: UnknownRecord[] = []
  try {
    const names = (await readdir(graderDir))
      .filter((name) => name.endsWith('.md'))
      .sort()
    if (names.length > MAX_EVAL_GRADERS)
      throw new Error(`Too many graders in ${graderDir}`)
    for (const name of names) {
      const parsed = frontmatter(await boundedRead(join(graderDir, name)), name)
      const data: UnknownRecord = {
        name: basename(name, '.md'),
        ...parsed.metadata,
      }
      if (data.type === 'llm' || data.type === 'baseline')
        data.criteria ??= parsed.body
      if (data.type === 'regex') data.pattern ??= parsed.body
      proseGraders.push(data)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const merged: UnknownRecord = { ...(yamlRaw ?? {}), ...(proseRaw ?? {}) }
  merged.context = {
    ...record(yamlRaw?.context ?? {}, 'context'),
    ...record(proseRaw?.context ?? {}, 'context'),
  }
  merged.execution = {
    ...record(yamlRaw?.execution ?? {}, 'execution'),
    ...record(proseRaw?.execution ?? {}, 'execution'),
  }
  merged.graders = [
    ...(Array.isArray(yamlRaw?.graders) ? yamlRaw.graders : []),
    ...proseGraders,
  ]
  if (proseRaw && !merged.schema_version)
    merged.schema_version = EVAL_SCHEMA_VERSION
  if (proseRaw && !merged.name) merged.name = basename(dir)
  return normalize(
    merged,
    dir,
    yamlRaw && proseRaw ? 'mixed' : yamlRaw ? 'case_yaml' : 'prose',
  )
}

export async function resolveContainedPath(
  root: string,
  candidate: string,
  label: string,
): Promise<string> {
  const rootPath = await realpath(resolve(root))
  const path = await realpath(resolve(rootPath, candidate))
  if (path !== rootPath && !path.startsWith(`${rootPath}${sep}`))
    throw new Error(`${label} escapes eval root: ${candidate}`)
  return path
}
