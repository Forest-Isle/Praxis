import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  applyCompatibilityEndpointModelOverrides,
  buildQualificationEnvironment,
  canonicalizePrerequisiteBinaries,
  classifyGateError,
  classifyQualification,
  discoverCompatibilityEntrypoints,
  findMissingPrerequisites,
  qualificationExitCode,
  resolvePrimaryReferenceBinary,
  selectPrimaryReferenceBinary,
} from './compatibility-qualification.mjs'

describe('compatibility qualification environment', () => {
  it('removes ambient selection while preserving credentials and fixed paths', () => {
    const environment = buildQualificationEnvironment(
      {
        PATH: '/usr/bin',
        ANTHROPIC_API_KEY: 'secret',
        ANTHROPIC_BASE_URL: 'https://host.example',
        ANTHROPIC_MODEL: 'host-model',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'host-haiku',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'host-opus',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'host-sonnet',
        CLAUDE_CONFIG_DIR: '/host/config',
        PRAXIS_BASE_URL: 'https://praxis.example',
        PRAXIS_MODEL: 'host-praxis-model',
        PRAXIS_CONFIG_DIR: '/host/praxis',
        PRAXIS_HOME: '/host/native-data',
        PRAXIS_DATA_PLANE: 'native',
        PRAXIS_CLAUDE_BINARY: 'claude-old',
        CLAUDE_CODE_USE_BEDROCK: '1',
        CLAUDE_CODE_SUBAGENT_MODEL: 'host-subagent-model',
        ANTHROPIC_BEDROCK_BASE_URL: 'https://bedrock.example',
        AWS_REGION: 'us-west-2',
      },
      {
        configRoot: '/tmp/qualification-config',
        projectRoot: '/repo',
        realClaudeBinary: '/real/claude',
        referenceBinary: '/versions/claude-2',
      },
    )

    expect(environment).toMatchObject({
      PATH: expect.stringContaining('/repo/scripts'),
      PRAXIS_PROVIDER: 'openai',
      PRAXIS_DATA_PLANE: 'claude',
      CLAUDE_CONFIG_DIR: '/tmp/qualification-config',
      PRAXIS_REAL_CLAUDE_BINARY: '/real/claude',
      PRAXIS_CLAUDE_BINARY: '/versions/claude-2',
    })
    expect(environment.ANTHROPIC_API_KEY).toBe('secret')
    for (const key of [
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'CLAUDE_CONFIG_DIR',
      'PRAXIS_BASE_URL',
      'PRAXIS_MODEL',
      'PRAXIS_CONFIG_DIR',
      'PRAXIS_HOME',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_SUBAGENT_MODEL',
      'ANTHROPIC_BEDROCK_BASE_URL',
      'AWS_REGION',
    ]) {
      if (key !== 'CLAUDE_CONFIG_DIR') expect(environment[key]).toBeUndefined()
    }
  })

  it('applies only explicit non-blank endpoint and model overrides', () => {
    const isolated = { PATH: '/usr/bin', PRAXIS_API_KEY: 'preserved' }
    expect(
      applyCompatibilityEndpointModelOverrides(isolated, {
        ANTHROPIC_BASE_URL: 'https://host.example',
        ANTHROPIC_MODEL: 'host-model',
        PRAXIS_COMPAT_ANTHROPIC_BASE_URL: ' https://gateway.example ',
        PRAXIS_COMPAT_CLAUDE_MODEL: ' deepseek-v4-flash ',
        PRAXIS_API_KEY: 'preserved',
      }),
    ).toEqual({
      PATH: '/usr/bin',
      PRAXIS_API_KEY: 'preserved',
      ANTHROPIC_BASE_URL: 'https://gateway.example',
      ANTHROPIC_MODEL: 'deepseek-v4-flash',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-flash',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-flash',
    })
    expect(
      applyCompatibilityEndpointModelOverrides(isolated, {
        ANTHROPIC_BASE_URL: 'https://host.example',
        ANTHROPIC_MODEL: 'host-model',
        PRAXIS_COMPAT_ANTHROPIC_BASE_URL: '  ',
        PRAXIS_COMPAT_CLAUDE_MODEL: '',
      }),
    ).toEqual(isolated)
  })

  it('reports every missing required lane before execution', () => {
    const missing = findMissingPrerequisites(
      [
        { file: 'scripts/verify-cross-version-session-compatibility.mjs' },
        { file: 'scripts/verify-plugin-eval-compatibility.mjs' },
      ],
      new Map([
        [
          'scripts/verify-cross-version-session-compatibility.mjs',
          ['PRAXIS_CLAUDE_BINARY', 'PRAXIS_CLAUDE_CROSS_VERSION_BINARY'],
        ],
        [
          'scripts/verify-plugin-eval-compatibility.mjs',
          ['PRAXIS_CLAUDE_2_1_237'],
        ],
      ]),
      { PRAXIS_CLAUDE_BINARY: '/real/claude' },
    )

    expect(missing).toEqual([
      {
        file: 'scripts/verify-cross-version-session-compatibility.mjs',
        missing: ['PRAXIS_CLAUDE_CROSS_VERSION_BINARY'],
      },
      {
        file: 'scripts/verify-plugin-eval-compatibility.mjs',
        missing: ['PRAXIS_CLAUDE_2_1_237'],
      },
    ])
  })

  it('selects a non-wrapper primary binary from canonical candidates', () => {
    expect(
      selectPrimaryReferenceBinary(
        ['/repo/scripts/claude', '/usr/local/bin/claude'],
        '/repo/scripts/claude',
      ),
    ).toBe('/usr/local/bin/claude')
    expect(
      resolvePrimaryReferenceBinary(process.execPath, {
        path: process.env.PATH,
        wrapperPath: '/repo/scripts/claude',
      }),
    ).toBe(realpathSync(process.execPath))
  })

  it('canonicalizes supplied binaries and reports an exact invalid prerequisite key', () => {
    const { environment, invalid } = canonicalizePrerequisiteBinaries({
      PATH: process.env.PATH,
      PRAXIS_CLAUDE_CROSS_VERSION_BINARY: process.execPath,
      PRAXIS_CLAUDE_2_1_237: '/path/that/does/not/exist',
    })

    expect(environment.PRAXIS_CLAUDE_CROSS_VERSION_BINARY).toBe(
      realpathSync(process.execPath),
    )
    expect(invalid).toEqual(['PRAXIS_CLAUDE_2_1_237'])
  })

  it('discovers all compatibility entrypoints from the repository package scripts', async () => {
    const packageDocument = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    )
    const entrypoints = discoverCompatibilityEntrypoints(
      packageDocument.scripts,
    )
    const files = new Set(entrypoints.map(({ file }) => file))

    for (const file of [
      'scripts/verify-claude-compatibility.mjs',
      'scripts/verify-cross-version-session-compatibility.mjs',
      'scripts/verify-cross-version-resume-at-compatibility.mjs',
      'scripts/verify-cross-version-fork-compatibility.mjs',
      'scripts/verify-cross-version-sidechain-compatibility.mjs',
      'scripts/verify-cross-version-compaction-compatibility.mjs',
      'scripts/verify-plugin-eval-compatibility.mjs',
      'scripts/verify-tui-compatibility.mjs',
    ]) {
      expect(files).toContain(file)
    }
    expect(files).not.toContain('scripts/verify-native-deletion.mjs')
    expect(files).not.toContain('scripts/verify-core-completion-audit.mjs')
    expect(files).not.toContain('scripts/verify-active-stream-regression.mjs')
  })

  it('blocks the aggregate entrypoint when required version binaries are missing', () => {
    const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
    const environment = {
      ...process.env,
      PRAXIS_CLAUDE_BINARY: process.execPath,
    }
    for (const key of [
      'PRAXIS_CLAUDE_CROSS_VERSION_BINARY',
      'PRAXIS_CLAUDE_2_1_208',
      'PRAXIS_CLAUDE_2_1_237',
    ]) {
      delete environment[key]
    }
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL('../verify-compatibility-matrix.mjs', import.meta.url),
        ),
      ],
      {
        cwd: projectRoot,
        env: environment,
        encoding: 'utf8',
      },
    )

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('[qualification blocked]')
    expect(result.stderr).toContain('PRAXIS_CLAUDE_CROSS_VERSION_BINARY')
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/passed|qualified/iu)
  })
})

describe('compatibility qualification verdicts', () => {
  it('only completes with no failures, blocks, or skips', () => {
    expect(classifyQualification({ failures: 0, blocked: 0, skipped: 0 })).toBe(
      'complete',
    )
    expect(classifyQualification({ failures: 0, blocked: 1, skipped: 0 })).toBe(
      'blocked',
    )
    expect(classifyQualification({ failures: 0, blocked: 0, skipped: 1 })).toBe(
      'skipped',
    )
    expect(classifyQualification({ failures: 1, blocked: 1, skipped: 1 })).toBe(
      'failed',
    )
    expect(qualificationExitCode('complete')).toBe(0)
    expect(qualificationExitCode('blocked')).toBe(2)
    expect(qualificationExitCode('skipped')).toBe(3)
    expect(qualificationExitCode('failed')).toBe(1)
  })

  it('classifies external authentication and balance failures as blocked', () => {
    for (const diagnostics of [
      'Not logged in',
      'Please run /login',
      'authentication_error: invalid credentials',
      'API Error: 401 invalid API key',
      'Authentication failed',
      'Unauthorized',
      'invalid API key for Claude',
      'expired credentials',
    ]) {
      expect(classifyGateError({ diagnostics })).toEqual({
        verdict: 'blocked',
        prerequisite: 'Claude credentials',
      })
    }
    for (const diagnostics of [
      'insufficient balance for this request',
      '402 Insufficient Balance',
    ]) {
      expect(classifyGateError({ diagnostics })).toEqual({
        verdict: 'blocked',
        prerequisite: 'Claude account balance',
      })
    }
    expect(
      classifyGateError({ diagnostics: 'assertion failed: marker missing' }),
    ).toEqual({
      verdict: 'failed',
    })
    expect(
      classifyGateError({ diagnostics: 'expected 403, received 404' }),
    ).toEqual({
      verdict: 'failed',
    })
    expect(
      classifyGateError({
        diagnostics: 'assertion failed: unauthorized response was accepted',
      }),
    ).toEqual({ verdict: 'failed' })
  })
})
