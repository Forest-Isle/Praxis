import { spawn } from 'node:child_process'

const runner = new URL(
  './verify-active-stream-performance.mjs',
  import.meta.url,
)
const child = spawn(process.execPath, ['--expose-gc', runner.pathname], {
  env: { ...process.env, PRAXIS_ACTIVE_STREAM_INJECT_MS: '60' },
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
const exitCode = await new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('close', resolve)
})
if (exitCode === 0)
  throw new Error('Injected active-stream regression unexpectedly passed')
if (!stdout.trim())
  throw new Error(`Injected runner produced no result: ${stderr.trim()}`)
const result = JSON.parse(stdout.trim())
if (result.limitMs !== 50 || result.p95Ms <= 50) {
  throw new Error(
    `Injected active-stream regression was not rejected: ${stdout.trim()} ${stderr.trim()}`,
  )
}
process.stdout.write(
  `Active-stream injection rejected at ${result.p95Ms.toFixed(1)}ms/${result.limitMs}ms\n`,
)
