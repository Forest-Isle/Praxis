import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { parseClaudeVersionOutput } from '../../dist/compatibility/claude/schema.js'
import { seedClaudeConfig } from './seed-claude-config.mjs'

export const execFileAsync = promisify(execFile)

const EXPLICIT_PROVIDER_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
]
const MODEL_ENV = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
]

async function overlayProviderSettings(configRoot, environment) {
  const values = {
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: '1',
    ...Object.fromEntries(
      EXPLICIT_PROVIDER_ENV.flatMap((key) =>
        typeof environment[key] === 'string' && environment[key].length > 0
          ? [[key, environment[key]]]
          : [],
      ),
    ),
  }
  const path = join(configRoot, 'settings.json')
  let original
  try {
    original = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const settings = original === undefined ? {} : JSON.parse(original)
  const env =
    settings.env &&
    typeof settings.env === 'object' &&
    !Array.isArray(settings.env)
      ? settings.env
      : {}
  const isolatedEnv = { ...env }
  for (const key of MODEL_ENV) {
    if (!(key in environment)) delete isolatedEnv[key]
  }
  await mkdir(configRoot, { recursive: true })
  await writeFile(
    path,
    `${JSON.stringify({ ...settings, env: { ...isolatedEnv, ...values } })}\n`,
  )
  return original === undefined
    ? () => rm(path, { force: true })
    : () => writeFile(path, original)
}

export async function detectClaudeVersion(
  probeName,
  executable = process.env.PRAXIS_CLAUDE_BINARY ?? 'claude',
) {
  const { stdout } = await execFileAsync(executable, ['--version'])
  const version = parseClaudeVersionOutput(stdout)
  return version
}

export async function runClaudeJson(args, cwd, configRoot, extraEnv = {}) {
  const executable = process.env.PRAXIS_CLAUDE_BINARY ?? 'claude'
  const authenticationProvided = [
    process.env.CLAUDE_CODE_OAUTH_TOKEN,
    process.env.ANTHROPIC_API_KEY,
    process.env.ANTHROPIC_AUTH_TOKEN,
    extraEnv.CLAUDE_CODE_OAUTH_TOKEN,
    extraEnv.ANTHROPIC_API_KEY,
    extraEnv.ANTHROPIC_AUTH_TOKEN,
  ].some((value) => typeof value === 'string' && value.length > 0)
  if (!authenticationProvided) {
    await seedClaudeConfig(configRoot)
  }
  const restoreSettings = await overlayProviderSettings(configRoot, extraEnv)
  try {
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd,
        env: {
          ...process.env,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: '1',
          ...extraEnv,
          CLAUDE_CONFIG_DIR: configRoot,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let output = ''
      let errorOutput = ''
      const timeout = globalThis.setTimeout(() => child.kill(), 120_000)
      child.stdout.on('data', (chunk) => (output += chunk))
      child.stderr.on('data', (chunk) => (errorOutput += chunk))
      child.once('error', reject)
      child.once('exit', (code) => {
        globalThis.clearTimeout(timeout)
        if (code === 0) resolve(output)
        else {
          const error = new Error(
            errorOutput || output || `Claude exited with ${code}`,
          )
          error.code = code
          error.stdout = output
          error.stderr = errorOutput
          reject(error)
        }
      })
      child.stdin.end()
    })
    return JSON.parse(stdout)
  } finally {
    await restoreSettings()
  }
}

export async function writeFixture(path, content) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

export function assertContains(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    throw new Error(`${label} did not expose marker ${needle}`)
  }
}

export function assertNotContains(haystack, needle, label) {
  if (haystack.includes(needle)) {
    throw new Error(`${label} unexpectedly exposed marker ${needle}`)
  }
}
