import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { ClaudeWorkflowPaths } from '../compatibility/claude/workflow.js'

export interface WorkflowJournalStarted {
  type: 'started'
  key: string
  agentId: string
}

export interface WorkflowJournalResult {
  type: 'result'
  key: string
  agentId: string
  result: unknown
}

export type WorkflowJournalEntry =
  WorkflowJournalStarted | WorkflowJournalResult

export interface WorkflowReplayEntry {
  agentId: string
  result: unknown
}

async function atomicWrite(path: string, source: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  await writeFile(temporary, source, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}

export class ClaudeWorkflowStore {
  private appendTail = Promise.resolve()

  constructor(readonly paths: ClaudeWorkflowPaths) {}

  async initialize(script: string): Promise<void> {
    await Promise.all([
      mkdir(this.paths.scriptsDirectory, { recursive: true }),
      mkdir(this.paths.transcriptDirectory, { recursive: true }),
    ])
    await atomicWrite(this.paths.scriptFile, script)
  }

  writeRun(run: Record<string, unknown>): Promise<void> {
    return atomicWrite(this.paths.runFile, `${JSON.stringify(run, null, 2)}\n`)
  }

  append(entry: WorkflowJournalEntry): Promise<void> {
    const operation = this.appendTail.then(async () => {
      await mkdir(this.paths.transcriptDirectory, { recursive: true })
      const handle = await open(this.paths.journalFile, 'a', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(entry)}\n`, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
    })
    this.appendTail = operation.catch(() => undefined)
    return operation
  }

  async journal(): Promise<WorkflowJournalEntry[]> {
    let source: string
    try {
      source = await readFile(this.paths.journalFile, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const entries: WorkflowJournalEntry[] = []
    for (const [index, line] of source.split('\n').entries()) {
      if (line.length === 0) continue
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        throw new Error(
          `Invalid workflow journal JSON at ${this.paths.journalFile}:${index + 1}`,
        )
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Invalid workflow journal entry at line ${index + 1}`)
      }
      const record = value as Record<string, unknown>
      if (
        (record.type !== 'started' && record.type !== 'result') ||
        typeof record.key !== 'string' ||
        typeof record.agentId !== 'string' ||
        (record.type === 'result' && !Object.hasOwn(record, 'result'))
      ) {
        throw new Error(`Invalid workflow journal entry at line ${index + 1}`)
      }
      entries.push(record as unknown as WorkflowJournalEntry)
    }
    return entries
  }

  async replayIndex(): Promise<Map<string, WorkflowReplayEntry>> {
    const started = new Map<string, string>()
    const results = new Map<string, WorkflowReplayEntry>()
    for (const entry of await this.journal()) {
      if (entry.type === 'started') {
        started.set(entry.key, entry.agentId)
      } else if (started.get(entry.key) === entry.agentId) {
        results.set(entry.key, {
          agentId: entry.agentId,
          result: entry.result,
        })
      }
    }
    return results
  }

  async replayByPrompt(): Promise<Map<string, WorkflowReplayEntry>> {
    const results = new Map<string, WorkflowReplayEntry>()
    const duplicates = new Set<string>()
    const completed = [...(await this.replayIndex()).values()]
    await Promise.all(
      completed.map(async (entry) => {
        let source: string
        try {
          source = await readFile(
            join(
              this.paths.transcriptDirectory,
              `agent-${entry.agentId}.jsonl`,
            ),
            'utf8',
          )
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
          throw error
        }
        const first = source.split('\n').find((line) => line.length > 0)
        if (!first) return
        const root: unknown = JSON.parse(first)
        if (!root || typeof root !== 'object' || Array.isArray(root)) return
        const message = (root as Record<string, unknown>).message
        if (!message || typeof message !== 'object' || Array.isArray(message))
          return
        const prompt = (message as Record<string, unknown>).content
        if (typeof prompt !== 'string') return
        if (results.has(prompt)) duplicates.add(prompt)
        else results.set(prompt, entry)
      }),
    )
    for (const prompt of duplicates) results.delete(prompt)
    return results
  }
}
