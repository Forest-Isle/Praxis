import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const releaseRef = process.argv[2]
const outputDirectory = resolve(process.argv[3] ?? 'release')

if (!releaseRef) {
  throw new Error(
    'usage: npm run release:artifacts -- <tag> [output-directory]',
  )
}

await run(process.execPath, [
  resolve(root, 'scripts/verify-release-ref.mjs'),
  releaseRef,
])
await run('npm', ['run', 'build'])
await rm(outputDirectory, { recursive: true, force: true })
await mkdir(outputDirectory, { recursive: true })

const packDirectory = await mkdtemp(resolve(tmpdir(), 'praxis-pack-'))
try {
  const packResult = await run('npm', [
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    packDirectory,
  ])
  const [packed] = JSON.parse(packResult)
  if (!packed?.filename) {
    throw new Error('npm pack did not report an artifact filename')
  }

  const sourceTarball = resolve(packDirectory, packed.filename)
  const targetTarball = resolve(outputDirectory, basename(packed.filename))
  await writeFile(targetTarball, await readFile(sourceTarball))

  const sbom = await run('npm', [
    'sbom',
    '--package-lock-only',
    '--omit',
    'dev',
    '--sbom-format',
    'cyclonedx',
  ])
  const sbomPath = resolve(
    outputDirectory,
    `${packed.filename.replace(/\.tgz$/, '')}.sbom.cdx.json`,
  )
  await writeFile(sbomPath, `${sbom.trimEnd()}\n`, 'utf8')

  const artifacts = [targetTarball, sbomPath]
  const checksums = []
  for (const artifact of artifacts) {
    const digest = createHash('sha256')
      .update(await readFile(artifact))
      .digest('hex')
    checksums.push(`${digest}  ${basename(artifact)}`)
  }
  await writeFile(
    resolve(outputDirectory, 'SHA256SUMS'),
    `${checksums.join('\n')}\n`,
    'utf8',
  )

  process.stdout.write(
    `created ${artifacts.map((artifact) => basename(artifact)).join(', ')} and SHA256SUMS\n`,
  )
} finally {
  await rm(packDirectory, { recursive: true, force: true })
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', rejectRun)
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolveRun(Buffer.concat(stdout).toString('utf8'))
        return
      }
      rejectRun(
        new Error(
          `${command} ${args.join(' ')} failed (${signal ?? code})\n${Buffer.concat(stderr).toString('utf8')}`,
        ),
      )
    })
  })
}
