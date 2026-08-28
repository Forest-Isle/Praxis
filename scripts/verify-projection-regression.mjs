import { spawn } from 'node:child_process'
const runner = new URL('./verify-projection-scaling.mjs', import.meta.url)
const child = spawn(process.execPath, ['--expose-gc', runner.pathname], {
  env: { ...process.env, PRAXIS_PROJECTION_INJECT_MS: '1100' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => {
  stdout += chunk
})
child.stderr.on('data', (chunk) => {
  stderr += chunk
})
const code = await new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('close', resolve)
})
if (code === 0)
  throw new Error('Injected projection regression unexpectedly passed')
const result = JSON.parse(stdout.trim())
if (
  result.projectionRatio120k <= result.ratioLimit &&
  result.projectionMedians[2] <= result.medianLimitMs
)
  throw new Error(
    `Injected projection regression was not rejected: ${stdout.trim()} ${stderr.trim()}`,
  )
process.stdout.write(
  `Projection injection rejected at ${result.projectionRatio120k.toFixed(2)}x/${result.ratioLimit.toFixed(2)}x, ${result.projectionMedians[2].toFixed(1)}ms/${result.medianLimitMs}ms\n`,
)
