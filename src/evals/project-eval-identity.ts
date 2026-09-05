import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'

import {
  redactSensitiveValue,
  sensitiveEnvironmentValues,
} from '../platform/sensitive-data.js'
import type { EvalRuntimeIdentityDescriptor } from './eval-contract.js'
import type { ProjectEvalCase } from './project-eval-schema.js'
import type { FileManifest } from './project-eval-workspace.js'
import {
  validatePraxisBuildIdentity,
  type PraxisBuildIdentity,
} from '../platform/praxis-build-identity.js'

export const PROJECT_EVAL_IDENTITY_SCHEMA_VERSION = '1.1' as const
export type ProjectEvalIdentitySchemaVersion =
  typeof PROJECT_EVAL_IDENTITY_SCHEMA_VERSION

export type IdentityDigest = `sha256:${string}`

export interface ProjectEvalRuntimeIdentity {
  engine: 'praxis'
  praxis_version: string
  node_version: string
  platform: string
  architecture: string
  build: PraxisBuildIdentity
  runtime_sha256: IdentityDigest
}

export interface ProjectEvalIdentity {
  schema_version: ProjectEvalIdentitySchemaVersion
  provider_id: string
  profile_id: string
  protocol: string
  endpoint_sha256: IdentityDigest
  model_id: string
  configuration_sha256: IdentityDigest
  tools_sha256: IdentityDigest
  prompt_sha256: IdentityDigest
  corpus_sha256: IdentityDigest
  runtime: ProjectEvalRuntimeIdentity
  identity_sha256: IdentityDigest
}

export interface CreateProjectEvalIdentityInput {
  provider: EvalRuntimeIdentityDescriptor
  case: ProjectEvalCase
  sourceBefore: FileManifest
  effectiveTools: readonly string[]
  runVerification: boolean
  praxisVersion: string
  nodeVersion?: string
  platform?: string
  architecture?: string
  buildIdentity: PraxisBuildIdentity
}

export interface AggregateIdentityRun {
  case: string
  run: number
  identity_sha256: IdentityDigest
}

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const MAX_DEPTH = 32
const MAX_NODES = 500_000
const MAX_STRING = 64 * 1024

function fail(message: string): never {
  throw new Error(`Invalid Project Eval identity: ${message}`)
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function assertSerializable(
  value: unknown,
  path = '$',
  depth = 0,
  state = { nodes: 0 },
  ancestry = new WeakSet<object>(),
): void {
  state.nodes += 1
  if (state.nodes > MAX_NODES) fail(`${path} exceeds object node limit`)
  if (depth > MAX_DEPTH) fail(`${path} exceeds object depth limit`)
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    if (typeof value === 'number' && !Number.isFinite(value))
      fail(`${path} contains a non-finite number`)
    return
  }
  if (typeof value === 'string') {
    if (value.length > MAX_STRING) fail(`${path} contains an oversized string`)
    return
  }
  if (
    typeof value === 'bigint' ||
    typeof value === 'function' ||
    typeof value === 'symbol' ||
    value === undefined
  )
    fail(`${path} contains an unsupported value`)
  if (Array.isArray(value)) {
    if (ancestry.has(value)) fail(`${path} contains a circular reference`)
    ancestry.add(value)
    try {
      for (let index = 0; index < value.length; index += 1)
        assertSerializable(
          value[index],
          `${path}[${index}]`,
          depth + 1,
          state,
          ancestry,
        )
    } finally {
      ancestry.delete(value)
    }
    return
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null)
      fail(`${path} contains an unsupported object`)
    if (ancestry.has(value)) fail(`${path} contains a circular reference`)
    ancestry.add(value)
    try {
      for (const [key, child] of Object.entries(value)) {
        if (key.length > 512) fail(`${path} contains an oversized key`)
        assertSerializable(child, `${path}.${key}`, depth + 1, state, ancestry)
      }
    } finally {
      ancestry.delete(value)
    }
    return
  }
  fail(`${path} contains an unsupported value`)
}

function canonical(value: unknown): string {
  assertSerializable(value)
  const ancestry = new WeakSet<object>()
  const serialize = (item: unknown): string => {
    if (item === null || typeof item !== 'object')
      return JSON.stringify(item) as string
    if (ancestry.has(item)) fail('contains a circular reference')
    ancestry.add(item)
    try {
      if (Array.isArray(item))
        return `[${item.map((child) => serialize(child)).join(',')}]`
      return `{${Object.entries(item)
        .sort(([left], [right]) => codeUnitCompare(left, right))
        .map(([key, child]) => `${JSON.stringify(key)}:${serialize(child)}`)
        .join(',')}}`
    } finally {
      ancestry.delete(item)
    }
  }
  return serialize(value)
}

function digest(value: unknown): IdentityDigest {
  return `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`
}

function string(value: unknown, path: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_STRING
  )
    fail(`${path} must be a bounded non-empty string`)
  return value
}

function digestField(value: unknown, path: string): IdentityDigest {
  if (typeof value !== 'string' || !DIGEST.test(value))
    fail(`${path} must be a sha256 digest`)
  return value as IdentityDigest
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    fail(`${path} must be a positive integer`)
  return value as number
}

function configurationSource(input: CreateProjectEvalIdentityInput): unknown {
  const c = input.case
  const sensitiveValues = sensitiveEnvironmentValues(c.execution.env)
  const graders = c.graders.map((grader) =>
    grader.type === 'tool_used' && !Number.isFinite(grader.max)
      ? { ...grader, max: 'unbounded' }
      : grader,
  )
  const configuration = {
    case: {
      name: c.name,
      schema_version: c.schemaVersion,
      risk: c.risk,
    },
    execution: {
      max_turns: c.execution.maxTurns,
      timeout_seconds: c.execution.timeoutSeconds,
      env: c.execution.env,
    },
    verification: {
      enabled: input.runVerification,
      definitions: c.verification,
    },
    graders,
    expect: {
      allowed_changed_paths: c.expect.allowedChangedPaths,
      expected_changed_paths: c.expect.expectedChangedPaths,
      forbidden_changed_paths: c.expect.forbiddenChangedPaths,
    },
  }
  return normalizeConfiguration(
    redactSensitiveValue(configuration, sensitiveValues),
  )
}

function normalizeConfiguration(value: unknown): unknown {
  if (typeof value === 'string')
    return posix.isAbsolute(value) || win32.isAbsolute(value)
      ? '[ABSOLUTE_PATH]'
      : value
  if (Array.isArray(value)) return value.map(normalizeConfiguration)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        normalizeConfiguration(child),
      ]),
    )
  return value
}

function corpusSource(sourceBefore: FileManifest): unknown {
  return {
    files: Object.fromEntries(
      Object.entries(sourceBefore.files).map(([path, file]) => [
        path,
        {
          hash: file.hash,
          size: file.size,
          mode: file.mode,
        },
      ]),
    ),
    total_bytes: sourceBefore.totalBytes,
  }
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>))
      freeze(child)
  }
  return value
}

export function createProjectEvalIdentity(
  input: CreateProjectEvalIdentityInput,
): ProjectEvalIdentity {
  const provider = input.provider
  const buildIdentity = validatePraxisBuildIdentity(input.buildIdentity)
  const runtimeBase = {
    engine: 'praxis' as const,
    praxis_version: string(input.praxisVersion, 'praxis_version'),
    node_version: string(input.nodeVersion ?? process.version, 'node_version'),
    platform: string(input.platform ?? process.platform, 'platform'),
    architecture: string(input.architecture ?? process.arch, 'architecture'),
    build: buildIdentity,
  }
  const identityWithoutDigests = {
    schema_version: PROJECT_EVAL_IDENTITY_SCHEMA_VERSION,
    provider_id: string(provider.providerId, 'provider_id'),
    profile_id: string(provider.profileId, 'profile_id'),
    protocol: string(provider.protocol, 'protocol'),
    endpoint_sha256: digest(string(provider.endpoint, 'endpoint')),
    model_id: string(provider.modelId, 'model_id'),
    configuration_sha256: digest(configurationSource(input)),
    tools_sha256: digest(input.effectiveTools),
    prompt_sha256: digest({
      prompt: input.case.execution.prompt,
      append_system_prompt: input.case.execution.appendSystemPrompt ?? null,
    }),
    corpus_sha256: digest(corpusSource(input.sourceBefore)),
    runtime: {
      ...runtimeBase,
      runtime_sha256: digest(runtimeBase),
    },
  }
  return freeze({
    ...identityWithoutDigests,
    identity_sha256: digest(identityWithoutDigests),
  })
}

function validateRuntime(
  value: unknown,
  path: string,
): ProjectEvalRuntimeIdentity {
  const runtime = value as Record<string, unknown>
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime))
    fail(`${path} must be an object`)
  const runtimeKeys = [
    'engine',
    'praxis_version',
    'node_version',
    'platform',
    'architecture',
    'build',
    'runtime_sha256',
  ]
  const runtimeUnknown = Object.keys(runtime).find(
    (key) => !runtimeKeys.includes(key),
  )
  if (runtimeUnknown) fail(`${path}.${runtimeUnknown} is not supported`)
  if (runtime.engine !== 'praxis') fail(`${path}.engine must be "praxis"`)
  const validated = {
    engine: 'praxis' as const,
    praxis_version: string(runtime.praxis_version, `${path}.praxis_version`),
    node_version: string(runtime.node_version, `${path}.node_version`),
    platform: string(runtime.platform, `${path}.platform`),
    architecture: string(runtime.architecture, `${path}.architecture`),
    build: validatePraxisBuildIdentity(runtime.build),
    runtime_sha256: digestField(
      runtime.runtime_sha256,
      `${path}.runtime_sha256`,
    ),
  }
  if (
    validated.runtime_sha256 !==
    digest({
      engine: validated.engine,
      praxis_version: validated.praxis_version,
      node_version: validated.node_version,
      platform: validated.platform,
      architecture: validated.architecture,
      build: validated.build,
    })
  )
    fail(`${path}.runtime_sha256 does not match runtime fields`)
  return validated
}

export function validateProjectEvalIdentity(
  value: unknown,
): ProjectEvalIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('must be an object')
  const source = value as Record<string, unknown>
  const keys = [
    'schema_version',
    'provider_id',
    'profile_id',
    'protocol',
    'endpoint_sha256',
    'model_id',
    'configuration_sha256',
    'tools_sha256',
    'prompt_sha256',
    'corpus_sha256',
    'runtime',
    'identity_sha256',
  ]
  const unknown = Object.keys(source).find((key) => !keys.includes(key))
  if (unknown) fail(`${unknown} is not supported`)
  if (source.schema_version !== PROJECT_EVAL_IDENTITY_SCHEMA_VERSION)
    fail('schema_version must be "1.1"')
  const validated = {
    schema_version: PROJECT_EVAL_IDENTITY_SCHEMA_VERSION,
    provider_id: string(source.provider_id, 'provider_id'),
    profile_id: string(source.profile_id, 'profile_id'),
    protocol: string(source.protocol, 'protocol'),
    endpoint_sha256: digestField(source.endpoint_sha256, 'endpoint_sha256'),
    model_id: string(source.model_id, 'model_id'),
    configuration_sha256: digestField(
      source.configuration_sha256,
      'configuration_sha256',
    ),
    tools_sha256: digestField(source.tools_sha256, 'tools_sha256'),
    prompt_sha256: digestField(source.prompt_sha256, 'prompt_sha256'),
    corpus_sha256: digestField(source.corpus_sha256, 'corpus_sha256'),
    runtime: validateRuntime(source.runtime, 'runtime'),
    identity_sha256: digestField(source.identity_sha256, 'identity_sha256'),
  }
  const withoutIdentity = { ...validated }
  delete (withoutIdentity as { identity_sha256?: unknown }).identity_sha256
  if (validated.identity_sha256 !== digest(withoutIdentity))
    fail('identity_sha256 does not match identity fields')
  return freeze(validated)
}

export function computeProjectEvalAggregateIdentity(
  runs: readonly AggregateIdentityRun[],
): IdentityDigest {
  const entries = runs
    .map((run) => ({
      case: string(run.case, 'runs.case'),
      run: positiveInteger(run.run, 'runs.run'),
      identity_sha256: digestField(run.identity_sha256, 'runs.identity_sha256'),
    }))
    .sort((left, right) => {
      const caseOrder = codeUnitCompare(left.case, right.case)
      return caseOrder === 0 ? left.run - right.run : caseOrder
    })
  return digest(entries)
}

export function validateProjectEvalAggregateIdentity(
  value: unknown,
  runs: readonly AggregateIdentityRun[],
): IdentityDigest {
  const declared = digestField(value, 'identity_sha256')
  const expected = computeProjectEvalAggregateIdentity(runs)
  if (declared !== expected)
    fail('aggregate identity_sha256 does not match runs')
  return declared
}

const comparableIdentityDimensions = [
  ['provider_id', 'provider_id'],
  ['profile_id', 'profile_id'],
  ['protocol', 'protocol'],
  ['endpoint_sha256', 'endpoint_sha256'],
  ['model_id', 'model_id'],
  ['configuration_sha256', 'configuration_sha256'],
  ['tools_sha256', 'tools_sha256'],
  ['prompt_sha256', 'prompt_sha256'],
  ['corpus_sha256', 'corpus_sha256'],
  ['runtime.engine', 'runtime.engine'],
  ['runtime.node_version', 'runtime.node_version'],
  ['runtime.platform', 'platform'],
  ['runtime.architecture', 'architecture'],
] as const

export function firstProjectEvalIdentityMismatch(
  left: ProjectEvalIdentity,
  right: ProjectEvalIdentity,
): string | null {
  for (const [field, label] of comparableIdentityDimensions) {
    const read = (identity: ProjectEvalIdentity): unknown =>
      field.startsWith('runtime.')
        ? identity.runtime[
            field.slice('runtime.'.length) as keyof ProjectEvalRuntimeIdentity
          ]
        : identity[field as keyof ProjectEvalIdentity]
    if (read(left) !== read(right)) return label
  }
  return null
}

export function assertProjectEvalIdentitiesComparable(
  left: ProjectEvalIdentity,
  right: ProjectEvalIdentity,
  context?: string,
): void {
  const mismatch = firstProjectEvalIdentityMismatch(left, right)
  if (mismatch)
    throw new Error(
      `${context ? `${context}: ` : ''}non-comparable identity: ${mismatch} differs`,
    )
}
