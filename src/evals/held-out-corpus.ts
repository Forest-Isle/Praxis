import { lstat, opendir, readFile, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Minimatch } from 'minimatch'
import { parse as parseYaml } from 'yaml'

import {
  discoverProjectEvalCases,
  type ProjectEvalCase,
} from './project-eval-schema.js'

const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_FILES = 4096
const MAX_TOTAL_BYTES = 64 * 1024 * 1024
const MAX_ENTRIES = 16_384
const REQUIRED_TAGS = ['held-out', 'praxis-held-out-v1'] as const
const FORBIDDEN_TAGS = new Set([
  'tuning',
  'calibration',
  'baseline',
  'candidate',
  'admission',
])
const MUTATION_GLOB_OPTIONS = {
  dot: true,
  magicalBraces: true,
  nocomment: true,
  nonegate: true,
} as const

export interface HeldOutCorpusPolicy {
  readonly execution: 'opt-in-only'
  readonly tuning: 'forbidden'
  readonly resultInformedChanges: 'require-new-version'
}

export interface HeldOutCorpusRepository {
  readonly id: string
  readonly path: string
  readonly target: string
  readonly tasks: readonly string[]
  readonly cases: readonly ProjectEvalCase[]
}

export interface HeldOutCorpus {
  readonly root: string
  readonly schemaVersion: '1.0'
  readonly id: 'praxis-held-out-v1'
  readonly version: 1
  readonly split: 'held-out'
  readonly repetitions: 3
  readonly policy: HeldOutCorpusPolicy
  readonly contentSha256: `sha256:${string}`
  readonly repositories: readonly HeldOutCorpusRepository[]
  readonly taskCount: number
  readonly plannedRunCount: number
}

interface RawRepository {
  id?: unknown
  path?: unknown
  tasks?: unknown
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const expected = new Set(keys)
  const actual = Object.keys(value)
  if (
    actual.some((key) => !expected.has(key)) ||
    actual.length !== expected.size
  )
    throw new Error(`${label} has unexpected or missing fields`)
}

function bounded(
  value: unknown,
  label = 'manifest',
  depth = 0,
  state = { nodes: 0 },
): void {
  state.nodes += 1
  if (state.nodes > 4096) throw new Error(`${label} exceeds object node limit`)
  if (depth > 16) throw new Error(`${label} exceeds object depth limit`)
  if (typeof value === 'string' && value.length > 16 * 1024)
    throw new Error(`${label} contains oversized string`)
  if (Array.isArray(value)) {
    if (value.length > 256)
      throw new Error(`${label} contains oversized collection`)
    for (const item of value) bounded(item, label, depth + 1, state)
  } else if (value && typeof value === 'object') {
    const entries = Object.entries(value)
    if (entries.length > 256)
      throw new Error(`${label} contains oversized collection`)
    for (const [key, item] of entries) {
      if (key.length > 256) throw new Error(`${label} contains oversized key`)
      bounded(item, label, depth + 1, state)
    }
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 16 * 1024)
    throw new Error(`${label} must be a non-empty string`)
  return value
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function safeRelativePath(value: unknown, label: string): string {
  const input = text(value, label)
  const normalized = input.replaceAll('\\', '/')
  if (
    isAbsolute(input) ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.includes('\0') ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(`${label} must be a contained relative path`)
  return normalized
}

function contained(root: string, candidate: string, label: string): void {
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`))
    throw new Error(`${label} escapes corpus root`)
}

async function regularContainedPath(
  root: string,
  path: string,
  label: string,
): Promise<string> {
  const candidate = resolve(root, path)
  contained(root, candidate, label)
  const parts = relative(root, candidate).split(sep)
  let current = root
  for (const part of parts) {
    current = join(current, part)
    const component = await lstat(current).catch(() => null)
    if (!component) throw new Error(`${label} does not exist`)
    if (component.isSymbolicLink()) throw new Error(`${label} contains symlink`)
  }
  const info = await lstat(candidate)
  if (!info.isDirectory()) throw new Error(`${label} must be a directory`)
  const canonical = await realpath(candidate)
  contained(root, canonical, label)
  return canonical
}

interface DigestFile {
  path: string
  mode: number
  size: number
  digest: string
}

async function enumerateFiles(
  root: string,
  repositoryRoots: readonly string[],
): Promise<DigestFile[]> {
  const files: DigestFile[] = []
  let totalBytes = 0
  let visitedEntries = 0
  async function walk(directory: string): Promise<void> {
    const handle = await opendir(directory)
    for await (const entry of handle) {
      visitedEntries += 1
      if (visitedEntries > MAX_ENTRIES)
        throw new Error('Corpus exceeds directory entry limit')
      if (entry.name === '.git' || entry.name === 'node_modules')
        throw new Error(`Corpus contains forbidden entry: ${entry.name}`)
      const path = join(directory, entry.name)
      const info = await lstat(path)
      if (info.isSymbolicLink())
        throw new Error(`Corpus contains symlink: ${path}`)
      if (info.isDirectory()) {
        await walk(path)
        continue
      }
      if (!info.isFile())
        throw new Error(`Corpus contains unsupported entry: ${path}`)
      if (files.length >= MAX_FILES)
        throw new Error('Corpus exceeds file limit')
      totalBytes += info.size
      if (totalBytes > MAX_TOTAL_BYTES)
        throw new Error('Corpus exceeds byte limit')
      const content = await readFile(path)
      const digest = createHash('sha256').update(content).digest('hex')
      const rel = relative(root, path).split(sep).join('/')
      files.push({
        path: rel,
        mode: info.mode & 0o777,
        size: info.size,
        digest,
      })
    }
  }
  for (const repositoryRoot of repositoryRoots) await walk(repositoryRoot)
  return files
}

function contentDigest(files: readonly DigestFile[]): `sha256:${string}` {
  const records = [...files]
    .sort((a, b) => compareStrings(a.path, b.path))
    .map(
      (file) =>
        `${file.path}\0${file.mode.toString(8)}\0${file.size}\0${file.digest}\n`,
    )
    .join('')
  return `sha256:${createHash('sha256').update(records, 'utf8').digest('hex')}`
}

export async function loadHeldOutCorpus(root: string): Promise<HeldOutCorpus> {
  const corpusRoot = await realpath(resolve(root))
  const manifestPath = join(corpusRoot, 'corpus.yaml')
  const manifestInfo = await lstat(manifestPath)
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile())
    throw new Error('corpus.yaml must be a regular file')
  if (manifestInfo.size > MAX_MANIFEST_BYTES)
    throw new Error('corpus.yaml exceeds 1 MiB')
  const raw = parseYaml(await readFile(manifestPath, 'utf8'), {
    maxAliasCount: 20,
  })
  bounded(raw)
  const manifest = object(raw, 'corpus')
  exactKeys(
    manifest,
    [
      'schema_version',
      'id',
      'version',
      'split',
      'repetitions',
      'policy',
      'content_sha256',
      'repositories',
    ],
    'corpus',
  )
  if (manifest.schema_version !== '1.0')
    throw new Error('Unsupported corpus schema_version')
  if (manifest.id !== 'praxis-held-out-v1')
    throw new Error('Unsupported corpus id')
  if (manifest.version !== 1) throw new Error('Unsupported corpus version')
  if (manifest.split !== 'held-out')
    throw new Error('corpus split must be held-out')
  if (manifest.repetitions !== 3)
    throw new Error('corpus repetitions must be 3')
  const policyRaw = object(manifest.policy, 'corpus.policy')
  exactKeys(
    policyRaw,
    ['execution', 'tuning', 'result_informed_changes'],
    'corpus.policy',
  )
  if (
    policyRaw.execution !== 'opt-in-only' ||
    policyRaw.tuning !== 'forbidden' ||
    policyRaw.result_informed_changes !== 'require-new-version'
  )
    throw new Error('corpus policy is invalid')
  const declaredDigest = text(manifest.content_sha256, 'corpus.content_sha256')
  if (!/^sha256:[0-9a-f]{64}$/u.test(declaredDigest))
    throw new Error('corpus.content_sha256 is invalid')
  if (!Array.isArray(manifest.repositories) || manifest.repositories.length < 3)
    throw new Error('corpus must declare at least three repositories')

  const repositories: HeldOutCorpusRepository[] = []
  const ids = new Set<string>()
  const targets: string[] = []
  const globalTasks = new Set<string>()
  for (const [index, value] of manifest.repositories.entries()) {
    const item = object(value as RawRepository, `repositories[${index}]`)
    exactKeys(item, ['id', 'path', 'tasks'], `repositories[${index}]`)
    const id = text(item.id, `repositories[${index}].id`)
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id) || ids.has(id))
      throw new Error(
        'repository IDs must be unique lowercase dash-delimited identifiers',
      )
    ids.add(id)
    const path = safeRelativePath(item.path, `repositories[${index}].path`)
    const tasksRaw = item.tasks
    if (
      !Array.isArray(tasksRaw) ||
      tasksRaw.length < 4 ||
      tasksRaw.some((task) => typeof task !== 'string')
    )
      throw new Error(
        `repositories[${index}].tasks must contain at least four task names`,
      )
    const tasks = tasksRaw.map((task) =>
      text(task, `repositories[${index}].tasks`),
    )
    if (
      new Set(tasks).size !== tasks.length ||
      [...tasks].sort(compareStrings).some((task, i) => task !== tasks[i])
    )
      throw new Error(`repositories[${index}].tasks must be unique and sorted`)
    for (const task of tasks) {
      if (globalTasks.has(task))
        throw new Error(`Task name is duplicated across repositories: ${task}`)
      globalTasks.add(task)
    }
    const target = await regularContainedPath(
      corpusRoot,
      path,
      `repositories[${index}].path`,
    )
    targets.push(target)
    repositories.push({ id, path, target, tasks, cases: [] })
  }
  if (globalTasks.size < 12)
    throw new Error('corpus must contain at least twelve tasks')
  for (let i = 0; i < targets.length; i += 1) {
    for (let j = i + 1; j < targets.length; j += 1) {
      const left = targets[i]
      const right = targets[j]
      if (left === undefined || right === undefined) continue
      if (
        left === right ||
        left.startsWith(`${right}${sep}`) ||
        right.startsWith(`${left}${sep}`)
      )
        throw new Error('repository roots must be unique and non-nested')
    }
  }
  // Preflight every repository before Project Eval discovery. This bounds the
  // tree before the existing discovery walker inspects any case definitions.
  const files = await enumerateFiles(corpusRoot, targets)
  const finalRepositories: HeldOutCorpusRepository[] = []
  for (const repository of repositories) {
    const cases = await discoverProjectEvalCases(repository.target)
    cases.sort((left, right) => compareStrings(left.name, right.name))
    const names = cases.map((item) => item.name)
    if (
      names.length !== repository.tasks.length ||
      names.some((name, index) => name !== repository.tasks[index])
    )
      throw new Error(
        `Repository ${repository.id} task declaration does not match discovery`,
      )
    for (const item of cases) {
      if (item.runs !== 3)
        throw new Error(`${item.name} must have three repetitions`)
      if (!item.verification.some((verifier) => verifier.required))
        throw new Error(`${item.name} must have a required verifier`)
      if (
        !item.expect.allowedChangedPaths.length ||
        !item.expect.expectedChangedPaths.length ||
        !item.expect.forbiddenChangedPaths.length
      )
        throw new Error(
          `${item.name} must declare allowed, expected, and forbidden mutations`,
        )
      if (item.execution.model !== undefined)
        throw new Error(`${item.name} must not pin a model`)
      const allowed = new Set(item.expect.allowedChangedPaths)
      const expected = new Set(item.expect.expectedChangedPaths)
      const mutationPaths = [...allowed, ...expected]
      if (
        mutationPaths.some((path) =>
          new Minimatch(path, MUTATION_GLOB_OPTIONS).hasMagic(),
        )
      )
        throw new Error(
          `${item.name} allowed and expected mutations must use exact paths`,
        )
      if ([...expected].some((path) => !allowed.has(path)))
        throw new Error(`${item.name} expected mutations must be allowed`)
      const forbidden = item.expect.forbiddenChangedPaths.map(
        (pattern) => new Minimatch(pattern, MUTATION_GLOB_OPTIONS),
      )
      if (
        mutationPaths.some((path) =>
          forbidden.some((matcher) => matcher.match(path)),
        )
      )
        throw new Error(`${item.name} mutation paths overlap`)
      if (
        !REQUIRED_TAGS.every((tag) => item.tags.includes(tag)) ||
        !item.tags.includes(repository.id)
      )
        throw new Error(`${item.name} is missing required held-out tags`)
      if (item.tags.some((tag) => FORBIDDEN_TAGS.has(tag)))
        throw new Error(`${item.name} contains a forbidden tuning tag`)
    }
    finalRepositories.push({ ...repository, cases })
  }
  const actualDigest = contentDigest(files)
  if (actualDigest !== declaredDigest)
    throw new Error(
      `corpus content digest mismatch: expected ${declaredDigest}, got ${actualDigest}`,
    )
  const taskCount = globalTasks.size
  return {
    root: corpusRoot,
    schemaVersion: '1.0',
    id: 'praxis-held-out-v1',
    version: 1,
    split: 'held-out',
    repetitions: 3,
    policy: {
      execution: 'opt-in-only',
      tuning: 'forbidden',
      resultInformedChanges: 'require-new-version',
    },
    contentSha256: actualDigest,
    repositories: finalRepositories,
    taskCount,
    plannedRunCount: taskCount * 3,
  }
}
