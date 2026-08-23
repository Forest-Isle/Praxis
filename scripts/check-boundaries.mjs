import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { scanSourceBoundaries } from './lib/source-boundaries.mjs'

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
const sourceFiles = (await filesBelow(sourceRoot)).filter((path) =>
  ['.ts', '.tsx'].includes(extname(path)),
)

const sourceEntries = await Promise.all(
  sourceFiles.map(async (path) => ({
    projectPath: relative(root, path).split(sep).join('/'),
    source: await readFile(path, 'utf8'),
  })),
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
}

for (const failure of scanSourceBoundaries(sourceEntries)) {
  failures.push(failure)
}

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exitCode = 1
}
