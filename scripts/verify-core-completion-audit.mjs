import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = process.cwd()
const report = await readFile(
  resolve(root, 'docs/CORE_COMPLETION_AUDIT.md'),
  'utf8',
)
const errors = []
const statuses = [
  'implemented',
  'qualified',
  'blocked',
  'deferred',
  'out-of-scope',
  'failed',
]
for (const status of statuses)
  if (!report.includes(`\`${status}\``))
    errors.push(`missing status token: ${status}`)
if (!report.includes('<!-- core-completion-verdict:blocked -->'))
  errors.push('missing blocked aggregate marker')
if (!/implemented.*qualified|qualified.*implemented/s.test(report))
  errors.push('implemented/qualified distinction missing')
for (const term of [
  'native',
  'Claude adapter',
  'Team',
  'Swarm',
  'migration',
  'deletion',
  'observability',
  'package',
  'performance',
  'security',
  'PTY',
  'screen-reader',
])
  if (!report.toLowerCase().includes(term.toLowerCase()))
    errors.push(`missing required topic: ${term}`)

const rowRe =
  /^\|\s*(\d+)\s*\|\s*[^|]+\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/gm
const rows = [...report.matchAll(rowRe)].filter((m) => /^\d+$/.test(m[1]))
const seen = new Set()
for (const [, number, rawStatus, evidence, note] of rows) {
  const n = Number(number)
  if (n < 1 || n > 56) continue
  if (seen.has(n)) errors.push(`duplicate story row: ${n}`)
  seen.add(n)
  const status = rawStatus.trim()
  if (!statuses.includes(status))
    errors.push(`unknown status for story ${n}: ${status}`)
  if (
    !/`(?:src\/|scripts\/|docs\/|README(?:_[^`]+)?|CONTEXT\.md|package\.json|CONTRIBUTING\.md)[^`]*`/.test(
      evidence,
    )
  )
    errors.push(`story ${n} lacks local evidence path`)
  const paths = [...evidence.matchAll(/`([^`]+)`/g)]
    .map((m) => m[1])
    .filter((p) =>
      /^(?:src\/|scripts\/|docs\/|README|CONTEXT\.md|package\.json|CONTRIBUTING\.md)/.test(
        p,
      ),
    )
  for (const p of paths) {
    try {
      await access(resolve(root, p))
    } catch {
      errors.push(`story ${n} evidence missing: ${p}`)
    }
  }
  if (
    status === 'qualified' &&
    /blocked|skipped|unavailable|missing|credential|binary|environment-gated/i.test(
      note,
    )
  )
    errors.push(`qualified story ${n} contradicts qualification note`)
}
for (let n = 1; n <= 56; n++)
  if (!seen.has(n)) errors.push(`missing story row: ${n}`)

const lanes = [
  'native fixtures',
  'adapter fixtures',
  'pinned zero-skip live compatibility',
  'package',
  'security/audit',
  'performance',
  'migration',
  'deletion',
  'PTY',
  'screen-reader',
]
for (const lane of lanes) {
  const lanePattern = new RegExp(
    `^\\|\\s*${lane.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*\\|`,
    'i',
  )
  const line = report.split('\n').find((l) => lanePattern.test(l))
  if (!line) {
    errors.push(`missing qualification lane: ${lane}`)
    continue
  }
  const cols = line
    .split('|')
    .map((x) => x.trim())
    .filter(Boolean)
  if (cols.length < 4) {
    errors.push(`malformed qualification lane: ${lane}`)
    continue
  }
  const command = cols[2].replaceAll('`', '')
  const match = command.match(/^npm run ([\w:-]+)/)
  if (match) {
    const pkg = JSON.parse(
      await readFile(resolve(root, 'package.json'), 'utf8'),
    )
    if (!pkg.scripts?.[match[1]])
      errors.push(`lane ${lane} references missing npm script: ${match[1]}`)
  }
}
if (errors.length) {
  console.error(`core completion audit failed (${errors.length})`)
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}
console.log(
  `core completion audit passed: ${seen.size} stories, ${lanes.length} qualification lanes, aggregate blocked`,
)
