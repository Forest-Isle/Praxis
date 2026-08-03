import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url))
const forbiddenProductDirectories = [
  'billing',
  'enterprise',
  'organizations',
  'remote-control',
  'telemetry',
  'tenants',
]
const forbiddenCoreImports = [
  /^node:/,
  /(?:^|\/)persistence(?:\/|$)/,
  /(?:^|\/)platform(?:\/|$)/,
  /(?:^|\/)providers(?:\/|$)/,
  /^ink$/,
  /^react$/,
]

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? filesBelow(path) : [path]
    }),
  )
  return nested.flat()
}

const failures = []
const sourceFiles = (await filesBelow(sourceRoot)).filter(
  (path) => extname(path) === '.ts',
)

for (const path of sourceFiles) {
  const projectPath = relative(root, path).split(sep).join('/')
  const topLevelDirectory = projectPath.split('/')[1]
  if (
    topLevelDirectory &&
    forbiddenProductDirectories.includes(topLevelDirectory)
  ) {
    failures.push(`${projectPath}: forbidden product domain`)
  }

  if (!projectPath.startsWith('src/core/')) continue

  const source = await readFile(path, 'utf8')
  const imports = source.matchAll(/from\s+['"]([^'"]+)['"]/g)
  for (const match of imports) {
    const specifier = match[1]
    if (
      specifier &&
      forbiddenCoreImports.some((pattern) => pattern.test(specifier))
    ) {
      failures.push(`${projectPath}: core cannot import ${specifier}`)
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exitCode = 1
}
