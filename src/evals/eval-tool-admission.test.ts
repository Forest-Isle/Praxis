import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  AgentRuntime,
  type ModelProvider,
  type ModelToolCall,
} from '../core/runtime.js'
import { ClaudePermissionResolver } from '../permissions/claude-permission-resolver.js'
import { isEvalToolCallPreapproved } from './eval-tool-admission.js'

function call(
  name: string,
  input: Record<string, unknown> = {},
): ModelToolCall {
  return { id: `test-${name}`, name, input }
}

function admission(cwd: string, additionalDirectories: readonly string[] = []) {
  return {
    cwd,
    homeDirectory: cwd,
    allowedTools: ['Bash', 'Read'],
    additionalDirectories,
  }
}

describe('eval tool admission', () => {
  it('preserves allowed non-Bash tools and rejects tools outside the catalog', () => {
    const options = admission('/workspace')
    expect(isEvalToolCallPreapproved(call('Read'), options)).toBe(true)
    expect(isEvalToolCallPreapproved(call('Write'), options)).toBe(false)
  })

  it('rejects malformed Bash calls and unsafe Bash semantics', () => {
    const options = admission('/workspace')
    expect(isEvalToolCallPreapproved(call('Bash'), options)).toBe(false)
    expect(
      isEvalToolCallPreapproved(
        call('Bash', { command: 'for x in; do echo $x; done' }),
        options,
      ),
    ).toBe(false)
  })

  it('allows opaque commands and bounded workspace paths', () => {
    const cwd = '/workspace/project'
    const options = admission(cwd)
    expect(
      isEvalToolCallPreapproved(call('Bash', { command: 'npm test' }), options),
    ).toBe(true)
    expect(
      isEvalToolCallPreapproved(call('Bash', { command: 'find .' }), options),
    ).toBe(true)
    expect(
      isEvalToolCallPreapproved(
        call('Bash', { command: 'printf ok > ./result.txt' }),
        options,
      ),
    ).toBe(true)
  })

  it('allows paths inside explicit addDirs', () => {
    const options = admission('/workspace/project', ['/workspace/fixtures'])
    expect(
      isEvalToolCallPreapproved(
        call('Bash', { command: 'cat /workspace/fixtures/input.txt' }),
        options,
      ),
    ).toBe(true)
  })

  it('rejects host-root and outside paths, including wrapped commands', () => {
    const options = admission('/workspace/project')
    expect(
      isEvalToolCallPreapproved(call('Bash', { command: 'find /' }), options),
    ).toBe(false)
    expect(
      isEvalToolCallPreapproved(
        call('Bash', { command: 'env find /' }),
        options,
      ),
    ).toBe(false)
    expect(
      isEvalToolCallPreapproved(
        call('Bash', { command: 'cat /etc/hosts' }),
        options,
      ),
    ).toBe(false)
    expect(
      isEvalToolCallPreapproved(
        call('Bash', { command: 'touch /tmp/eval-outside.txt' }),
        options,
      ),
    ).toBe(false)
  })
})

describe('eval admission runtime boundary', () => {
  it('keeps rejected Bash out of execution while bounded Bash reaches the tool', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'praxis-eval-admission-'))
    const executions: string[] = []
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete() {},
    }
    const options = admission(cwd)
    const outside = call('Bash', { command: 'find /' })
    const bounded = call('Bash', { command: 'find .' })

    const runtime = new AgentRuntime(provider, undefined, {
      tools: {
        definitions: () => [
          {
            name: 'Bash',
            description: 'Run Bash',
            inputSchema: { type: 'object' },
          },
        ],
        prepare: async (toolCall) => toolCall,
        execute: async (toolCall) => {
          executions.push(String(toolCall.input))
          return { content: 'executed', isError: false }
        },
      },
      permissions: new ClaudePermissionResolver({
        cwd,
        settings: [],
        permissionMode: 'dontAsk',
        isSessionActionApproved: (toolCall) =>
          isEvalToolCallPreapproved(toolCall, options),
      }),
    })
    const observer = {
      onEvent() {},
      async toolCompleted() {},
      async assistantCompleted() {},
    }
    const executeDirect = (toolCall: ModelToolCall) =>
      runtime.executeDirectToolCall(toolCall, {
        cwd,
        observer,
      })

    const outsideResult = await executeDirect(outside)
    expect(outsideResult.isError).toBe(true)
    expect(executions).toHaveLength(0)

    const boundedResult = await executeDirect(bounded)
    expect(boundedResult).toMatchObject({ content: 'executed', isError: false })
    expect(executions).toHaveLength(1)
  })
})
