import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SUMMARY_PATH = 'coverage/coverage-summary.json'

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const relativePath = (filePath, root) => {
  const absolute = path.resolve(root, filePath)
  const relative = path.relative(root, absolute)
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null
  }
  return relative.split(path.sep).join('/')
}

const isValidMetric = (metric) =>
  isRecord(metric) &&
  Number.isInteger(metric.total) &&
  metric.total >= 0 &&
  Number.isInteger(metric.covered) &&
  metric.covered >= 0 &&
  metric.covered <= metric.total

export async function discoverProductionPaths(repositoryRoot = process.cwd()) {
  const sourceRoot = path.join(repositoryRoot, 'src')
  const paths = []
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') await visit(fullPath)
      } else if (
        entry.isFile() &&
        /\.tsx?$/.test(entry.name) &&
        !/\.test\.[^.]+$/.test(entry.name) &&
        !/\.spec\.[^.]+$/.test(entry.name) &&
        !/\.d\.ts$/.test(entry.name)
      ) {
        paths.push(
          path.relative(repositoryRoot, fullPath).split(path.sep).join('/'),
        )
      }
    }
  }
  await visit(sourceRoot)
  return paths.sort()
}

export function diagnoseCoverageSummary(
  summary,
  repositoryRoot,
  expectedPaths,
) {
  const errors = []
  const expected = new Set()
  if (!Array.isArray(expectedPaths) || expectedPaths.length === 0) {
    errors.push('expected production path collection must not be empty')
  } else {
    for (const expectedPath of expectedPaths) {
      if (typeof expectedPath !== 'string') {
        errors.push('expected production paths must be strings')
        continue
      }
      const normalized = relativePath(expectedPath, repositoryRoot)
      if (normalized === null || !normalized.startsWith('src/')) {
        errors.push(`expected production path is outside src/: ${expectedPath}`)
      } else if (expected.has(normalized)) {
        errors.push(`duplicate expected production path: ${normalized}`)
      } else expected.add(normalized)
    }
  }
  if (!isRecord(summary)) {
    errors.push('coverage summary must be an object')
    return {
      ok: false,
      checkedRuntimeModules: 0,
      zeroCovered: [],
      errors: errors.sort(),
    }
  }

  const productionEntries = []
  const entriesByPath = new Map()
  for (const [entryPath, entry] of Object.entries(summary)) {
    if (entryPath === 'total') continue
    const normalized = relativePath(entryPath, repositoryRoot)
    if (normalized === null) {
      errors.push(`coverage entry is outside the repository: ${entryPath}`)
      continue
    }
    if (!normalized.startsWith('src/')) continue
    if (entriesByPath.has(normalized)) {
      errors.push(`duplicate coverage entry: ${normalized}`)
      continue
    }
    entriesByPath.set(normalized, entry)
    if (!isRecord(entry) || !isValidMetric(entry.statements)) {
      errors.push(`malformed statement metrics for ${normalized}`)
      continue
    }
    productionEntries.push({ path: normalized, statements: entry.statements })
  }

  if (productionEntries.length === 0)
    errors.push(
      'coverage summary contains no production file entries under src/',
    )
  const missing = [...expected]
    .filter((filePath) => !entriesByPath.has(filePath))
    .sort()
  if (missing.length > 0)
    errors.push(`missing coverage entries: ${missing.join(', ')}`)
  const zeroCovered = productionEntries
    .filter(
      ({ statements }) => statements.total > 0 && statements.covered === 0,
    )
    .map(({ path: filePath }) => filePath)
    .sort()
  if (zeroCovered.length > 0)
    errors.push(`zero-covered runtime modules: ${zeroCovered.join(', ')}`)

  return {
    ok: errors.length === 0,
    checkedRuntimeModules: productionEntries.filter(
      ({ statements }) => statements.total > 0,
    ).length,
    zeroCovered,
    errors: errors.sort(),
  }
}

export async function readAndDiagnoseCoverageSummary(
  summaryPath = SUMMARY_PATH,
  repositoryRoot = process.cwd(),
) {
  let contents
  try {
    contents = await readFile(summaryPath, 'utf8')
  } catch (error) {
    return {
      ok: false,
      checkedRuntimeModules: 0,
      zeroCovered: [],
      errors: [`unable to read coverage summary: ${error.message}`],
    }
  }
  let summary
  try {
    summary = JSON.parse(contents)
  } catch (error) {
    return {
      ok: false,
      checkedRuntimeModules: 0,
      zeroCovered: [],
      errors: [`invalid coverage summary JSON: ${error.message}`],
    }
  }
  let expectedPaths
  try {
    expectedPaths = await discoverProductionPaths(repositoryRoot)
  } catch (error) {
    return {
      ok: false,
      checkedRuntimeModules: 0,
      zeroCovered: [],
      errors: [`unable to discover production paths: ${error.message}`],
    }
  }
  return diagnoseCoverageSummary(summary, repositoryRoot, expectedPaths)
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const result = await readAndDiagnoseCoverageSummary(
    process.argv[2] ?? SUMMARY_PATH,
  )
  if (result.ok) {
    console.log(
      `Nonzero runtime coverage verified for ${result.checkedRuntimeModules} runtime modules.`,
    )
  } else {
    console.error('Nonzero runtime coverage verification failed:')
    for (const error of result.errors) console.error(`- ${error}`)
    process.exitCode = 1
  }
}
