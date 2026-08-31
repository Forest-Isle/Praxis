import { lstat, readFile, realpath, readdir } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const MANIFEST_KEYS = ['schemaVersion', 'behaviors', 'gates']
const BEHAVIOR_KEYS = [
  'id',
  'seam',
  'contract',
  'status',
  'modules',
  'outcomes',
  'evidence',
]
const STATUS = new Set(['qualified', 'blocked', 'excluded'])
const ID = /^[a-z0-9]+(?:\.[a-z0-9]+)+$/
const FIXTURE_ROOT = 'test/fixtures'
const EVIDENCE_ROOTS = ['test/fixtures/native', 'test/fixtures/reference']

const keys = (value) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value)
    : []
const exactKeys = (value, expected, label, diagnostics) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    diagnostics.push(`${label} must be an object`)
    return
  }
  const expectedSet = new Set(expected)
  for (const key of keys(value).sort())
    if (!expectedSet.has(key))
      diagnostics.push(`${label} has unknown key '${key}'`)
  for (const key of expected)
    if (!Object.hasOwn(value, key))
      diagnostics.push(`${label} is missing '${key}'`)
}

function repoPath(root, candidate, label, diagnostics, allowedRoot = null) {
  if (typeof candidate !== 'string' || !candidate || isAbsolute(candidate)) {
    diagnostics.push(`${label} must be a repository-relative path`)
    return null
  }
  const normalized = candidate.replaceAll('\\', '/')
  const absoluteRoot = resolve(root)
  const absolute = resolve(absoluteRoot, normalized)
  const rel = relative(absoluteRoot, absolute)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    diagnostics.push(
      `${label} must be repository-relative and inside the repository`,
    )
    return null
  }
  const canonical = rel.split(sep).join('/')
  if (
    canonical !== normalized ||
    normalized.includes('//') ||
    normalized.split('/').includes('.')
  ) {
    diagnostics.push(`${label} must be a normalized repository-relative path`)
    return null
  }
  if (
    allowedRoot &&
    canonical !== allowedRoot &&
    !canonical.startsWith(`${allowedRoot}/`)
  ) {
    diagnostics.push(`${label} must be inside ${allowedRoot}`)
    return null
  }
  return { absolute, relative: canonical }
}

async function regularFile(root, path, label, diagnostics) {
  if (!path) return false
  try {
    const stat = await lstat(path.absolute)
    if (stat.isSymbolicLink()) {
      diagnostics.push(`${label} '${path.relative}' must not be a symlink`)
      return false
    }
    if (!stat.isFile()) {
      diagnostics.push(`${label} '${path.relative}' must be a regular file`)
      return false
    }
    const real = await realpath(path.absolute)
    const rootReal = await realpath(root)
    const escaped = relative(rootReal, real)
    if (
      escaped === '..' ||
      escaped.startsWith(`..${sep}`) ||
      isAbsolute(escaped)
    ) {
      diagnostics.push(
        `${label} '${path.relative}' resolves outside the repository`,
      )
      return false
    }
    return true
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      diagnostics.push(`${label} '${path.relative}' does not exist`)
    } else {
      diagnostics.push(`${label} '${path.relative}' cannot be inspected`)
    }
    return false
  }
}

async function enumerateFiles(root, relativeRoot) {
  const output = []
  const visit = async (directory, prefix) => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = `${prefix}/${entry.name}`
      const absolutePath = resolve(root, relativePath)
      if (entry.isDirectory()) await visit(absolutePath, relativePath)
      else if (
        (entry.isFile() || entry.isSymbolicLink()) &&
        relativePath !== `${FIXTURE_ROOT}/manifest.json`
      )
        output.push(relativePath)
    }
  }
  await visit(resolve(root, relativeRoot), relativeRoot)
  return output
}

function evidenceLabel(id, index) {
  return `behavior '${id}' evidence ${index + 1}`
}

function isExecutableQualificationCommand(body, script) {
  if (typeof body !== 'string') return false
  const normalized = body.trim().replace(/\s+/gu, ' ')
  if (!normalized || new Set([':', 'true', 'exit 0']).has(normalized))
    return false
  if (
    normalized === `npm run ${script}` ||
    normalized === `npm run ${script} --`
  )
    return false
  if (/^(?:echo|printf)(?: .*)?$/u.test(normalized)) {
    if (!/[;&|]/u.test(normalized)) return false
  }
  return true
}

export async function fixtureContractDiagnostics({
  root,
  manifest,
  packageData = {},
  workflow = {},
}) {
  const diagnostics = []
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['manifest must be an object']
  }
  exactKeys(manifest, MANIFEST_KEYS, 'manifest', diagnostics)
  if (manifest.schemaVersion !== 1)
    diagnostics.push('manifest schemaVersion must be numeric 1')
  if (!Array.isArray(manifest.behaviors))
    diagnostics.push('manifest behaviors must be an array')
  else if (manifest.behaviors.length === 0)
    diagnostics.push('manifest behaviors must not be empty')
  if (!Array.isArray(manifest.gates))
    diagnostics.push('manifest gates must be an array')
  else if (manifest.gates.length === 0)
    diagnostics.push('manifest gates must not be empty')

  const behaviorIds = new Set()
  const fixtureOwners = new Map()
  for (const [index, behavior] of (Array.isArray(manifest.behaviors)
    ? manifest.behaviors
    : []
  ).entries()) {
    const fallbackId = `behavior ${index + 1}`
    exactKeys(
      behavior,
      behavior?.status === 'blocked' || behavior?.status === 'excluded'
        ? [...BEHAVIOR_KEYS, 'reason']
        : BEHAVIOR_KEYS,
      fallbackId,
      diagnostics,
    )
    const id = typeof behavior?.id === 'string' ? behavior.id : fallbackId
    if (typeof behavior?.id !== 'string' || !ID.test(behavior.id))
      diagnostics.push(
        `${fallbackId} id must be a lowercase dot-delimited identifier`,
      )
    if (behaviorIds.has(id)) diagnostics.push(`duplicate behavior id '${id}'`)
    behaviorIds.add(id)
    if (typeof behavior?.seam !== 'string' || !behavior.seam)
      diagnostics.push(`behavior '${id}' seam must be non-empty`)
    if (typeof behavior?.contract !== 'string' || !behavior.contract)
      diagnostics.push(`behavior '${id}' contract must be non-empty`)
    if (!STATUS.has(behavior?.status))
      diagnostics.push(
        `behavior '${id}' has unknown status '${behavior?.status}'`,
      )
    if (!Array.isArray(behavior?.modules))
      diagnostics.push(`behavior '${id}' modules must be an array`)
    else if (
      behavior.modules.length === 0 &&
      !['blocked', 'excluded'].includes(behavior?.status)
    )
      diagnostics.push(`behavior '${id}' modules must be a non-empty array`)
    else
      for (const [moduleIndex, modulePath] of behavior.modules.entries())
        if (typeof modulePath !== 'string' || !modulePath.trim())
          diagnostics.push(
            `behavior '${id}' module ${moduleIndex + 1} must be a non-empty string`,
          )
    if (!Array.isArray(behavior?.outcomes) || behavior.outcomes.length === 0)
      diagnostics.push(`behavior '${id}' outcomes must be a non-empty array`)
    else
      for (const [outcomeIndex, outcome] of behavior.outcomes.entries())
        if (typeof outcome !== 'string' || !outcome.trim())
          diagnostics.push(
            `behavior '${id}' outcome ${outcomeIndex + 1} must be a non-empty string`,
          )
    if (!Array.isArray(behavior?.evidence))
      diagnostics.push(`behavior '${id}' evidence must be an array`)
    else if (
      behavior.evidence.length === 0 &&
      !['blocked', 'excluded'].includes(behavior?.status)
    )
      diagnostics.push(`behavior '${id}' evidence must be a non-empty array`)
    if (
      (behavior?.status === 'blocked' || behavior?.status === 'excluded') &&
      (typeof behavior.reason !== 'string' || !behavior.reason.trim())
    )
      diagnostics.push(
        `behavior '${id}' ${behavior.status} status requires a non-empty reason`,
      )
    for (const [moduleIndex, modulePath] of (Array.isArray(behavior?.modules)
      ? behavior.modules
      : []
    ).entries()) {
      const module = repoPath(
        root,
        modulePath,
        `behavior '${id}' module ${moduleIndex + 1}`,
        diagnostics,
      )
      if (module)
        await regularFile(root, module, `behavior '${id}' module`, diagnostics)
    }
    const entries = Array.isArray(behavior?.evidence) ? behavior.evidence : []
    let vitestCount = 0
    let gateCount = 0
    for (const [evidenceIndex, evidence] of entries.entries()) {
      const label = evidenceLabel(id, evidenceIndex)
      if (
        !evidence ||
        typeof evidence !== 'object' ||
        Array.isArray(evidence)
      ) {
        diagnostics.push(`${label} must be an object`)
        continue
      }
      const kind = evidence.kind
      if (kind === 'vitest') {
        exactKeys(evidence, ['kind', 'file', 'testName'], label, diagnostics)
        const file = repoPath(root, evidence.file, `${label} file`, diagnostics)
        if (file) {
          await regularFile(root, file, `${label} file`, diagnostics)
        }
        if (typeof evidence.testName !== 'string' || !evidence.testName)
          diagnostics.push(`${label} testName must be non-empty`)
        vitestCount += 1
      } else if (kind === 'fixture') {
        exactKeys(evidence, ['kind', 'path'], label, diagnostics)
        const allowed = EVIDENCE_ROOTS.find(
          (prefix) =>
            typeof evidence.path === 'string' &&
            (evidence.path === prefix ||
              evidence.path.startsWith(`${prefix}/`)),
        )
        if (!allowed) {
          diagnostics.push(
            `${label} path must be inside test/fixtures/native or test/fixtures/reference`,
          )
          continue
        }
        const fixture = repoPath(
          root,
          evidence.path,
          `${label} path`,
          diagnostics,
          allowed,
        )
        if (fixture) {
          await regularFile(root, fixture, `${label} fixture`, diagnostics)
          const owners = fixtureOwners.get(fixture.relative) ?? []
          owners.push(id)
          fixtureOwners.set(fixture.relative, owners)
        }
      } else if (kind === 'gate') {
        gateCount += 1
        exactKeys(evidence, ['kind', 'gate'], label, diagnostics)
        if (typeof evidence.gate !== 'string' || !evidence.gate)
          diagnostics.push(`${label} gate must be non-empty`)
      } else {
        diagnostics.push(`${label} has unknown evidence kind '${kind}'`)
      }
    }
    if (
      behavior?.status === 'qualified' &&
      vitestCount === 0 &&
      gateCount === 0
    )
      diagnostics.push(
        `qualified behavior '${id}' requires at least one Vitest or gate evidence`,
      )
    if (
      (behavior?.status === 'blocked' || behavior?.status === 'excluded') &&
      entries.length > 0
    )
      diagnostics.push(
        `behavior '${id}' with status ${behavior.status} may not pretend to pass with executable evidence`,
      )
    if (
      (behavior?.status === 'blocked' || behavior?.status === 'excluded') &&
      vitestCount > 0
    )
      diagnostics.push(
        `behavior '${id}' with status ${behavior.status} may not pretend to pass with Vitest evidence`,
      )
  }

  const gateIds = new Set()
  for (const [index, gate] of (Array.isArray(manifest.gates)
    ? manifest.gates
    : []
  ).entries()) {
    const label = `gate ${index + 1}`
    exactKeys(gate, ['id', 'script', 'ciJob'], label, diagnostics)
    const id = typeof gate?.id === 'string' ? gate.id : label
    if (typeof gate?.id !== 'string' || !gate.id.trim())
      diagnostics.push(`${label} id must be a non-empty string`)
    if (gateIds.has(id)) diagnostics.push(`duplicate gate id '${id}'`)
    gateIds.add(id)
    const hasPackageScript =
      typeof gate?.script === 'string' &&
      Object.hasOwn(packageData?.scripts ?? {}, gate.script)
    if (!hasPackageScript)
      diagnostics.push(
        `gate '${id}' references unknown package script '${gate?.script}'`,
      )
    else if (
      !isExecutableQualificationCommand(
        packageData.scripts[gate.script],
        gate.script,
      )
    )
      diagnostics.push(
        `gate '${id}' package script '${gate.script}' is not an executable qualification command`,
      )
    if (
      typeof gate?.ciJob !== 'string' ||
      !Object.hasOwn(workflow?.jobs ?? {}, gate.ciJob)
    )
      diagnostics.push(
        `gate '${id}' references unknown CI job '${gate?.ciJob}'`,
      )
    else {
      const steps = workflow.jobs[gate.ciJob]?.steps
      const runs = Array.isArray(steps)
        ? steps
            .map((step) => (typeof step?.run === 'string' ? step.run : ''))
            .join('\n')
        : ''
      if (
        !runs.split(/\s+/u).includes(`npm`) ||
        !runs.includes(`npm run ${gate.script}`)
      )
        diagnostics.push(
          `gate '${id}' CI job '${gate.ciJob}' does not run npm run ${gate.script}`,
        )

      const required = workflow?.jobs?.required
      if (
        !required ||
        typeof required !== 'object' ||
        Array.isArray(required)
      ) {
        diagnostics.push(
          `gate '${id}' CI job '${gate.ciJob}' is not enforced by jobs.required`,
        )
      } else {
        if (
          !Array.isArray(required.needs) ||
          !required.needs.includes(gate.ciJob)
        )
          diagnostics.push(
            `gate '${id}' CI job '${gate.ciJob}' is not required by jobs.required`,
          )
        const requiredSteps = Array.isArray(required.steps)
          ? required.steps
          : []
        const resultExpression = '${{ needs.' + gate.ciJob + '.result }}'
        const resultEnvEntries = requiredSteps.flatMap((step) =>
          Object.entries(step?.env ?? {})
            .filter(([, value]) => value === resultExpression)
            .map(([envKey]) => ({ envKey, step })),
        )
        if (resultEnvEntries.length === 0) {
          diagnostics.push(
            `gate '${id}' CI job '${gate.ciJob}' required result is not exported by jobs.required`,
          )
        } else {
          for (const { envKey, step } of resultEnvEntries) {
            const asserted =
              typeof step?.run === 'string' &&
              step.run.includes(`test "$${envKey}" = success`)
            if (!asserted)
              diagnostics.push(
                `gate '${id}' CI job '${gate.ciJob}' required result ${envKey} is not asserted`,
              )
          }
        }
      }
    }
  }
  for (const behavior of Array.isArray(manifest.behaviors)
    ? manifest.behaviors
    : []) {
    for (const evidence of Array.isArray(behavior?.evidence)
      ? behavior.evidence
      : []) {
      if (
        evidence.kind === 'gate' &&
        typeof evidence.gate === 'string' &&
        !gateIds.has(evidence.gate)
      )
        diagnostics.push(
          `behavior '${behavior.id}' references unknown gate '${evidence.gate}'`,
        )
    }
  }

  const allFixtureFiles = (
    await Promise.all([enumerateFiles(root, FIXTURE_ROOT)])
  ).flat()
  for (const path of allFixtureFiles) {
    const owners = fixtureOwners.get(path) ?? []
    if (owners.length === 0)
      diagnostics.push(`orphan fixture '${path}' has no owning evidence`)
    else if (owners.length !== 1)
      diagnostics.push(
        `fixture '${path}' must have exactly one owning evidence (found ${owners.length})`,
      )
  }
  for (const [path, owners] of fixtureOwners)
    if (owners.length !== 1) {
      diagnostics.push(
        `fixture evidence '${path}' must have exactly one owner (found ${owners.length})`,
      )
      diagnostics.push(
        `fixture '${path}' is owned by ${new Set(owners).size} behaviors via ${owners.length} evidence entries`,
      )
    }
  return [...new Set(diagnostics)].sort((a, b) => a.localeCompare(b))
}

export async function loadFixtureContractContext(root) {
  const context = {
    root,
    manifest: null,
    packageData: {},
    workflow: {},
    loadDiagnostics: [],
  }
  try {
    context.manifest = JSON.parse(
      await readFile(resolve(root, 'test/fixtures/manifest.json'), 'utf8'),
    )
  } catch {
    context.loadDiagnostics.push('manifest JSON could not be read or parsed')
  }
  try {
    context.packageData = JSON.parse(
      await readFile(resolve(root, 'package.json'), 'utf8'),
    )
  } catch {
    context.loadDiagnostics.push('package.json could not be read or parsed')
  }
  try {
    const { parse } = await import('yaml')
    context.workflow = parse(
      await readFile(resolve(root, '.github/workflows/ci.yml'), 'utf8'),
    )
  } catch {
    context.loadDiagnostics.push('CI workflow YAML could not be read or parsed')
  }
  return context
}

export async function validateFixtureContracts(root) {
  const context = await loadFixtureContractContext(root)
  const diagnostics = [
    ...context.loadDiagnostics,
    ...(context.manifest
      ? await fixtureContractDiagnostics(context)
      : ['manifest must be an object']),
  ]
  return {
    root: context.root,
    manifest: context.manifest,
    packageData: context.packageData,
    workflow: context.workflow,
    diagnostics: [...new Set(diagnostics)].sort((a, b) => a.localeCompare(b)),
    vitestEvidence: collectVitestEvidence(context.manifest),
  }
}

export function collectVitestEvidence(manifest) {
  if (!Array.isArray(manifest?.behaviors)) return []
  return manifest.behaviors.flatMap((behavior) => {
    if (!behavior || typeof behavior !== 'object' || Array.isArray(behavior))
      return []
    if (!Array.isArray(behavior.evidence)) return []
    return behavior.evidence
      .filter(
        (evidence) =>
          evidence &&
          typeof evidence === 'object' &&
          evidence.kind === 'vitest',
      )
      .map((evidence) => ({ behaviorId: behavior.id, ...evidence }))
  })
}
