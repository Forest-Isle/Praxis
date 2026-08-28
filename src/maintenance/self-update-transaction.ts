import { createHash, randomUUID } from 'node:crypto'
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  symlink,
} from 'node:fs/promises'
import { dirname, basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ExclusiveFileLease } from '../platform/exclusive-file-lease.js'

export interface SelfUpdateLayout {
  packageRoot: string
  globalNodeModulesRoot: string
  globalPrefix: string
  binPath: string
}

export interface TransactionRunnerOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeout?: number
  maxBuffer?: number
  signal?: AbortSignal
}

export type TransactionRunner = (
  executable: string,
  args: readonly string[],
  options: TransactionRunnerOptions,
) => Promise<{ stdout: string; stderr: string }>

export interface SelfUpdateTransactionOptions {
  packageName: string
  target: string
  force: boolean
  npmExecutable: string
  timeoutMs: number
  signal?: AbortSignal
  run: TransactionRunner
  layout?: SelfUpdateLayout
}

export interface SelfUpdateTransactionResult {
  output: string
}

/** Transactional updater implementation. */
export async function runSelfUpdateTransaction(
  options: SelfUpdateTransactionOptions,
): Promise<SelfUpdateTransactionResult> {
  if (process.platform === 'win32')
    throw new Error('self-update is unsupported on Windows')
  options.signal?.throwIfAborted()
  const layout = validateSelfUpdateLayout(options.layout ?? deriveLayout())
  if (
    layout.packageRoot !==
    join(layout.globalNodeModulesRoot, options.packageName)
  )
    throw new Error(
      'current package is not installed in the requested global layout',
    )
  const parent = dirname(layout.packageRoot)
  const lockPath = `${layout.packageRoot}.update.lock`
  let owner
  try {
    owner = await new ExclusiveFileLease(lockPath).tryAcquire()
  } catch (error) {
    throw normalizeTransactionError(error)
  }
  if (!owner) throw new Error('Praxis update already in progress')
  let backup = ''
  let staging = ''
  const journal = `${layout.packageRoot}.update.journal`
  try {
    await validateCandidate(layout.packageRoot, options.packageName)
    options.signal?.throwIfAborted()
    const spec = `${options.packageName}@${options.target}`
    const view = await options.run(
      options.npmExecutable,
      ['view', spec, 'version', 'dist', '--json'],
      runnerOptions(options),
    )
    const metadata = parseView(view.stdout, options.packageName)
    staging = await mkdtemp(join(parent, '.praxis-update-'))
    await chmod(staging, 0o700)
    const download = join(staging, 'download')
    await mkdir(download, { recursive: true, mode: 0o700 })
    await chmod(download, 0o700)
    const packed = await options.run(
      options.npmExecutable,
      [
        'pack',
        spec,
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        download,
      ],
      runnerOptions(options),
    )
    const pack = parsePack(
      packed.stdout,
      metadata,
      download,
      options.packageName,
    )
    const bytes = await readFile(pack.path)
    const sums = checksum(bytes)
    if (sums.sha512 !== metadata.integrity || sums.sha1 !== metadata.shasum)
      throw new Error('package integrity/checksum mismatch')
    const stagingPrefix = join(staging, 'prefix')
    await mkdir(stagingPrefix, { recursive: true, mode: 0o700 })
    await chmod(stagingPrefix, 0o700)
    const installArgs = [
      'install',
      '--global',
      '--prefix',
      stagingPrefix,
      '--no-fund',
      '--no-audit',
      '--ignore-scripts',
      ...(options.force ? ['--force'] : []),
      pack.path,
    ]
    await options.run(
      options.npmExecutable,
      installArgs,
      runnerOptions(options),
    )
    const candidate = join(
      stagingPrefix,
      'lib',
      'node_modules',
      options.packageName,
    )
    await validateCandidate(candidate, options.packageName, metadata.version)
    await gate(options, join(candidate, 'dist', 'cli.js'), metadata.version)
    options.signal?.throwIfAborted()
    backup = `${layout.packageRoot}.update-backup-${randomUUID()}`
    await installLauncher(layout, lockPath, journal)
    await writeJournal(journal, {
      version: 1,
      root: layout.packageRoot,
      backup,
      staging,
      targetVersion: metadata.version,
      phase: 'prepared',
    })
    await rename(layout.packageRoot, backup)
    await rename(candidate, layout.packageRoot)
    await syncDirectory(parent)
    await writeJournal(journal, {
      version: 1,
      root: layout.packageRoot,
      backup,
      staging,
      targetVersion: metadata.version,
      phase: 'candidate',
    })
    await gate(
      options,
      join(layout.packageRoot, 'dist', 'cli.js'),
      metadata.version,
    )
    await cleanupCompletedTransaction(backup, staging, journal)
    return { output: 'completed' }
  } catch (error) {
    const failure = normalizeTransactionError(error)
    if (backup) {
      try {
        await rollback(layout.packageRoot, backup, staging, journal)
      } catch (recovery) {
        const recoveryFailure = normalizeTransactionError(recovery)
        throw new Error(
          `${failure instanceof Error ? failure.message : String(failure)}; recovery failed: ${recoveryFailure instanceof Error ? recoveryFailure.message : String(recoveryFailure)}`,
          { cause: failure },
        )
      }
    } else if (staging) await cleanupCompletedTransaction('', staging, journal)
    throw failure
  } finally {
    await releaseLease(owner)
  }
}

function deriveLayout(): SelfUpdateLayout {
  const packageRoot = resolve(
    process.env.PRAXIS_SELF_UPDATE_ROOT ??
      dirname(fileURLToPath(import.meta.url)),
    process.env.PRAXIS_SELF_UPDATE_ROOT ? '.' : '../..',
  )
  const globalNodeModulesRoot = dirname(packageRoot)
  const globalPrefix = dirname(dirname(globalNodeModulesRoot))
  return {
    packageRoot,
    globalNodeModulesRoot,
    globalPrefix,
    binPath: join(globalPrefix, 'bin', 'praxis'),
  }
}
function runnerOptions(
  options: SelfUpdateTransactionOptions,
): TransactionRunnerOptions {
  return {
    env: process.env,
    timeout: options.timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    ...(options.signal ? { signal: options.signal } : {}),
  }
}
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('invalid npm metadata')
  }
}
function semver(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(
      value,
    )
  )
}
function parseView(
  text: string,
  name: string,
): { version: string; integrity: string; shasum: string; tarball: string } {
  const value = parseJson(text) as Record<string, unknown>
  const dist = value.dist as Record<string, unknown> | undefined
  if (
    !semver(value.version) ||
    !dist ||
    typeof dist.tarball !== 'string' ||
    !/^https:\/\//u.test(dist.tarball) ||
    typeof dist.integrity !== 'string' ||
    !/^sha512-[A-Za-z0-9+/]+=*$/u.test(dist.integrity) ||
    typeof dist.shasum !== 'string' ||
    !/^[0-9a-f]{40}$/iu.test(dist.shasum)
  )
    throw new Error(`invalid metadata for ${name}`)
  return {
    version: value.version,
    integrity: dist.integrity,
    shasum: dist.shasum.toLowerCase(),
    tarball: dist.tarball,
  }
}
function parsePack(
  text: string,
  metadata: { version: string; integrity: string; shasum: string },
  dir: string,
  packageName: string,
): { path: string } {
  const value = parseJson(text)
  if (!Array.isArray(value) || value.length !== 1)
    throw new Error('invalid npm pack metadata')
  const record = value[0] as Record<string, unknown>
  if (
    record.version !== metadata.version ||
    record.name !== packageName ||
    record.integrity !== metadata.integrity ||
    String(record.shasum).toLowerCase() !== metadata.shasum ||
    typeof record.filename !== 'string' ||
    basename(record.filename) !== record.filename ||
    !record.filename.endsWith('.tgz')
  )
    throw new Error('npm pack metadata mismatch')
  return { path: join(dir, record.filename) }
}
async function validateCandidate(
  root: string,
  name: string,
  expectedVersion?: string,
): Promise<string> {
  const manifest = parseJson(
    await readFile(join(root, 'package.json'), 'utf8'),
  ) as Record<string, unknown>
  const cli = await stat(join(root, 'dist', 'cli.js'))
  if (
    manifest.name !== name ||
    !semver(manifest.version) ||
    (expectedVersion !== undefined && manifest.version !== expectedVersion) ||
    !cli.isFile()
  )
    throw new Error('staged package validation failed')
  return manifest.version
}
async function gate(
  options: SelfUpdateTransactionOptions,
  cli: string,
  version: string,
) {
  const result = await options.run(
    process.execPath,
    [cli, '--version'],
    runnerOptions(options),
  )
  if (result.stdout.trim() !== version)
    throw new Error('candidate version gate failed')
}
async function writeJournal(path: string, value: object) {
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    const handle = await open(tmp, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(value))
      await handle.chmod(0o600)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, path)
    await syncDirectory(dirname(path))
  } finally {
    await rm(tmp, { force: true })
  }
}
async function rollback(
  root: string,
  backup: string,
  staging: string,
  journal: string,
) {
  if (await exists(backup)) {
    let failed = ''
    if (await exists(root)) {
      failed = join(staging, 'failed-candidate')
      await rename(root, failed)
    }
    await rename(backup, root)
    await syncDirectory(dirname(root))
    if (failed) await rm(failed, { recursive: true, force: true })
  } else if (!(await exists(root))) {
    throw new Error('update backup is unavailable')
  }
  await cleanupCompletedTransaction('', staging, journal)
}
async function cleanupCompletedTransaction(
  backup: string,
  staging: string,
  journal: string,
) {
  try {
    if (backup) await rm(backup, { recursive: true, force: true })
    if (staging) await rm(staging, { recursive: true, force: true })
    await rm(journal, { force: true })
    await syncDirectory(dirname(journal))
  } catch {
    // The external launcher retries validated cleanup once the lease is gone.
  }
}
async function syncDirectory(path: string) {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
function normalizeTransactionError(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return error
  const systemError = error as NodeJS.ErrnoException & {
    dest?: unknown
    path?: unknown
  }
  if (
    typeof systemError.path === 'string' ||
    typeof systemError.dest === 'string' ||
    typeof systemError.syscall === 'string'
  ) {
    return new Error('self-update filesystem transaction failed', {
      cause: error,
    })
  }
  return error
}
async function releaseLease(owner: { release(): Promise<void> }) {
  try {
    await owner.release()
  } catch (error) {
    throw normalizeTransactionError(error)
  }
}
async function installLauncher(
  layout: SelfUpdateLayout,
  lockPath: string,
  journal: string,
) {
  const launcher = `${layout.packageRoot}.launcher.mjs`
  const source = generateLauncherSource(layout, lockPath, journal)
  const tmp = `${launcher}.${randomUUID()}.tmp`
  try {
    const handle = await open(tmp, 'wx', 0o700)
    try {
      await handle.writeFile(source)
      await handle.chmod(0o700)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, launcher)
    await syncDirectory(dirname(launcher))
    const link = `${layout.binPath}.${randomUUID()}.tmp`
    try {
      await symlink(launcher, link)
      await rename(link, layout.binPath)
      await syncDirectory(dirname(layout.binPath))
    } finally {
      await rm(link, { force: true })
    }
  } finally {
    await rm(tmp, { force: true })
  }
}

export function generateLauncherSource(
  layout: SelfUpdateLayout,
  lockPath: string,
  journal: string,
): string {
  return `#!/usr/bin/env node
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
const root=${JSON.stringify(layout.packageRoot)}, parent=${JSON.stringify(dirname(layout.packageRoot))}, backupPrefix=${JSON.stringify(`${layout.packageRoot}.update-backup-`)}, stagingPrefix=${JSON.stringify(`${dirname(layout.packageRoot)}/.praxis-update-`)}, lock=${JSON.stringify(lockPath)}, journal=${JSON.stringify(journal)};
const alive=(p)=>{try{process.kill(p,0);return true}catch(e){return e.code==='EPERM'}};
const owner=()=>{try{const j=JSON.parse(readFileSync(lock,'utf8'));return j&&j.version===1&&Number.isSafeInteger(j.pid)&&j.pid>0&&typeof j.token==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(j.token)&&typeof j.createdAt==='string'&&alive(j.pid)}catch{return false}};
const sibling=(value,prefix)=>typeof value==='string'&&value===resolve(value)&&dirname(value)===parent&&value.startsWith(prefix)&&value.length>prefix.length;
const valid=(j)=>j&&j.version===1&&j.root===root&&sibling(j.backup,backupPrefix)&&sibling(j.staging,stagingPrefix)&&['prepared','backup','candidate'].includes(j.phase)&&typeof j.targetVersion==='string';
const liveOwner=owner();
if(liveOwner&&!existsSync(root)){let n=0;while(n++<20&&!existsSync(root)){await new Promise(r=>setTimeout(r,25))}if(!existsSync(root))throw new Error('Praxis update already in progress');
} else if(!liveOwner&&existsSync(journal)){const j=JSON.parse(readFileSync(journal,'utf8'));if(!valid(j))throw new Error('invalid update journal');if(!existsSync(root)&&existsSync(j.backup))renameSync(j.backup,root);if(existsSync(root)){if(existsSync(j.backup))rmSync(j.backup,{recursive:true,force:true});rmSync(j.staging,{recursive:true,force:true});rmSync(journal,{force:true});}}
if(!existsSync(root)) throw new Error('Praxis update recovery failed');
process.env.PRAXIS_SELF_UPDATE_ROOT=root; const controller=new AbortController(); const cancel=()=>controller.abort(); process.on('SIGINT',cancel); process.on('SIGTERM',cancel); try { const mod=await import(join(root,'dist','cli.js')); if(typeof mod.run!=='function') throw new Error('CLI entrypoint unavailable'); process.exitCode=await mod.run(process.argv.slice(2),undefined,undefined,controller.signal); } finally { process.removeListener('SIGINT',cancel); process.removeListener('SIGTERM',cancel); }
`
}

export function validateSelfUpdateLayout(
  layout: SelfUpdateLayout,
): SelfUpdateLayout {
  const packageRoot = resolve(layout.packageRoot)
  const modules = resolve(layout.globalNodeModulesRoot)
  const prefix = resolve(layout.globalPrefix)
  const binPath = resolve(layout.binPath)
  if (
    dirname(packageRoot) !== modules ||
    dirname(modules) !== join(prefix, 'lib')
  ) {
    throw new Error('unsupported global npm installation layout')
  }
  if (binPath !== join(prefix, 'bin', 'praxis')) {
    throw new Error('unsupported global npm bin layout')
  }
  return {
    packageRoot,
    globalNodeModulesRoot: modules,
    globalPrefix: prefix,
    binPath,
  }
}

export function checksum(bytes: Uint8Array): { sha1: string; sha512: string } {
  return {
    sha1: createHash('sha1').update(bytes).digest('hex'),
    sha512: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  }
}
