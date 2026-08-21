import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { arch, platform } from 'node:os'
import { delimiter, isAbsolute, resolve } from 'node:path'

import {
  loadClaudeMcpResources,
  loadClaudeContextResources,
  loadClaudeSettings,
  loadClaudeSharedResources,
  type ClaudeJsonResource,
} from '../compatibility/claude/shared-resources.js'
import { selectClaudeSchemaAdapter } from '../compatibility/claude/schema.js'
import { validateClaudeExtensions } from '../extensions/claude-extensions.js'
import { validateClaudeHooks } from '../hooks/claude-hooks.js'
import { validateClaudeMcpConfiguration } from '../mcp/claude-mcp-tools.js'
import { loadClaudeAutoModeConfig } from '../permissions/claude-auto-classifier.js'
import {
  ClaudePermissionResolver,
  validateClaudePermissionSettings,
} from '../permissions/claude-permission-resolver.js'
import {
  readPluginRegistry,
  validateClaudePlugin,
} from '../plugins/claude-plugin-runtime.js'
import type { DataPlane } from '../persistence/data-plane.js'
import {
  loadNativeContextResources,
  loadNativeSettings,
  loadNativeSharedResources,
} from '../persistence/native-resources.js'
import {
  parseContextEnvironment,
  parseProviderEnvironment,
} from '../providers/environment.js'
import { ContextBudget } from '../core/context-budget.js'
import { ModelPricingRegistry } from '../core/usage.js'
import {
  detectInstalledClaudeVersion,
  type VersionCommand,
} from '../platform/claude-version.js'
import {
  redactSensitiveText,
  sensitiveEnvironmentValues,
} from '../platform/sensitive-data.js'
import {
  collectDoctorLocalDiagnostics,
  resolveDoctorUpdates,
  type DoctorDiagnosticOptions,
  type DoctorInstallationDiagnostic,
  type DoctorPendingUpdateDiagnostic,
  type DoctorUpdateDiagnostic,
  type PraxisDistTagLoader,
} from './doctor-diagnostic.js'

export interface DoctorCheck {
  id:
    | 'installation'
    | 'node'
    | 'provider'
    | 'config-root'
    | 'settings'
    | 'plugins'
    | 'mcp'
    | 'permissions'
    | 'resources'
    | 'hooks'
    | 'claude-runtime'
  status: 'pass' | 'warn' | 'fail'
  summary: string
  details?: Record<string, unknown>
}

export interface DoctorReport {
  type: 'doctor'
  ok: boolean
  praxisVersion: string
  diagnostic: DoctorInstallationDiagnostic
  updates: DoctorUpdateDiagnostic
  checks: readonly DoctorCheck[]
  summary: {
    passed: number
    warnings: number
    failed: number
  }
}

export type DoctorProgressReport = Omit<DoctorReport, 'updates'> & {
  updates: DoctorPendingUpdateDiagnostic
}

export type DoctorProgressListener = (report: DoctorProgressReport) => void

export interface DoctorOptions {
  dataPlane?: DataPlane
  version: string
  executablePath: string
  nodeExecutablePath?: string
  nodeVersion?: string
  configRoot: string
  claudeStatePath: string
  cwd: string
  environment: NodeJS.ProcessEnv
  detectClaudeVersion?: (execute?: VersionCommand) => Promise<string>
  executeVersion?: VersionCommand
  autoUpdateChannel: 'latest' | 'stable'
  invokedBinaryPath?: string
  loadDistTags?: PraxisDistTagLoader
  onProgress?: DoctorProgressListener
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be an array of strings`)
  }
}

function validateSettingsResource(resource: ClaudeJsonResource): void {
  if (!isRecord(resource.value)) {
    throw new Error(`Settings must contain a JSON object: ${resource.path}`)
  }
  const permissions = resource.value.permissions
  if (permissions !== undefined) {
    if (!isRecord(permissions)) {
      throw new Error(`permissions must be an object: ${resource.path}`)
    }
    for (const field of ['allow', 'ask', 'deny'] as const) {
      if (permissions[field] !== undefined) {
        stringArray(
          permissions[field],
          `permissions.${field} in ${resource.path}`,
        )
      }
    }
  }
  const autoMode = resource.value.autoMode
  if (autoMode !== undefined) {
    if (!isRecord(autoMode)) {
      throw new Error(`autoMode must be an object: ${resource.path}`)
    }
    for (const field of [
      'allow',
      'soft_deny',
      'hard_deny',
      'environment',
    ] as const) {
      if (autoMode[field] !== undefined) {
        stringArray(autoMode[field], `autoMode.${field} in ${resource.path}`)
      }
    }
    if (
      autoMode.classifyAllShell !== undefined &&
      typeof autoMode.classifyAllShell !== 'boolean'
    ) {
      throw new Error(
        `autoMode.classifyAllShell must be a boolean: ${resource.path}`,
      )
    }
  }
}

function nodeMajor(version: string): number {
  const match = /^v?(\d+)(?:\.|$)/.exec(version)
  if (!match) throw new Error(`Invalid Node.js version: ${version}`)
  return Number(match[1])
}

async function canonicalExecutable(path: string): Promise<string> {
  const metadata = await stat(path)
  if (!metadata.isFile()) throw new Error(`Executable is not a file: ${path}`)
  await access(path, constants.R_OK)
  return realpath(path)
}

async function validateMcpExecutable(
  command: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const candidates =
    isAbsolute(command) || command.includes('/') || command.includes('\\')
      ? [resolve(cwd, command)]
      : (environment.PATH ?? '')
          .split(delimiter)
          .filter(Boolean)
          .map((root) => resolve(root, command))
  for (const candidate of candidates) {
    try {
      const metadata = await stat(candidate)
      if (metadata.isFile()) {
        await access(candidate, constants.X_OK)
        return
      }
    } catch {
      // Try next PATH entry.
    }
  }
  throw new Error(`MCP stdio executable is not available: ${command}`)
}

function safeBaseUrl(value: string): string {
  let endpoint: URL
  try {
    endpoint = new URL(value)
  } catch (error) {
    throw new Error('PRAXIS_BASE_URL must be a valid URL', { cause: error })
  }
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new Error('PRAXIS_BASE_URL must use http or https')
  }
  if (endpoint.username || endpoint.password) {
    throw new Error('PRAXIS_BASE_URL must not contain credentials')
  }
  endpoint.search = ''
  endpoint.hash = ''
  return endpoint.toString().replace(/\/$/u, '')
}

async function capture(
  id: DoctorCheck['id'],
  operation: () => Promise<
    Omit<DoctorCheck, 'id' | 'status'> & Partial<Pick<DoctorCheck, 'status'>>
  >,
): Promise<DoctorCheck> {
  try {
    const result = await operation()
    return { id, status: 'pass', ...result }
  } catch (error) {
    return {
      id,
      status: 'fail',
      summary: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const configRoot = resolve(options.configRoot)
  const cwd = resolve(options.cwd)
  const dataPlane = options.dataPlane ?? 'claude'
  const sensitiveValues = sensitiveEnvironmentValues(options.environment)
  const diagnosticOptions: DoctorDiagnosticOptions = {
    version: options.version,
    executablePath: options.executablePath,
    ...(options.invokedBinaryPath === undefined
      ? {}
      : { invokedBinaryPath: options.invokedBinaryPath }),
    configRoot,
    environment: options.environment,
    autoUpdateChannel: options.autoUpdateChannel,
    ...(options.loadDistTags === undefined
      ? {}
      : { loadDistTags: options.loadDistTags }),
  }
  const local = await collectDoctorLocalDiagnostics(diagnosticOptions)
  const updatesPromise = resolveDoctorUpdates(diagnosticOptions, local.updates)
  let settings: readonly ClaudeJsonResource[] | undefined
  let nativeResources:
    Awaited<ReturnType<typeof loadNativeSharedResources>> | undefined
  const sharedResources = async () => {
    if (dataPlane === 'claude') {
      return loadClaudeSharedResources({
        configRoot,
        cwd,
        claudeStatePath: options.claudeStatePath,
      })
    }
    nativeResources ??= await loadNativeSharedResources({
      root: configRoot,
      cwd,
    })
    return nativeResources
  }
  const settingsResources = async () =>
    dataPlane === 'claude'
      ? loadClaudeSettings({ configRoot, cwd })
      : loadNativeSettings({ root: configRoot, cwd })
  const checks: DoctorCheck[] = []

  checks.push(
    await capture('installation', async () => {
      const executablePath = await canonicalExecutable(options.executablePath)
      const cwdMetadata = await stat(cwd)
      if (!cwdMetadata.isDirectory()) {
        throw new Error(`Working directory is not a directory: ${cwd}`)
      }
      return {
        summary: `Praxis ${options.version} installation is readable`,
        details: {
          version: options.version,
          executablePath,
          platform: `${platform()}-${arch()}`,
          cwd,
        },
      }
    }),
  )
  checks.push(
    await capture('node', async () => {
      const version = options.nodeVersion ?? process.version
      if (nodeMajor(version) < 24) {
        throw new Error(
          `Node.js ${version} is unsupported; Praxis requires >=24`,
        )
      }
      const executablePath = await canonicalExecutable(
        options.nodeExecutablePath ?? process.execPath,
      )
      return {
        summary: `Node.js ${version} satisfies >=24`,
        details: { version, executablePath },
      }
    }),
  )
  checks.push(
    await capture('claude-runtime', async () => {
      if (dataPlane === 'native') {
        return {
          summary: 'Claude Code runtime is not required in native mode',
          details: { dataPlane },
        }
      }
      const detect = options.detectClaudeVersion ?? detectInstalledClaudeVersion
      const version = await detect(options.executeVersion)
      const adapter = selectClaudeSchemaAdapter(version)
      if (adapter.writeMode !== 'read-write') {
        return {
          status: 'warn',
          summary: `Claude Code ${version} is available in read-only compatibility mode`,
          details: { version, writeMode: adapter.writeMode },
        }
      }
      return {
        summary: `Claude Code ${version} supports shared read-write state`,
        details: { version, writeMode: adapter.writeMode },
      }
    }),
  )
  checks.push(
    await capture('provider', async () => {
      const provider = parseProviderEnvironment(options.environment)
      parseContextEnvironment(options.environment)
      const apiKey = options.environment.PRAXIS_API_KEY
      const model = options.environment.PRAXIS_MODEL
      if (!apiKey || apiKey.trim().length === 0) {
        throw new Error('PRAXIS_API_KEY is required')
      }
      if (!model || model.trim().length === 0) {
        throw new Error('PRAXIS_MODEL is required')
      }
      const baseUrl = safeBaseUrl(provider.baseUrl)
      const contextWindow = options.environment.PRAXIS_CONTEXT_WINDOW_TOKENS
      const contextReserve = options.environment.PRAXIS_CONTEXT_RESERVE_TOKENS
      if (contextWindow !== undefined) {
        const parsedWindow = Number(contextWindow)
        const parsedReserve =
          contextReserve === undefined ? undefined : Number(contextReserve)
        new ContextBudget({
          contextWindowTokens: parsedWindow,
          ...(parsedReserve === undefined
            ? {}
            : { reserveTokens: parsedReserve }),
        })
      }
      const pricing = ModelPricingRegistry.fromEnvironment(
        options.environment.PRAXIS_PRICING_JSON,
      )
      const pricingDiagnosis = pricing.diagnose(model.trim())
      const knownPricing = pricingDiagnosis.source !== 'unknown'
      return {
        ...(knownPricing ? {} : { status: 'warn' as const }),
        summary: knownPricing
          ? `${provider.provider} provider environment is valid; model pricing is ${pricingDiagnosis.source}`
          : `${provider.provider} provider environment is valid; model pricing is unavailable and fail-closed`,
        details: {
          provider: provider.provider,
          model,
          baseUrl,
          pricing: pricingDiagnosis,
        },
      }
    }),
  )
  checks.push(
    await capture('config-root', async () => {
      const metadata = await stat(configRoot)
      if (!metadata.isDirectory()) {
        throw new Error(`Config root is not a directory: ${configRoot}`)
      }
      await access(configRoot, constants.R_OK | constants.W_OK)
      for (const directory of [
        dataPlane === 'native' ? 'sessions' : 'projects',
        'tasks',
        dataPlane === 'native' ? 'state' : 'praxis',
      ]) {
        const path = resolve(configRoot, directory)
        try {
          await access(path, constants.R_OK | constants.W_OK)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      return {
        summary: 'Config root is readable and writable',
        details: { path: await realpath(configRoot) },
      }
    }),
  )
  checks.push(
    await capture('settings', async () => {
      settings = await settingsResources()
      for (const resource of settings) validateSettingsResource(resource)
      return {
        summary: `${settings.length} settings file(s) are valid`,
        details: { files: settings.map((resource) => resource.path) },
      }
    }),
  )
  checks.push(
    await capture('plugins', async () => {
      const registry = await readPluginRegistry(configRoot)
      const names = new Set<string>()
      const paths = new Set<string>()
      for (const entry of registry) {
        if (names.has(entry.name)) {
          throw new Error(`Duplicate plugin registry name: ${entry.name}`)
        }
        names.add(entry.name)
        const plugin = await validateClaudePlugin(entry.path)
        const pluginPath = await realpath(plugin.path)
        if (paths.has(pluginPath)) {
          throw new Error(`Duplicate plugin registry path: ${pluginPath}`)
        }
        paths.add(pluginPath)
        if (plugin.name !== entry.name) {
          throw new Error(
            `Plugin registry name ${entry.name} does not match manifest ${plugin.name}`,
          )
        }
      }
      return {
        summary: `${registry.length} installed plugin(s) are valid`,
        details: {
          plugins: registry.map((entry) => ({
            name: entry.name,
            enabled: entry.enabled,
          })),
        },
      }
    }),
  )
  checks.push(
    await capture('mcp', async () => {
      const resources =
        dataPlane === 'claude'
          ? await loadClaudeMcpResources({
              configRoot,
              cwd,
              claudeStatePath: options.claudeStatePath,
            })
          : (await sharedResources()).mcp
      const report = validateClaudeMcpConfiguration(resources)
      for (const server of report.servers) {
        if (server.transport !== 'stdio' || !server.command) continue
        const serverCwd = server.cwd ? resolve(cwd, server.cwd) : cwd
        const metadata = await stat(serverCwd)
        if (!metadata.isDirectory()) {
          throw new Error(`MCP stdio cwd is not a directory: ${serverCwd}`)
        }
        await validateMcpExecutable(
          server.command,
          serverCwd,
          options.environment,
        )
      }
      return {
        ...(report.warnings.length === 0 ? {} : { status: 'warn' as const }),
        summary: `${report.servers.length} MCP server configuration(s) are valid`,
        details: {
          servers: report.servers,
          ...(report.warnings.length === 0
            ? {}
            : { warnings: report.warnings }),
        },
      }
    }),
  )
  checks.push(
    await capture('resources', async () => {
      const resources = await sharedResources()
      if (dataPlane === 'native') {
        await loadNativeContextResources({ root: configRoot, cwd })
      } else {
        await loadClaudeContextResources({ configRoot, cwd })
      }
      validateClaudeExtensions([
        ...resources.commands,
        ...resources.skills,
        ...resources.agents,
      ])
      return {
        summary: 'Shared instructions, rules, and extensions are readable',
        details: {
          instructions: resources.instructions.length,
          skills: resources.skills.length,
          commands: resources.commands.length,
          agents: resources.agents.length,
        },
      }
    }),
  )
  checks.push(
    await capture('permissions', async () => {
      if (!settings) {
        settings = await settingsResources()
        for (const resource of settings) validateSettingsResource(resource)
      }
      validateClaudePermissionSettings(settings)
      const autoMode = loadClaudeAutoModeConfig(settings)
      new ClaudePermissionResolver({ cwd, settings })
      return {
        summary: 'Permission and auto-mode configuration is valid',
        details: {
          autoMode: {
            allow: autoMode.allow.length,
            softDeny: autoMode.softDeny.length,
            hardDeny: autoMode.hardDeny.length,
            environment: autoMode.environment.length,
            classifyAllShell: autoMode.classifyAllShell,
          },
        },
      }
    }),
  )

  checks.push(
    await capture('hooks', async () => {
      if (!settings) {
        settings = await settingsResources()
        for (const resource of settings) validateSettingsResource(resource)
      }
      validateClaudeHooks(settings)
      return { summary: 'Hook configuration is valid' }
    }),
  )

  for (const check of checks) {
    if (check.status === 'fail') {
      check.summary = redactSensitiveText(check.summary, sensitiveValues)
    }
  }

  const summary = {
    passed: checks.filter((check) => check.status === 'pass').length,
    warnings: checks.filter((check) => check.status === 'warn').length,
    failed: checks.filter((check) => check.status === 'fail').length,
  }
  const base = {
    type: 'doctor' as const,
    ok: checks.every((check) => check.status !== 'fail'),
    praxisVersion: options.version,
    diagnostic: local.diagnostic,
    checks,
    summary,
  }
  options.onProgress?.({ ...base, updates: local.updates })
  const updates = await updatesPromise
  const reportUpdates =
    updates.error === undefined
      ? updates
      : {
          ...updates,
          error: redactSensitiveText(updates.error, sensitiveValues),
        }
  return { ...base, updates: reportUpdates }
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = ['Praxis doctor', '']
  const { diagnostic, updates } = report
  lines.push('Diagnostics')
  lines.push(
    `  Currently running: Praxis ${diagnostic.version} (${diagnostic.installationType})`,
  )
  if (diagnostic.packageManager !== null) {
    lines.push(`  Package manager: ${diagnostic.packageManager}`)
  }
  lines.push(`  Path: ${diagnostic.installationPath}`)
  lines.push(`  Invoked: ${diagnostic.invokedBinary}`)
  lines.push(`  Config install method: ${diagnostic.configInstallMethod}`)
  lines.push(
    `  Search: ${
      diagnostic.search.working
        ? `${diagnostic.search.mode} (${diagnostic.search.systemPath})`
        : 'unavailable'
    }`,
  )
  lines.push('', 'Updates')
  lines.push(`  Auto-updates: ${updates.autoUpdates}`)
  if (updates.hasUpdatePermissions !== null) {
    lines.push(
      `  Update permissions: ${updates.hasUpdatePermissions ? 'yes' : 'no'}`,
    )
  }
  lines.push(`  Update channel: ${updates.channel}`)
  if (updates.registryStatus === 'available') {
    if (updates.stableVersion !== null) {
      lines.push(`  Stable version: ${updates.stableVersion}`)
    }
    lines.push(`  Latest version: ${updates.latestVersion ?? 'unknown'}`)
  } else {
    lines.push('  └ Failed to fetch versions')
  }
  lines.push('')
  for (const check of report.checks) {
    lines.push(`[${check.status.toUpperCase()}] ${check.id}: ${check.summary}`)
    if (check.details) {
      for (const [name, value] of Object.entries(check.details)) {
        lines.push(
          `  ${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
        )
      }
    }
  }
  lines.push(
    '',
    report.summary.failed > 0
      ? `${report.summary.failed} issue(s) found.`
      : report.summary.warnings > 0
        ? 'No blocking issues found.'
        : 'No installation or configuration issues found.',
    `Summary: ${report.summary.passed} passed, ${report.summary.warnings} warnings, ${report.summary.failed} failed.`,
  )
  return `${lines.join('\n')}\n`
}
