import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const praxis = spawnSync(
  process.execPath,
  [resolve('dist/cli.js'), 'plugin', 'eval', '--help'],
  { encoding: 'utf8' },
)
if (praxis.status !== 0)
  throw new Error(praxis.stderr || 'Praxis plugin eval help failed')

const required = [
  '--ablation',
  '--allow-tools',
  '--case',
  '--judge-model',
  '--keep-temp',
  '--max-cost-usd',
  '--no-scaffold',
  '--output-dir',
  '--runs',
  '--scaffold',
  '--tag',
  '--threshold',
]
for (const option of required)
  if (!praxis.stdout.includes(option))
    throw new Error(`Praxis help missing ${option}`)

const claude = spawnSync('claude', ['plugin', 'eval', '--help'], {
  encoding: 'utf8',
  env: { ...process.env, DISABLE_AUTOUPDATER: '1' },
})
if (claude.error?.code !== 'ENOENT') {
  if (claude.status !== 0)
    throw new Error(claude.stderr || 'Claude plugin eval help failed')
  for (const option of required)
    if (!claude.stdout.includes(option))
      throw new Error(`Claude 2.1.208 help missing expected ${option}`)
}

process.stdout.write('plugin eval compatibility surface verified\n')
