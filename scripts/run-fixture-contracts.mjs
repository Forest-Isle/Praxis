import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn as defaultSpawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  collectVitestEvidence,
  validateFixtureContracts,
} from './lib/fixture-contracts.mjs'

const PROVIDER_ENV =
  /^(?:ANTHROPIC|CLAUDE|DEEPSEEK|GEMINI|GOOGLE_|MISTRAL|COHERE|XAI_|AZURE_OPENAI|AWS_(?:ACCESS_KEY|SECRET_ACCESS|SESSION_TOKEN|BEDROCK)|OPENAI_)/
const SENSITIVE_ENV = /(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|_MODEL|_BASE_URL)$/
const PRIVATE_ENV = /^(?:PRAXIS_|CODEX_)/

export function sanitizedEnvironment(environment = process.env) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) =>
        key !== 'NODE_OPTIONS' &&
        !PROVIDER_ENV.test(key) &&
        !SENSITIVE_ENV.test(key) &&
        !PRIVATE_ENV.test(key) &&
        key !== 'GITHUB_TOKEN',
    ),
  )
}

function outputAssertions(value) {
  const assertions = []
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry)
      return
    }
    if (Array.isArray(node.assertionResults))
      assertions.push(...node.assertionResults)
    for (const [key, child] of Object.entries(node)) {
      if (key !== 'assertionResults' && child && typeof child === 'object')
        visit(child)
    }
  }
  visit(value)
  return assertions
}

function assertionName(assertion) {
  if (
    Array.isArray(assertion.ancestorTitles) &&
    typeof assertion.title === 'string'
  )
    return [...assertion.ancestorTitles, assertion.title].join(' > ')
  return typeof assertion.fullName === 'string' ? assertion.fullName : ''
}

async function launchVitest({ root, file, outputFile, spawn = defaultSpawn }) {
  const executable = resolve(root, 'node_modules/.bin/vitest')
  const child = spawn(
    executable,
    ['run', file, '--reporter=json', `--outputFile=${outputFile}`],
    {
      cwd: root,
      env: sanitizedEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    },
  )
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding?.('utf8')
  child.stderr?.setEncoding?.('utf8')
  child.stdout?.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr?.on('data', (chunk) => {
    stderr += chunk
  })
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('close', resolveExit)
  })
  return { exitCode, stdout, stderr, outputFile }
}

export async function runFixtureContracts({
  root = fileURLToPath(new URL('../', import.meta.url)),
  spawn = defaultSpawn,
  readJson = async (path) => JSON.parse(await readFile(path, 'utf8')),
} = {}) {
  const result = await validateFixtureContracts(root)
  if (result.diagnostics.length)
    return { ok: false, diagnostics: result.diagnostics }
  const evidence = collectVitestEvidence(result.manifest)
  const uniqueFiles = [...new Set(evidence.map((entry) => entry.file))]
  const temporary = await mkdtemp(join(tmpdir(), 'praxis-fixture-contracts-'))
  const diagnostics = []
  try {
    for (const [index, file] of uniqueFiles.entries()) {
      const outputFile = join(temporary, `vitest-${index}.json`)
      let execution
      try {
        execution = await launchVitest({ root, file, outputFile, spawn })
      } catch (error) {
        for (const entry of evidence.filter(
          (candidate) => candidate.file === file,
        ))
          diagnostics.push(
            `behavior '${entry.behaviorId}' evidence ${file} '${entry.testName}' failed to launch: ${error.message}`,
          )
        continue
      }
      let report
      try {
        report = await readJson(outputFile)
      } catch (error) {
        report = null
        diagnostics.push(
          `Vitest evidence file '${file}' produced no readable JSON report: ${error.message}`,
        )
      }
      const assertions = outputAssertions(report)
      if (execution.exitCode !== 0 && report !== null)
        for (const assertion of assertions) {
          const status = assertion.status
          const name = assertionName(assertion)
          if (
            name &&
            typeof status === 'string' &&
            !['passed', 'skipped', 'pending'].includes(status)
          )
            diagnostics.push(
              `Vitest evidence file '${file}' assertion '${name}' has status ${status} (exit code ${execution.exitCode})`,
            )
        }
      for (const entry of evidence.filter(
        (candidate) => candidate.file === file,
      )) {
        const matches = assertions.filter(
          (assertion) => assertionName(assertion) === entry.testName,
        )
        if (matches.length !== 1) {
          diagnostics.push(
            `behavior '${entry.behaviorId}' evidence ${file} '${entry.testName}' matched ${matches.length} Vitest assertions (exit code ${execution.exitCode})`,
          )
        } else if (matches[0].status !== 'passed') {
          diagnostics.push(
            `behavior '${entry.behaviorId}' evidence ${file} '${entry.testName}' has status ${matches[0].status} (exit code ${execution.exitCode})`,
          )
        }
        if (execution.exitCode !== 0)
          diagnostics.push(
            `behavior '${entry.behaviorId}' evidence ${file} '${entry.testName}' exited with code ${execution.exitCode}: ${(execution.stderr || execution.stdout).trim()}`,
          )
      }
    }
    if (diagnostics.length)
      return {
        ok: false,
        diagnostics: [...new Set(diagnostics)].sort((a, b) =>
          a.localeCompare(b),
        ),
      }
    return {
      ok: true,
      behaviorCount: result.manifest.behaviors.length,
      evidenceCount: evidence.length,
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runFixtureContracts()
  if (!result.ok) {
    console.error(result.diagnostics.map((entry) => `- ${entry}`).join('\n'))
    process.exitCode = 1
  } else {
    console.log(
      `Fixture execution passed: ${result.behaviorCount} behaviors, ${result.evidenceCount} Vitest evidence entries`,
    )
  }
}
