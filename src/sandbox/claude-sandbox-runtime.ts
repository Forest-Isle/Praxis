import {
  SandboxManager as BaseSandboxManager,
  type FsWriteRestrictionConfig,
  type SandboxDependencyCheck,
  type SandboxRuntimeConfig,
} from '@anthropic-ai/sandbox-runtime'
import { rmSync } from 'node:fs'

import { shellPermissionMatchCandidates } from '../permissions/bash-normalization.js'
import { shellSubcommands } from '../permissions/permission-updates.js'
import {
  parseShellRule,
  shellRuleMatches,
} from '../permissions/shell-rule-matching.js'
import type { ClaudeSandboxSettings } from './claude-sandbox-settings.js'

export type ClaudeSandboxPlatform = 'macos' | 'linux' | 'windows' | 'wsl'

export interface SandboxBackend {
  initialize(config: SandboxRuntimeConfig): Promise<void>
  isSupportedPlatform(): boolean
  checkDependencies(ripgrep?: {
    command: string
    args?: string[]
  }): SandboxDependencyCheck
  wrapWithSandbox(
    command: string,
    shell?: string,
    config?: Partial<SandboxRuntimeConfig>,
    signal?: AbortSignal,
    options?: { commandId?: string; commandText?: string },
  ): Promise<string>
  getFsWriteConfig(): FsWriteRestrictionConfig
  updateConfig(config: SandboxRuntimeConfig): void
  cleanupAfterCommand(): void
  annotateStderrWithSandboxFailures(commandId: string, stderr: string): string
  reset(): Promise<void>
}

export interface SandboxCommandInput {
  command: string
  dangerouslyDisableSandbox?: boolean
}

function currentPlatform(): ClaudeSandboxPlatform {
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'win32') return 'windows'
  if (
    process.platform === 'linux' &&
    (process.env.WSL_DISTRO_NAME !== undefined ||
      process.env.WSL_INTEROP !== undefined)
  ) {
    return 'wsl'
  }
  return 'linux'
}

function matchesExcludedCommand(command: string, patterns: readonly string[]) {
  if (patterns.length === 0) return false
  let subcommands: readonly string[]
  try {
    subcommands = shellSubcommands(command)
  } catch {
    subcommands = [command]
  }
  if (subcommands.length === 0) subcommands = [command]
  return subcommands.some((subcommand) =>
    shellPermissionMatchCandidates(subcommand, true).some((candidate) =>
      patterns.some((pattern) =>
        shellRuleMatches(parseShellRule(pattern), candidate),
      ),
    ),
  )
}

export class ClaudeSandboxRuntime {
  private active = false
  private initialized = false
  private initializationError: string | undefined
  private settings: ClaudeSandboxSettings | undefined

  constructor(
    private readonly backend: SandboxBackend = BaseSandboxManager,
    private readonly platform: () => ClaudeSandboxPlatform = currentPlatform,
  ) {}

  async initialize(settings: ClaudeSandboxSettings): Promise<void> {
    this.initializationError = undefined
    if (this.initialized && this.active) {
      this.settings = settings
      const unavailableReason = this.unavailableReason(settings)
      if (!settings.enabled || unavailableReason) {
        await this.backend.reset()
        this.active = false
        if (unavailableReason && settings.failIfUnavailable) {
          throw new Error(unavailableReason)
        }
        return
      }
      this.backend.updateConfig(settings.runtimeConfig)
      return
    }
    this.settings = settings
    this.active = false
    this.initialized = true
    if (!settings.enabled) return

    const unavailableReason = this.unavailableReason(settings)
    if (unavailableReason) {
      if (settings.failIfUnavailable) throw new Error(unavailableReason)
      return
    }

    try {
      await this.backend.initialize(settings.runtimeConfig)
      this.active = true
    } catch (error) {
      this.initializationError =
        error instanceof Error ? error.message : String(error)
      if (settings.failIfUnavailable) throw error
    }
  }

  isActive(): boolean {
    return this.active
  }

  isEnabledInSettings(): boolean {
    return this.settings?.enabled ?? false
  }

  isSupportedPlatform(): boolean {
    return this.backend.isSupportedPlatform()
  }

  platformName(): ClaudeSandboxPlatform {
    return this.platform()
  }

  dependencyCheck(
    settings: ClaudeSandboxSettings = this.requireSettings(),
  ): SandboxDependencyCheck {
    const configuredRipgrep = settings.runtimeConfig.ripgrep
    return this.backend.checkDependencies(
      configuredRipgrep
        ? {
            command: configuredRipgrep.command,
            ...(configuredRipgrep.args ? { args: configuredRipgrep.args } : {}),
          }
        : undefined,
    )
  }

  autoAllowsBash(): boolean {
    return this.active && (this.settings?.autoAllowBashIfSandboxed ?? true)
  }

  unavailableReason(
    settings: ClaudeSandboxSettings = this.requireSettings(),
  ): string | undefined {
    if (!settings.enabled) return undefined
    if (!this.backend.isSupportedPlatform()) {
      return `sandbox.enabled is set but ${this.platform()} is not supported`
    }
    if (
      settings.enabledPlatforms !== undefined &&
      !settings.enabledPlatforms.includes(this.platform())
    ) {
      return `sandbox.enabled is set but ${this.platform()} is not in sandbox.enabledPlatforms`
    }
    const dependencies = this.dependencyCheck(settings)
    if (dependencies.errors.length > 0) {
      return `sandbox.enabled is set but dependencies are missing: ${dependencies.errors.join(', ')}`
    }
    if (this.initializationError) {
      return `sandbox.enabled is set but initialization failed: ${this.initializationError}`
    }
    return undefined
  }

  shouldUseSandbox(input: SandboxCommandInput): boolean {
    if (!this.active) return false
    const settings = this.requireSettings()
    if (
      input.dangerouslyDisableSandbox === true &&
      settings.allowUnsandboxedCommands
    ) {
      return false
    }
    return !matchesExcludedCommand(input.command, settings.excludedCommands)
  }

  async wrapCommand(
    input: SandboxCommandInput,
    options: { shell?: string; signal?: AbortSignal; commandId?: string } = {},
  ): Promise<string> {
    if (!this.initialized) throw new Error('Sandbox has not been initialized')
    if (!this.shouldUseSandbox(input)) return input.command
    return this.backend.wrapWithSandbox(
      input.command,
      options.shell,
      undefined,
      options.signal,
      {
        ...(options.commandId ? { commandId: options.commandId } : {}),
        commandText: input.command,
      },
    )
  }

  annotateStderr(commandId: string, stderr: string): string {
    return this.backend.annotateStderrWithSandboxFailures(commandId, stderr)
  }

  cleanupAfterCommand(): void {
    this.backend.cleanupAfterCommand()
    for (const path of this.settings?.bareGitRepoScrubPaths ?? []) {
      try {
        rmSync(path, { recursive: true })
      } catch {
        // Missing or concurrently protected paths are best-effort cleanup.
      }
    }
  }

  getFsWriteConfig(): FsWriteRestrictionConfig | undefined {
    return this.active ? this.backend.getFsWriteConfig() : undefined
  }

  async reset(): Promise<void> {
    this.active = false
    this.initialized = false
    this.initializationError = undefined
    this.settings = undefined
    await this.backend.reset()
  }

  private requireSettings(): ClaudeSandboxSettings {
    if (!this.settings) throw new Error('Sandbox has not been initialized')
    return this.settings
  }
}

export const claudeSandboxRuntime = new ClaudeSandboxRuntime()
