import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const projectRoot = process.cwd()
const packageDocument = JSON.parse(
  await readFile(join(projectRoot, 'package.json'), 'utf8'),
)
const excluded = new Set([
  'test:compat:all',
  'test:package',
  'test:performance',
])
const entrypoints = []
const seen = new Set()

for (const [name, command] of Object.entries(packageDocument.scripts ?? {})) {
  if (!name.startsWith('test:') || excluded.has(name)) continue
  const parts = String(command).split(' && ')
  if (parts.shift() !== 'npm run build' || parts.length === 0) {
    throw new Error(`${name} does not follow compatibility gate command shape`)
  }
  for (const part of parts) {
    const match = /^node (scripts\/[a-z0-9-]+\.mjs)$/u.exec(part)
    if (!match) {
      throw new Error(`${name} has unsupported compatibility command: ${part}`)
    }
    const file = match[1]
    if (seen.has(file)) throw new Error(`Duplicate compatibility gate: ${file}`)
    seen.add(file)
    entrypoints.push({ name, file })
  }
}

if (entrypoints.length === 0)
  throw new Error('No compatibility gates discovered')

function run({ name, file }, index) {
  return new Promise((resolve, reject) => {
    const label = `${index + 1}/${entrypoints.length} ${name}: ${file}`
    console.log(`\n[compatibility ${label}]`)
    const child = spawn(process.execPath, [file], {
      cwd: projectRoot,
      env: process.env,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else {
        reject(
          new Error(
            `${file} failed${signal ? ` with signal ${signal}` : ` with exit ${code}`}`,
          ),
        )
      }
    })
  })
}

const startedAt = Date.now()
for (const [index, entrypoint] of entrypoints.entries()) {
  await run(entrypoint, index)
}
console.log(
  `\nCompatibility matrix passed: ${entrypoints.length} isolated gates in ${(
    (Date.now() - startedAt) /
    1000
  ).toFixed(1)}s.`,
)
