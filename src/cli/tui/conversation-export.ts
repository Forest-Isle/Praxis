import { writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import type { TranscriptItem, TuiDisplayMetadata } from './claude-style.js'

function lines(text: string, prefix: string): string[] {
  const values = text.replace(/\n$/u, '').split('\n')
  return values.map((line, index) => `${index === 0 ? prefix : '   '}${line}`)
}

export function conversationExportText(
  _display: TuiDisplayMetadata,
  items: readonly TranscriptItem[],
): string {
  const output: string[] = []

  for (const item of items) {
    if (item.kind === 'user') output.push('', ...lines(item.text, '❯ '))
    else if (item.kind === 'assistant')
      output.push('', ...lines(item.text, '⏺ '))
    else if (item.kind === 'thinking')
      output.push('', ...lines(item.text, '✻ '))
    else if (item.kind === 'compact')
      output.push('', '✻ Conversation compacted', ...lines(item.summary, '  '))
    else if (item.kind === 'tool') {
      output.push(
        '',
        `⏺ ${item.call.name}${item.detail ? `(${item.detail})` : ''}`,
      )
    } else if (item.kind === 'tool-result') {
      output.push(...lines(item.text, item.isError ? '  ⎿ Error: ' : '  ⎿ '))
    } else if (item.kind === 'shell') {
      output.push('', `! ${item.command}`)
    } else if (item.kind === 'shell-result') {
      const result = [item.stdout, item.stderr].filter(Boolean).join('\n')
      output.push(...lines(result, item.isError ? '  ⎿ Error: ' : '  ⎿ '))
    } else if (item.kind === 'local-result') {
      output.push(...lines(item.text, '  ⎿ '))
    } else if (item.kind === 'context') {
      output.push(
        '',
        item.contextWindowTokens === undefined
          ? `Context Usage: ${item.usedTokens} tokens · Context capacity unavailable`
          : `Context Usage: ${item.usedTokens}/${item.contextWindowTokens} tokens`,
      )
    } else {
      output.push(...lines(item.text, item.kind === 'warning' ? '⚠ ' : '· '))
    }
  }

  return `${output
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trimEnd()}\n`
}

export function defaultConversationExportFilename(now = new Date()): string {
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((value) => String(value).padStart(2, '0'))
    .join('')
  return `${date}-${time}-praxis-conversation.txt`
}

export function conversationExportPath(cwd: string, filename: string): string {
  const name = filename.trim()
  if (!name || name === '.' || name === '..' || basename(name) !== name) {
    throw new Error('Export filename must stay within the current directory')
  }
  return resolve(cwd, name)
}

export async function writeConversationExport(
  path: string,
  text: string,
): Promise<void> {
  await writeFile(path, text, { encoding: 'utf8', flag: 'wx' })
}
