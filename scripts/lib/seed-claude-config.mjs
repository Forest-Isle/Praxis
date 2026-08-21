import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MARKER = '.praxis-compat-auth-seeded'
const AUTHENTICATION_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
])

async function exists(path) {
  try {
    await access(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function merge(base, override) {
  if (
    !base ||
    typeof base !== 'object' ||
    Array.isArray(base) ||
    !override ||
    typeof override !== 'object' ||
    Array.isArray(override)
  ) {
    return override
  }
  const result = { ...base }
  for (const [key, value] of Object.entries(override)) {
    result[key] = key in base ? merge(base[key], value) : value
  }
  return result
}

async function seedJson(source, destination, selectBase) {
  const base = selectBase(JSON.parse(await readFile(source, 'utf8')))
  const override = (await exists(destination))
    ? JSON.parse(await readFile(destination, 'utf8'))
    : {}
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, `${JSON.stringify(merge(base, override))}\n`)
}

function authenticationState(source) {
  const keys = [
    'customApiKeyResponses',
    'hasCompletedOnboarding',
    'lastOnboardingVersion',
  ]
  return Object.fromEntries(
    keys
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, source[key]]),
  )
}

function authenticationSettings(source) {
  const env =
    source.env && typeof source.env === 'object' && !Array.isArray(source.env)
      ? Object.fromEntries(
          Object.entries(source.env).filter(([key]) =>
            AUTHENTICATION_ENV_KEYS.has(key),
          ),
        )
      : {}
  return Object.keys(env).length > 0 ? { env } : {}
}

export async function seedClaudeConfig(configRoot, homeDirectory = homedir()) {
  const marker = join(configRoot, MARKER)
  if (await exists(marker)) return
  await mkdir(configRoot, { recursive: true })
  await seedJson(
    join(homeDirectory, '.claude.json'),
    join(configRoot, '.claude.json'),
    authenticationState,
  )
  await seedJson(
    join(homeDirectory, '.claude', 'settings.json'),
    join(configRoot, 'settings.json'),
    authenticationSettings,
  )
  await writeFile(marker, '')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const configRoot = process.argv[2]
  if (!configRoot)
    throw new Error('Usage: seed-claude-config.mjs <config-root>')
  await seedClaudeConfig(configRoot)
}
