import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Key } from 'ink'

export interface TuiKeybindingsFile {
  path: string
  created: boolean
}

export type TuiKeybindings = ReadonlyMap<string, ReadonlyMap<string, string>>

const MAX_KEYBINDINGS_BYTES = 1024 * 1024

const CLAUDE_2_1_208_KEYBINDINGS = {
  $schema: 'https://www.schemastore.org/claude-code-keybindings.json',
  $docs: 'https://code.claude.com/docs/en/keybindings',
  bindings: [
    {
      context: 'Global',
      bindings: {
        'ctrl+t': 'app:toggleTodos',
        'ctrl+o': 'app:toggleTranscript',
        'ctrl+shift+b': 'app:toggleBrief',
        'ctrl+r': 'history:search',
        'ctrl+up': 'app:diffFileListUp',
        'ctrl+down': 'app:diffFileListDown',
        'meta+up': 'app:diffFileListUp',
        'meta+down': 'app:diffFileListDown',
        'ctrl+]': 'app:openArtifact',
      },
    },
    {
      context: 'Chat',
      bindings: {
        escape: 'chat:cancel',
        'ctrl+l': 'chat:clearInput',
        'cmd+k': 'chat:clearScreen',
        'ctrl+x ctrl+k': 'chat:killAgents',
        'shift+tab': 'chat:cycleMode',
        'meta+p': 'chat:modelPicker',
        'meta+o': 'chat:fastMode',
        'meta+t': 'chat:thinkingToggle',
        'meta+w': 'chat:workflowKeywordToggle',
        enter: 'chat:submit',
        'ctrl+j': 'chat:newline',
        up: 'history:previous',
        down: 'history:next',
        'ctrl+_': 'chat:undo',
        'ctrl+-': 'chat:undo',
        'ctrl+shift+-': 'chat:undo',
        'ctrl+shift+_': 'chat:undo',
        'ctrl+x ctrl+e': 'chat:externalEditor',
        'ctrl+g': 'chat:externalEditor',
        'ctrl+s': 'chat:stash',
        'ctrl+v': 'chat:imagePaste',
        space: 'voice:pushToTalk',
      },
    },
    {
      context: 'Autocomplete',
      bindings: {
        tab: 'autocomplete:accept',
        escape: 'autocomplete:dismiss',
        up: 'autocomplete:previous',
        down: 'autocomplete:next',
      },
    },
    {
      context: 'Settings',
      bindings: {
        escape: 'confirm:no',
        up: 'select:previous',
        down: 'select:next',
        k: 'select:previous',
        j: 'select:next',
        'ctrl+p': 'select:previous',
        'ctrl+n': 'select:next',
        space: 'select:accept',
        enter: 'select:accept',
        '/': 'settings:search',
        r: 'settings:retry',
        d: 'settings:periodDay',
        w: 'settings:periodWeek',
        t: 'settings:sortByTokens',
        'ctrl+u': 'scroll:halfPageUp',
      },
    },
    {
      context: 'Confirmation',
      bindings: {
        y: 'confirm:yes',
        n: 'confirm:no',
        enter: 'confirm:yes',
        escape: 'confirm:no',
        up: 'confirm:previous',
        down: 'confirm:next',
        tab: 'confirm:nextField',
        space: 'confirm:toggle',
        'shift+tab': 'confirm:cycleMode',
        'ctrl+e': 'confirm:toggleExplanation',
      },
    },
    {
      context: 'Tabs',
      bindings: {
        tab: 'tabs:next',
        'shift+tab': 'tabs:previous',
        right: 'tabs:next',
        left: 'tabs:previous',
      },
    },
    {
      context: 'Transcript',
      bindings: {
        'ctrl+e': 'transcript:toggleShowAll',
        escape: 'transcript:exit',
        q: 'transcript:exit',
        'ctrl+u': 'scroll:halfPageUp',
        'ctrl+b': 'scroll:fullPageUp',
        'ctrl+f': 'scroll:fullPageDown',
        'ctrl+n': 'scroll:lineDown',
        'ctrl+p': 'scroll:lineUp',
        g: 'scroll:top',
        'shift+g': 'scroll:bottom',
        j: 'scroll:lineDown',
        k: 'scroll:lineUp',
        space: 'scroll:fullPageDown',
        b: 'scroll:fullPageUp',
        up: 'scroll:lineUp',
        down: 'scroll:lineDown',
        home: 'scroll:top',
        end: 'scroll:bottom',
      },
    },
    {
      context: 'HistorySearch',
      bindings: {
        'ctrl+r': 'historySearch:next',
        escape: 'historySearch:accept',
        tab: 'historySearch:accept',
        enter: 'historySearch:execute',
        'ctrl+s': 'historySearch:cycleScope',
      },
    },
    {
      context: 'Task',
      bindings: {
        'ctrl+x ctrl+b': 'task:background',
        'ctrl+b': 'task:background',
      },
    },
    {
      context: 'ThemePicker',
      bindings: {
        'ctrl+t': 'theme:toggleSyntaxHighlighting',
      },
    },
    {
      context: 'Scroll',
      bindings: {
        pageup: 'scroll:pageUp',
        pagedown: 'scroll:pageDown',
        wheelup: 'scroll:lineUp',
        wheeldown: 'scroll:lineDown',
        'ctrl+home': 'scroll:top',
        'ctrl+end': 'scroll:bottom',
        'ctrl+shift+c': 'selection:copy',
        'cmd+c': 'selection:copy',
        'shift+left': 'selection:extendLeft',
        'shift+right': 'selection:extendRight',
        'shift+up': 'selection:extendUp',
        'shift+down': 'selection:extendDown',
        'shift+home': 'selection:extendLineStart',
        'shift+end': 'selection:extendLineEnd',
      },
    },
    {
      context: 'Help',
      bindings: { escape: 'help:dismiss' },
    },
    {
      context: 'Attachments',
      bindings: {
        right: 'attachments:next',
        left: 'attachments:previous',
        backspace: 'attachments:remove',
        delete: 'attachments:remove',
        down: 'attachments:exit',
        escape: 'attachments:exit',
      },
    },
    {
      context: 'Footer',
      bindings: {
        up: 'footer:up',
        'ctrl+p': 'footer:up',
        down: 'footer:down',
        'ctrl+n': 'footer:down',
        right: 'footer:next',
        left: 'footer:previous',
        enter: 'footer:openSelected',
        escape: 'footer:clearSelection',
        x: 'footer:close',
      },
    },
    {
      context: 'MessageSelector',
      bindings: {
        up: 'messageSelector:up',
        down: 'messageSelector:down',
        k: 'messageSelector:up',
        j: 'messageSelector:down',
        'ctrl+p': 'messageSelector:up',
        'ctrl+n': 'messageSelector:down',
        'ctrl+up': 'messageSelector:top',
        'shift+up': 'messageSelector:top',
        'meta+up': 'messageSelector:top',
        'shift+k': 'messageSelector:top',
        'ctrl+down': 'messageSelector:bottom',
        'shift+down': 'messageSelector:bottom',
        'meta+down': 'messageSelector:bottom',
        'shift+j': 'messageSelector:bottom',
        enter: 'messageSelector:select',
      },
    },
    {
      context: 'DiffDialog',
      bindings: {
        escape: 'diff:dismiss',
        left: 'diff:previousSource',
        right: 'diff:nextSource',
        up: 'diff:previousFile',
        down: 'diff:nextFile',
        enter: 'diff:viewDetails',
        j: 'diff:nextFile',
        k: 'diff:previousFile',
        pageup: 'scroll:pageUp',
        pagedown: 'scroll:pageDown',
        space: 'scroll:fullPageDown',
        'shift+space': 'scroll:fullPageUp',
        b: 'scroll:fullPageUp',
        g: 'scroll:top',
        'shift+g': 'scroll:bottom',
        home: 'scroll:top',
        end: 'scroll:bottom',
      },
    },
    {
      context: 'ModelPicker',
      bindings: {
        left: 'modelPicker:decreaseEffort',
        right: 'modelPicker:increaseEffort',
        s: 'modelPicker:thisSessionOnly',
      },
    },
    {
      context: 'Select',
      bindings: {
        up: 'select:previous',
        down: 'select:next',
        j: 'select:next',
        k: 'select:previous',
        'ctrl+n': 'select:next',
        'ctrl+p': 'select:previous',
        pageup: 'select:pageUp',
        pagedown: 'select:pageDown',
        home: 'select:first',
        end: 'select:last',
        enter: 'select:accept',
        escape: 'select:cancel',
      },
    },
    {
      context: 'Plugin',
      bindings: {
        space: 'plugin:toggle',
        i: 'plugin:install',
        f: 'plugin:favorite',
      },
    },
  ],
} as const

export function claudeKeybindingsTemplate(): string {
  return `${JSON.stringify(CLAUDE_2_1_208_KEYBINDINGS, null, 2)}\n`
}

function parseBindings(
  value: unknown,
  source: string,
  base?: TuiKeybindings,
): TuiKeybindings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid Claude keybindings file: ${source}`)
  }
  const records = (value as Record<string, unknown>).bindings
  if (!Array.isArray(records)) {
    throw new Error(`Invalid Claude keybindings file: ${source}`)
  }
  const merged = new Map<string, Map<string, string>>()
  for (const [context, bindings] of base ?? []) {
    merged.set(context, new Map(bindings))
  }
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error(`Invalid Claude keybindings file: ${source}`)
    }
    const context = (record as Record<string, unknown>).context
    const bindings = (record as Record<string, unknown>).bindings
    if (
      typeof context !== 'string' ||
      !bindings ||
      typeof bindings !== 'object' ||
      Array.isArray(bindings)
    ) {
      throw new Error(`Invalid Claude keybindings file: ${source}`)
    }
    const contextBindings = merged.get(context) ?? new Map<string, string>()
    for (const [chord, action] of Object.entries(bindings)) {
      if (action === null) contextBindings.delete(chord.toLowerCase())
      else if (typeof action === 'string')
        contextBindings.set(chord.toLowerCase(), action)
      else throw new Error(`Invalid Claude keybindings file: ${source}`)
    }
    merged.set(context, contextBindings)
  }
  return merged
}

export function defaultTuiKeybindings(): TuiKeybindings {
  return parseBindings(CLAUDE_2_1_208_KEYBINDINGS, 'built-in template')
}

export async function loadTuiKeybindings(
  configRoot: string,
): Promise<TuiKeybindings> {
  const defaults = defaultTuiKeybindings()
  const path = join(configRoot, 'keybindings.json')
  let source: string
  try {
    const metadata = await stat(path)
    if (metadata.size > MAX_KEYBINDINGS_BYTES) {
      throw new Error(
        `Claude keybindings file exceeds ${MAX_KEYBINDINGS_BYTES} bytes: ${path}`,
      )
    }
    source = await readFile(path, 'utf8')
    if (Buffer.byteLength(source) > MAX_KEYBINDINGS_BYTES) {
      throw new Error(
        `Claude keybindings file exceeds ${MAX_KEYBINDINGS_BYTES} bytes: ${path}`,
      )
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaults
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    throw new Error(`Invalid Claude keybindings file: ${path}`, {
      cause: error,
    })
  }
  return parseBindings(parsed, path, defaults)
}

export function resolveTuiKeybinding(
  bindings: TuiKeybindings,
  contexts: readonly string[],
  chord: string | null,
): string | undefined {
  if (!chord) return undefined
  for (const context of [...contexts, 'Global']) {
    const action = bindings.get(context)?.get(chord.toLowerCase())
    if (action) return action
  }
  return undefined
}

export function hasTuiKeybindingPrefix(
  bindings: TuiKeybindings,
  contexts: readonly string[],
  chord: string,
): boolean {
  const prefix = `${chord.toLowerCase()} `
  return [...contexts, 'Global'].some((context) =>
    [...(bindings.get(context)?.keys() ?? [])].some((candidate) =>
      candidate.startsWith(prefix),
    ),
  )
}

export function tuiKeyChord(value: string, key: Key): string | null {
  const named = key.upArrow
    ? 'up'
    : key.downArrow
      ? 'down'
      : key.leftArrow
        ? 'left'
        : key.rightArrow
          ? 'right'
          : key.pageUp
            ? 'pageup'
            : key.pageDown
              ? 'pagedown'
              : key.home
                ? 'home'
                : key.end
                  ? 'end'
                  : key.return
                    ? 'enter'
                    : key.escape
                      ? 'escape'
                      : key.tab
                        ? 'tab'
                        : key.backspace
                          ? 'backspace'
                          : key.delete
                            ? 'delete'
                            : value === ' '
                              ? 'space'
                              : null
  let base = named
  if (!base && value.length === 1) {
    const code = value.charCodeAt(0)
    if (code >= 1 && code <= 26) {
      base = String.fromCharCode(code + 96)
      return `ctrl+${base}`
    }
    if (code === 31) return 'ctrl+_'
    if (code >= 32 && code !== 127) base = value.toLowerCase()
  }
  if (!base) return null
  const modifiers = [
    key.ctrl ? 'ctrl' : null,
    key.shift ? 'shift' : null,
    key.super ? 'cmd' : key.meta ? 'meta' : null,
  ].filter(Boolean)
  return [...modifiers, base].join('+')
}

export async function ensureTuiKeybindingsFile(
  configRoot: string,
): Promise<TuiKeybindingsFile> {
  const path = join(configRoot, 'keybindings.json')
  await mkdir(configRoot, { recursive: true, mode: 0o700 })
  try {
    await writeFile(path, claudeKeybindingsTemplate(), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    return { path, created: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return { path, created: false }
    }
    throw error
  }
}
