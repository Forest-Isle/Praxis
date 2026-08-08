import { describe, expect, it, vi } from 'vitest'

import { LocalToolRegistry } from './local-tools.js'
import { ClaudeUserMessageToolRegistry } from './claude-user-message.js'

describe('Claude SendUserMessage tool', () => {
  it('adds native definition and emits visible message metadata', async () => {
    const onMessage = vi.fn()
    const registry = new ClaudeUserMessageToolRegistry(
      new LocalToolRegistry({ cwd: process.cwd() }),
      onMessage,
    )
    expect(
      registry.definitions().find((tool) => tool.name === 'SendUserMessage'),
    ).toMatchObject({
      name: 'SendUserMessage',
      inputSchema: { required: ['message', 'status'] },
    })

    const result = await registry.execute(
      {
        id: 'message-1',
        name: 'SendUserMessage',
        input: {
          message: 'checkpoint',
          status: 'proactive',
          attachments: ['package.json'],
        },
      },
      { cwd: process.cwd() },
    )
    expect(result).toMatchObject({
      content: 'Message delivered to user.',
      isError: false,
      nativeToolUseResult: {
        message: 'checkpoint',
        attachments: [{ path: `${process.cwd()}/package.json` }],
      },
    })
    expect(onMessage).toHaveBeenCalledWith({
      message: 'checkpoint',
      status: 'proactive',
      attachments: [`${process.cwd()}/package.json`],
    })
  })

  it('delegates unrelated tools and validates required fields', async () => {
    const registry = new ClaudeUserMessageToolRegistry(
      new LocalToolRegistry({ cwd: process.cwd() }),
      () => undefined,
    )
    await expect(
      registry.execute(
        {
          id: 'message-2',
          name: 'SendUserMessage',
          input: { message: '', status: 'normal' },
        },
        { cwd: process.cwd() },
      ),
    ).rejects.toThrow('message must be a non-empty string')
    await expect(
      registry.execute(
        {
          id: 'message-3',
          name: 'SendUserMessage',
          input: { message: 'hello', status: 'invalid' },
        },
        { cwd: process.cwd() },
      ),
    ).rejects.toThrow('status must be normal or proactive')
    expect(
      (
        await registry.prepare(
          { id: 'read-1', name: 'Read', input: { file_path: 'package.json' } },
          { cwd: process.cwd() },
        )
      ).name,
    ).toBe('Read')
  })
})
