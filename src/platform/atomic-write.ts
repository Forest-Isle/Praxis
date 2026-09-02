import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export async function writeFileAtomically(
  filePath: string,
  content: string,
  options: { mode?: number; beforeCommit?: () => Promise<boolean> } = {},
): Promise<boolean> {
  await mkdir(dirname(filePath), { recursive: true })
  const temporary = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  )
  try {
    const handle = await open(temporary, 'wx', options.mode ?? 0o600)
    try {
      await handle.writeFile(content)
      if (options.mode !== undefined) await handle.chmod(options.mode)
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (options.beforeCommit && !(await options.beforeCommit())) return false
    await rename(temporary, filePath)
    return true
  } finally {
    await rm(temporary, { force: true })
  }
}
