import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { writeFileAtomically } from '../platform/atomic-write.js'

export type TrajectoryRunKind =
  'interactive' | 'headless' | 'background' | 'workflow'

export interface TrajectoryProvenance {
  runKind: TrajectoryRunKind
  targetCommit: string | null
}

const execFileAsync = promisify(execFile)
const runKinds = new Set<TrajectoryRunKind>([
  'interactive',
  'headless',
  'background',
  'workflow',
])

function pathFor(configRoot: string, sessionId: string): string {
  return join(configRoot, 'praxis', 'trajectory-metadata', `${sessionId}.json`)
}

export async function readTrajectoryProvenance(
  configRoot: string,
  sessionId: string,
): Promise<TrajectoryProvenance | null> {
  try {
    const value = JSON.parse(
      await readFile(pathFor(configRoot, sessionId), 'utf8'),
    ) as Record<string, unknown>
    if (
      value.schemaVersion !== 1 ||
      !runKinds.has(value.runKind as TrajectoryRunKind) ||
      !(
        value.targetCommit === null ||
        (typeof value.targetCommit === 'string' &&
          /^[a-f0-9]{40,64}$/u.test(value.targetCommit))
      )
    ) {
      return null
    }
    return {
      runKind: value.runKind as TrajectoryRunKind,
      targetCommit: value.targetCommit,
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    if (error instanceof SyntaxError) return null
    throw error
  }
}

async function resolveTargetCommit(cwd: string): Promise<string | null> {
  try {
    const result = await execFileAsync(
      'git',
      ['-C', cwd, 'rev-parse', '--verify', 'HEAD'],
      { encoding: 'utf8', timeout: 10_000 },
    )
    const commit = result.stdout.trim()
    return /^[a-f0-9]{40,64}$/u.test(commit) ? commit : null
  } catch {
    return null
  }
}

export async function captureTrajectoryProvenance(
  configRoot: string,
  sessionId: string,
  cwd: string,
  runKind: TrajectoryRunKind,
): Promise<TrajectoryProvenance> {
  const existing = await readTrajectoryProvenance(configRoot, sessionId)
  if (existing) return existing
  const provenance = {
    runKind,
    targetCommit: await resolveTargetCommit(cwd),
  }
  await writeFileAtomically(
    pathFor(configRoot, sessionId),
    `${JSON.stringify({ schemaVersion: 1, ...provenance })}\n`,
    { mode: 0o600 },
  )
  return provenance
}
