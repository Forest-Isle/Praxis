import { describe, expect, it } from 'vitest'

import { scanSourceBoundaries } from './source-boundaries.mjs'

function scan(projectPath, source) {
  return scanSourceBoundaries([
    {
      projectPath,
      source,
    },
  ])
}

describe('source boundary scanner', () => {
  it('rejects reverse imports from core', () => {
    const failures = scan(
      'src/core/example.ts',
      "import value from '../compatibility/claude/paths.js'",
    )

    expect(failures).toEqual([
      'src/core/example.ts: core cannot import ../compatibility/claude/paths.js',
    ])
  })

  it('rejects forbidden imports from native production modules', () => {
    const failures = scan(
      'src/native/example.ts',
      "import type { ClaudePaths } from '../compatibility/claude/paths.js'",
    )

    expect(failures).toEqual([
      'src/native/example.ts: native cannot import ../compatibility/claude/paths.js',
    ])
  })

  it('allows the explicit native transcript migration compatibility adapter', () => {
    const failures = scan(
      'src/persistence/native-transcript-migration.ts',
      "import { createClaudeTranscriptCodec } from '../compatibility/claude/transcript-codec.js'",
    )

    expect(failures).toEqual([])
  })

  it('rejects forbidden imports from provider adapters', () => {
    const failures = scan(
      'src/providers/example.ts',
      "import('../persistence/data-plane.js')",
    )

    expect(failures).toEqual([
      'src/providers/example.ts: provider cannot import ../persistence/data-plane.js',
    ])
  })

  it('rejects bare Node builtins from core', () => {
    const failures = scan('src/core/example.ts', "import fs from 'fs'")

    expect(failures).toEqual(['src/core/example.ts: core cannot import fs'])
  })

  it('ignores comments and ordinary strings', () => {
    const failures = scan(
      'src/core/example.ts',
      [
        "// import '../platform/project-path-key.js'",
        'const example = "import \'../providers/example.js\'"',
      ].join('\n'),
    )

    expect(failures).toEqual([])
  })

  it('classifies production native files below any native path segment', () => {
    const failures = scan(
      'src/persistence/native/cache.ts',
      "import '../compatibility/claude/paths.js'",
    )

    expect(failures).toEqual([
      'src/persistence/native/cache.ts: native cannot import ../compatibility/claude/paths.js',
    ])
  })

  it('rejects forbidden imports from Claude adapters', () => {
    const failures = scan(
      'src/compatibility/claude/example.ts',
      "export { resolveDataPlanePaths } from '../../persistence/data-plane.js'",
    )

    expect(failures).toEqual([
      'src/compatibility/claude/example.ts: claude cannot import ../../persistence/data-plane.js',
    ])
  })

  it('understands static, type, re-export, side-effect, and dynamic imports', () => {
    const failures = scan(
      'src/core/example.ts',
      [
        "import '../platform/project-path-key.js'",
        "import type { Thing } from '../providers/example.js'",
        "export { value } from '../persistence/data-plane.js'",
        "export * from '../compatibility/claude/paths.js'",
        "const load = () => import('../platform/project-memory-paths.js')",
      ].join('\n'),
    )

    expect(failures).toEqual([
      'src/core/example.ts: core cannot import ../platform/project-path-key.js',
      'src/core/example.ts: core cannot import ../providers/example.js',
      'src/core/example.ts: core cannot import ../persistence/data-plane.js',
      'src/core/example.ts: core cannot import ../compatibility/claude/paths.js',
      'src/core/example.ts: core cannot import ../platform/project-memory-paths.js',
    ])
  })

  it('understands import types and fails closed on dynamic imports', () => {
    const failures = scan(
      'src/core/example.ts',
      [
        "type Paths = typeof import('../compatibility/claude/paths.js')",
        'const load = () => import(`../platform/project-path-key.js`)',
        'const ignored = (name: string) => import(`../providers/${name}.js`)',
      ].join('\n'),
    )

    expect(failures).toEqual([
      'src/core/example.ts: core cannot import ../compatibility/claude/paths.js',
      'src/core/example.ts: core cannot import ../platform/project-path-key.js',
      'src/core/example.ts: core cannot import <dynamic import>',
    ])
  })

  it('allows inward dependencies for each classified module', () => {
    const files = [
      {
        projectPath: 'src/core/example.ts',
        source: "import { ModelProvider } from './runtime.js'",
      },
      {
        projectPath: 'src/native/example.ts',
        source:
          "import { sanitizeProjectPath } from '../platform/project-path-key.js'",
      },
      {
        projectPath: 'src/providers/example.ts',
        source: "import { ModelProvider } from '../core/runtime.js'",
      },
      {
        projectPath: 'src/compatibility/claude/example.ts',
        source:
          "import { sanitizeProjectPath } from '../../platform/project-path-key.js'",
      },
    ]

    expect(scanSourceBoundaries(files)).toEqual([])
  })

  it('follows native roots through shared local modules', () => {
    const failures = scanSourceBoundaries([
      {
        projectPath: 'src/persistence/native/cache.ts',
        source: "import '../shared.js'",
      },
      {
        projectPath: 'src/persistence/shared.ts',
        source: "import '../../compatibility/claude/paths.js'",
      },
    ])

    expect(failures).toEqual([
      'src/persistence/native/cache.ts -> src/persistence/shared.ts: native cannot import ../../compatibility/claude/paths.js',
    ])
  })

  it('follows core roots through shared local modules to builtins', () => {
    const failures = scanSourceBoundaries([
      {
        projectPath: 'src/core/example.ts',
        source: "import '../shared.js'",
      },
      {
        projectPath: 'src/shared.ts',
        source: "import 'node:fs'",
      },
    ])

    expect(failures).toEqual([
      'src/core/example.ts -> src/shared.ts: core cannot import node:fs',
    ])
  })

  it('follows native .js imports to shared TSX modules', () => {
    const failures = scanSourceBoundaries([
      {
        projectPath: 'src/persistence/native/cache.ts',
        source: "import '../shared-view.js'",
      },
      {
        projectPath: 'src/persistence/shared-view.tsx',
        source: "import '../../compatibility/claude/paths.js'",
      },
    ])

    expect(failures).toEqual([
      'src/persistence/native/cache.ts -> src/persistence/shared-view.tsx: native cannot import ../../compatibility/claude/paths.js',
    ])
  })
})
