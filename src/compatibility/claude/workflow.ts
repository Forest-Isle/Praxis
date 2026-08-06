import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'

import { isClaudeSessionId } from './paths.js'

const RUN_ID = /^wf_[a-z0-9-]{6,}$/u
const TASK_ID = /^w[a-z0-9]{8}$/u
const AGENT_ID = /^a[0-9a-f]{16}$/u

export interface ClaudeWorkflowPaths {
  sessionDirectory: string
  workflowDirectory: string
  scriptsDirectory: string
  scriptFile: string
  runFile: string
  transcriptDirectory: string
  journalFile: string
}

export function createWorkflowRunId(): string {
  return `wf_${randomBytes(4).toString('hex')}-${randomBytes(2).toString('hex').slice(0, 3)}`
}

export function createWorkflowTaskId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = randomBytes(8)
  let value = 'w'
  for (const byte of bytes) value += alphabet[byte % alphabet.length]
  return value
}

export function createWorkflowAgentId(): string {
  return `a${randomBytes(8).toString('hex')}`
}

export function isWorkflowRunId(value: string): boolean {
  return RUN_ID.test(value)
}

export function isWorkflowTaskId(value: string): boolean {
  return TASK_ID.test(value)
}

export function isWorkflowAgentId(value: string): boolean {
  return AGENT_ID.test(value)
}

export function resolveClaudeWorkflowPaths(options: {
  projectRoot: string
  sessionId: string
  runId: string
  workflowName: string
}): ClaudeWorkflowPaths {
  if (!isClaudeSessionId(options.sessionId)) {
    throw new Error(`Invalid Claude session ID: ${options.sessionId}`)
  }
  if (!isWorkflowRunId(options.runId)) {
    throw new Error(`Invalid workflow run ID: ${options.runId}`)
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(options.workflowName)) {
    throw new Error(`Invalid workflow name: ${options.workflowName}`)
  }
  const sessionDirectory = resolve(options.projectRoot, options.sessionId)
  const workflowDirectory = resolve(sessionDirectory, 'workflows')
  const scriptsDirectory = resolve(workflowDirectory, 'scripts')
  const transcriptDirectory = resolve(
    sessionDirectory,
    'subagents',
    'workflows',
    options.runId,
  )
  return {
    sessionDirectory,
    workflowDirectory,
    scriptsDirectory,
    scriptFile: resolve(
      scriptsDirectory,
      `${options.workflowName}-${options.runId}.js`,
    ),
    runFile: resolve(workflowDirectory, `${options.runId}.json`),
    transcriptDirectory,
    journalFile: resolve(transcriptDirectory, 'journal.jsonl'),
  }
}

export function workflowAgentFiles(
  transcriptDirectory: string,
  agentId: string,
): { transcriptFile: string; metadataFile: string } {
  if (!isWorkflowAgentId(agentId)) {
    throw new Error(`Invalid workflow agent ID: ${agentId}`)
  }
  return {
    transcriptFile: resolve(transcriptDirectory, `agent-${agentId}.jsonl`),
    metadataFile: resolve(transcriptDirectory, `agent-${agentId}.meta.json`),
  }
}

export function formatWorkflowLaunch(options: {
  taskId: string
  summary: string
  transcriptDirectory: string
  scriptFile: string
  runId: string
}): string {
  return [
    `Workflow launched in background. Task ID: ${options.taskId}`,
    `Summary: ${options.summary}`,
    `Transcript dir: ${options.transcriptDirectory}`,
    `Script file: ${options.scriptFile}`,
    '(Edit this file with Write/Edit and re-invoke Workflow with {scriptPath: "<path>"} to iterate without resending the script.)',
    `Run ID: ${options.runId}`,
    `To resume after editing the script: Workflow({scriptPath: "${options.scriptFile}", resumeFromRunId: "${options.runId}"}) — completed agents return cached results (cached results may themselves be empty — inspect journal.jsonl before assuming there is something to recover).`,
    '',
    'You will be notified when it completes. Use /workflows to watch live progress.',
  ].join('\n')
}
