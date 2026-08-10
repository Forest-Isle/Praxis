import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const excludedDirectories = new Set([
  '.git',
  '.worktrees',
  'coverage',
  'dist',
  'node_modules',
])
const requiredDocuments = [
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'SUPPORT.md',
  'THIRD_PARTY_NOTICES.md',
  'docs/README.md',
]

async function markdownFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await markdownFiles(path)))
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path)
  }
  return files
}

function localTargets(source) {
  const targets = []
  const patterns = [
    /!?(?:\[[^\]]*\])\(([^)]+)\)/gu,
    /^\s*\[[^\]]+\]:\s*(\S+)/gmu,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      let target = match[1]?.trim() ?? ''
      if (target.startsWith('<') && target.endsWith('>')) {
        target = target.slice(1, -1)
      } else {
        target = target.split(/\s+/u)[0] ?? ''
      }
      if (
        target.length === 0 ||
        target.startsWith('#') ||
        /^[a-z][a-z0-9+.-]*:/iu.test(target)
      ) {
        continue
      }
      targets.push(target)
    }
  }
  return targets
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

const failures = []
for (const document of requiredDocuments) {
  if (!(await exists(resolve(root, document)))) {
    failures.push(`Missing required project document: ${document}`)
  }
}

const files = await markdownFiles(root)
let links = 0
for (const file of files) {
  const source = await readFile(file, 'utf8')
  for (const target of localTargets(source)) {
    links += 1
    const path = decodeURIComponent(target.split(/[?#]/u)[0] ?? '')
    const resolved = resolve(dirname(file), path)
    const repositoryPath = relative(root, resolved)
    if (repositoryPath === '..' || repositoryPath.startsWith(`..${sep}`)) {
      failures.push(
        `${relative(root, file).split(sep).join('/')}: local link escapes repository ${target}`,
      )
      continue
    }
    if (!(await exists(resolved))) {
      failures.push(
        `${relative(root, file).split(sep).join('/')}: broken local link ${target}`,
      )
    }
  }
}

if (failures.length > 0) {
  throw new Error(`Documentation verification failed:\n${failures.join('\n')}`)
}

console.log(
  `Documentation verification passed: ${files.length} Markdown files, ${links} local links`,
)
