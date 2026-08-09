import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { detectClaudeVersion } from './lib/claude-probe.mjs'

const execFileAsync = promisify(execFile)
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const praxisCli = join(repositoryRoot, 'dist', 'cli.js')
const probeRoot = await mkdtemp(join(tmpdir(), 'praxis-cli-surface-'))
const environment = {
  ...process.env,
  CLAUDE_CONFIG_DIR: join(probeRoot, 'config'),
  DISABLE_AUTOUPDATER: '1',
}
const excludedOptions = new Map([
  [
    '',
    new Set([
      '--chrome',
      '--ide',
      '--no-chrome',
      '--remote-control',
      '--remote-control-session-name-prefix',
    ]),
  ],
])
const excludedCommands = new Map([
  ['', new Set(['auth', 'gateway', 'setup-token', 'ultrareview'])],
  ['mcp', new Set(['add-from-claude-desktop'])],
])

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function routeKey(route) {
  return route.join(' ')
}

function helpArgs(route, useGenericHelp) {
  if (route.length === 0) return ['--help']
  if (!useGenericHelp) return [...route, '--help']
  return [...route.slice(0, -1), 'help', route.at(-1)]
}

async function help(
  command,
  route,
  expectedRoute = route,
  useGenericHelp = false,
) {
  const run = (args) =>
    command === 'claude'
      ? execFileAsync(process.env.PRAXIS_CLAUDE_BINARY ?? 'claude', args, {
          cwd: probeRoot,
          env: environment,
          timeout: 30_000,
          maxBuffer: 4 * 1024 * 1024,
        })
      : execFileAsync(process.execPath, [praxisCli, ...args], {
          cwd: probeRoot,
          env: environment,
          timeout: 30_000,
          maxBuffer: 4 * 1024 * 1024,
        })
  let execution
  try {
    execution = await run(helpArgs(route, useGenericHelp))
  } catch (error) {
    if (command !== 'claude' || !useGenericHelp) throw error
    execution = await run([...route, '--help'])
  }
  const output = `${execution.stdout}${execution.stderr}`
  const expected = `${command} ${expectedRoute.join(' ')}`.trim()
  const normalized = output.replace(/\|[a-z][a-z0-9-]*/giu, '')
  assert(
    route.length === 0
      ? normalized.includes('Usage:') &&
          normalized.includes(
            command === 'claude' ? 'claude [options]' : '  praxis',
          )
      : normalized.includes(`Usage: ${expected}`),
    `${command} help route fell through for ${routeKey(route) || 'root'}`,
  )
  return output
}

function section(output, name) {
  const lines = output.split(/\r?\n/u)
  const start = lines.findIndex((line) => line === `${name}:`)
  if (start < 0) return []
  const selected = []
  for (const line of lines.slice(start + 1)) {
    if (/^[A-Z][^:]*:$/u.test(line)) break
    selected.push(line)
  }
  return selected
}

function options(output) {
  const names = new Set()
  for (const line of section(output, 'Options')) {
    if (!/^\s{2,}--?[A-Za-z]/u.test(line)) continue
    for (const match of line.matchAll(
      /(?:^|[\s,])(--?[A-Za-z][A-Za-z0-9-]*)(?=[\s,[<=]|$)/gu,
    )) {
      names.add(match[1])
    }
  }
  return names
}

function commandGroups(output) {
  const groups = []
  for (const line of section(output, 'Commands')) {
    const match = /^\s{2}(\S+)/u.exec(line)
    if (!match || match[1].endsWith(':')) continue
    const aliases = match[1].split('|')
    if (aliases.some((alias) => !/^[a-z][a-z0-9-]*$/u.test(alias))) continue
    groups.push(aliases)
  }
  return groups
}

function rootPraxisCommands(output) {
  const lines = section(output, 'Usage')
  const commands = new Set()
  for (const line of lines) {
    const match = /^\s{2}praxis\s+([^\s[<]+)/u.exec(line)
    if (!match || match[1].startsWith('-')) continue
    for (const alias of match[1].split('|')) commands.add(alias)
  }
  return commands
}

function businessCommands(output, route, kind) {
  if (kind === 'praxis' && route.length === 0) {
    return rootPraxisCommands(output)
  }
  return new Set(
    commandGroups(output)
      .flat()
      .filter((command) => command !== 'help'),
  )
}

function difference(required, actual, excluded = new Set()) {
  return [...required].filter(
    (value) => !excluded.has(value) && !actual.has(value),
  )
}

try {
  await detectClaudeVersion('CLI surface parity')
  const queue = [{ route: [], useGenericHelp: false }]
  const seen = new Set()
  let routes = 0
  let optionsChecked = 0
  let commandsChecked = 0
  let aliasesDispatched = 0

  while (queue.length > 0) {
    const { route, useGenericHelp } = queue.shift()
    const key = routeKey(route)
    if (seen.has(key)) continue
    seen.add(key)

    const [claudeHelp, praxisHelp] = await Promise.all([
      help('claude', route, route, useGenericHelp),
      help('praxis', route, route, useGenericHelp),
    ])
    routes += 1

    const claudeOptions = options(claudeHelp)
    const praxisOptions = options(praxisHelp)
    for (const excluded of excludedOptions.get(key) ?? []) {
      assert(
        claudeOptions.has(excluded),
        `${key || 'root'} stale option exclusion: ${excluded}`,
      )
    }
    const missingOptions = difference(
      claudeOptions,
      praxisOptions,
      excludedOptions.get(key),
    )
    assert(
      missingOptions.length === 0,
      `${key || 'root'} missing options: ${missingOptions.join(', ')}`,
    )
    optionsChecked +=
      claudeOptions.size -
      [...claudeOptions].filter((name) => excludedOptions.get(key)?.has(name))
        .length

    const claudeGroups = commandGroups(claudeHelp)
    const claudeCommands = businessCommands(claudeHelp, route, 'claude')
    const praxisCommands = businessCommands(praxisHelp, route, 'praxis')
    for (const excluded of excludedCommands.get(key) ?? []) {
      assert(
        claudeCommands.has(excluded),
        `${key || 'root'} stale command exclusion: ${excluded}`,
      )
    }
    const missingCommands = difference(
      claudeCommands,
      praxisCommands,
      excludedCommands.get(key),
    )
    assert(
      missingCommands.length === 0,
      `${key || 'root'} missing commands or aliases: ${missingCommands.join(', ')}`,
    )
    commandsChecked +=
      claudeCommands.size -
      [...claudeCommands].filter((name) => excludedCommands.get(key)?.has(name))
        .length
    const childUsesGenericHelp = claudeGroups.some((aliases) =>
      aliases.includes('help'),
    )

    for (const aliases of claudeGroups) {
      const primary = aliases[0]
      if (primary === 'help' || excludedCommands.get(key)?.has(primary))
        continue
      queue.push({
        route: [...route, primary],
        useGenericHelp: childUsesGenericHelp,
      })
      for (const alias of aliases.slice(1)) {
        await help(
          'praxis',
          [...route, alias],
          [...route, primary],
          childUsesGenericHelp,
        )
        aliasesDispatched += 1
      }
    }
  }

  for (const key of [...excludedOptions.keys(), ...excludedCommands.keys()]) {
    assert(seen.has(key), `Exclusion references undiscovered route: ${key}`)
  }

  console.log(
    `CLI surface parity passed: ${routes} routes, ${optionsChecked} options, ${commandsChecked} commands/aliases, ${aliasesDispatched} alias dispatches.`,
  )
} finally {
  await rm(probeRoot, { recursive: true, force: true })
}
