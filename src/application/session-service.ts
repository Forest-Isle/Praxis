import { randomUUID } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

import { resolveClaudePaths } from '../compatibility/claude/paths.js'
import { createClaudeTextFork } from '../compatibility/claude/fork.js'
import {
  getClaudeLastPrompt,
  projectClaudeTextMessages,
} from '../compatibility/claude/projection.js'
import {
  type ClaudeTranscriptEntry,
  selectClaudeSchemaAdapter,
} from '../compatibility/claude/schema.js'
import {
  createClaudeLastPromptEntry,
  translateProviderEvents,
} from '../compatibility/claude/translation.js'
import {
  AgentRuntime,
  type ModelProvider,
  type ModelUsage,
  type RuntimeEventSink,
} from '../core/runtime.js'
import {
  ClaudeTranscriptStore,
  type ClaudeTranscriptLease,
  type TranscriptSnapshot,
  type TranscriptTail,
} from '../persistence/claude-transcript-store.js'

export interface ClaudeSessionServiceOptions {
  configRoot: string
  cwd: string
  claudeVersion: string
  provider?: ModelProvider
  eventSink?: RuntimeEventSink
}

export interface SessionRunResult {
  sessionId: string
  text: string
  usage: ModelUsage
}

export interface SessionSummary {
  sessionId: string
  lastPrompt: string | null
  updatedAt: string
}

export interface ForkResult {
  sessionId: string
  parentSessionId: string
}

export class ClaudeSessionService {
  private readonly schema

  constructor(private readonly options: ClaudeSessionServiceOptions) {
    this.schema = selectClaudeSchemaAdapter(options.claudeVersion)
  }

  async run(prompt: string, signal?: AbortSignal): Promise<SessionRunResult> {
    return this.executeTurn(randomUUID(), prompt, false, signal)
  }

  async resume(
    sessionId: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<SessionRunResult> {
    return this.executeTurn(sessionId, prompt, true, signal)
  }

  async sessions(): Promise<SessionSummary[]> {
    const paths = this.paths(randomUUID())
    let names: string[]
    try {
      names = await readdir(paths.projectRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }

    const summaries = await Promise.all(
      names
        .filter((name) => extname(name) === '.jsonl')
        .map(async (name) => {
          const sessionId = basename(name, '.jsonl')
          const store = this.store(sessionId)
          const [snapshot, metadata] = await Promise.all([
            store.load(),
            stat(join(paths.projectRoot, name)),
          ])
          return {
            sessionId,
            lastPrompt: getClaudeLastPrompt(snapshot.entries),
            updatedAt: metadata.mtime.toISOString(),
          }
        }),
    )
    return summaries.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    )
  }

  async fork(parentSessionId: string): Promise<ForkResult> {
    this.assertWritable()
    const sourceResult = await this.store(parentSessionId).withLease((lease) =>
      lease.load(),
    )
    if (sourceResult.status === 'conflict') {
      throw new Error(`Claude transcript fork conflict: ${sourceResult.reason}`)
    }
    const source = sourceResult.value
    if (source.entries.length === 0) {
      throw new Error(`Claude session not found: ${parentSessionId}`)
    }

    const sessionId = randomUUID()
    const target = this.store(sessionId)
    const result = await target.create(
      createClaudeTextFork({
        source: source.entries,
        sessionId,
        cwd: this.options.cwd,
        claudeVersion: this.options.claudeVersion,
      }),
    )
    if (result.status === 'conflict') {
      throw new Error('Generated Claude fork session already exists')
    }
    return { sessionId, parentSessionId }
  }

  private async executeTurn(
    sessionId: string,
    prompt: string,
    requireExisting: boolean,
    signal?: AbortSignal,
  ): Promise<SessionRunResult> {
    this.assertWritable()
    if (prompt.length === 0) throw new Error('Prompt must not be empty')

    const store = this.store(sessionId)
    const leaseResult = await store.withLease(async (lease) => {
      let snapshot = await lease.load()
      if (requireExisting && snapshot.entries.length === 0) {
        throw new Error(`Claude session not found: ${sessionId}`)
      }

      const [userEntry] = translateProviderEvents(
        [{ type: 'user-text', text: prompt }],
        this.translationContext(sessionId, snapshot),
      )
      if (!userEntry) throw new Error('Could not translate user prompt')
      const userTail = await this.append(lease, snapshot.tail, userEntry)
      snapshot = { entries: [...snapshot.entries, userEntry], tail: userTail }

      const provider = this.provider()
      const runtime = new AgentRuntime(provider, this.options.eventSink)
      const runtimeRequest = {
        messages: projectClaudeTextMessages(snapshot.entries),
      }
      const result = signal
        ? await runtime.run({ ...runtimeRequest, signal })
        : await runtime.run(runtimeRequest)

      const [assistantEntry] = translateProviderEvents(
        [
          {
            type: 'assistant-text',
            text: result.text,
            providerMessageId: `msg_${randomUUID().replaceAll('-', '')}`,
            model: provider.model ?? 'praxis/provider',
          },
        ],
        this.translationContext(sessionId, snapshot),
      )
      if (!assistantEntry || typeof assistantEntry.uuid !== 'string') {
        throw new Error('Could not translate assistant response')
      }
      const assistantTail = await this.append(
        lease,
        snapshot.tail,
        assistantEntry,
      )
      await this.append(
        lease,
        assistantTail,
        createClaudeLastPromptEntry({
          sessionId,
          lastPrompt: prompt,
          leafUuid: assistantEntry.uuid,
        }),
      )

      return { sessionId, text: result.text, usage: result.usage }
    })
    if (leaseResult.status === 'conflict') {
      throw new Error(
        `Claude transcript append conflict: ${leaseResult.reason}`,
      )
    }
    return leaseResult.value
  }

  private translationContext(sessionId: string, snapshot: TranscriptSnapshot) {
    return {
      sessionId,
      parentUuid: snapshot.tail.lastUuid,
      cwd: this.options.cwd,
      claudeVersion: this.options.claudeVersion,
      gitBranch: null,
      history: snapshot.entries,
    }
  }

  private paths(sessionId: string) {
    return resolveClaudePaths({
      configDir: this.options.configRoot,
      cwd: this.options.cwd,
      sessionId,
    })
  }

  private store(sessionId: string): ClaudeTranscriptStore {
    const paths = this.paths(sessionId)
    return new ClaudeTranscriptStore({
      sessionFile: paths.sessionFile,
      lockFile: join(paths.praxisRoot, 'locks', `${sessionId}.lock`),
      schema: this.schema,
    })
  }

  private assertWritable(): void {
    if (this.schema.writeMode !== 'read-write') {
      throw new Error(
        `Claude ${this.options.claudeVersion} session is read-only`,
      )
    }
  }

  private provider(): ModelProvider {
    if (!this.options.provider) {
      throw new Error('A model provider is required for run and resume')
    }
    return this.options.provider
  }

  private async append(
    lease: ClaudeTranscriptLease,
    tail: TranscriptTail,
    entry: ClaudeTranscriptEntry,
  ): Promise<TranscriptTail> {
    const result = await lease.append(tail, entry)
    if (result.status === 'conflict') {
      throw new Error(`Claude transcript append conflict: ${result.reason}`)
    }
    return result.tail
  }
}
