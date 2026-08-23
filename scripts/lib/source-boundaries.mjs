import { builtinModules } from 'node:module'
import { basename, dirname, posix } from 'node:path'

import ts from 'typescript'

const BUILTINS = new Set(
  builtinModules.map((specifier) =>
    specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier,
  ),
)
const DYNAMIC_IMPORT_SPECIFIER = '<dynamic import>'

function importsIn(projectPath, source) {
  const scriptKind = projectPath.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(
    projectPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  )
  const imports = []
  function moduleSpecifierText(node) {
    if (
      node &&
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ) {
      return node.text
    }
    if (node && ts.isLiteralTypeNode(node)) {
      return moduleSpecifierText(node.literal)
    }
    return undefined
  }
  function add(node, moduleSpecifier) {
    const specifier = moduleSpecifierText(moduleSpecifier)
    if (specifier !== undefined) {
      imports.push({
        index: node.getStart(sourceFile),
        specifier,
      })
    }
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node, node.moduleSpecifier)
    } else if (ts.isImportTypeNode(node)) {
      add(node, node.argument)
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const argument = node.arguments[0]
      if (moduleSpecifierText(argument) === undefined) {
        imports.push({
          index: node.getStart(sourceFile),
          specifier: DYNAMIC_IMPORT_SPECIFIER,
        })
      } else {
        add(node, argument)
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node, node.moduleReference.expression)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return imports
    .sort((left, right) => left.index - right.index)
    .map(({ specifier }) => specifier)
}

function moduleKind(projectPath) {
  const segments = projectPath.split('/')
  if (segments[1] === 'core') return 'core'
  if (segments[1] === 'providers') return 'provider'
  if (segments[1] === 'compatibility' && segments[2] === 'claude') {
    return 'claude'
  }
  if (projectPath.includes('.test.')) return undefined
  const file = basename(projectPath)
  if (segments.includes('native') || file.startsWith('native-')) {
    return 'native'
  }
  return undefined
}

function contains(specifier, name) {
  return specifier
    .split('/')
    .some(
      (segment) =>
        segment === name ||
        segment.startsWith(`${name}-`) ||
        segment.startsWith(`${name}.`),
    )
}

function isBuiltin(specifier) {
  const bareSpecifier = specifier.startsWith('node:')
    ? specifier.slice('node:'.length)
    : specifier
  const builtinName = bareSpecifier.split('/')[0]
  return BUILTINS.has(builtinName)
}

function forbiddenSpecifier(kind, specifier) {
  if (specifier === DYNAMIC_IMPORT_SPECIFIER) return kind
  if (kind === 'core') {
    if (isBuiltin(specifier) || contains(specifier, 'persistence')) {
      return 'core'
    }
    if (
      contains(specifier, 'platform') ||
      contains(specifier, 'providers') ||
      contains(specifier, 'compatibility') ||
      contains(specifier, 'ink') ||
      contains(specifier, 'react')
    ) {
      return 'core'
    }
  }
  if (kind === 'provider') {
    if (
      contains(specifier, 'compatibility') ||
      contains(specifier, 'persistence') ||
      contains(specifier, 'application') ||
      contains(specifier, 'cli')
    ) {
      return 'provider'
    }
  }
  if (kind === 'native') {
    if (
      contains(specifier, 'compatibility') ||
      contains(specifier, 'providers')
    ) {
      return 'native'
    }
  }
  if (kind === 'claude') {
    if (
      contains(specifier, 'providers') ||
      (contains(specifier, 'persistence') &&
        !specifier.endsWith('/data-plane-adapter.js')) ||
      contains(specifier, 'application') ||
      contains(specifier, 'cli')
    ) {
      return 'claude'
    }
  }
  return undefined
}

function localEntryPath(projectPath, specifier, entries) {
  if (!specifier.startsWith('.')) return undefined
  const base = posix.normalize(posix.join(dirname(projectPath), specifier))
  const candidates = []
  if (base.endsWith('.js')) {
    const sourceBase = base.slice(0, -3)
    candidates.push(`${sourceBase}.ts`, `${sourceBase}.tsx`)
  } else if (base.endsWith('.jsx')) {
    const sourceBase = base.slice(0, -4)
    candidates.push(`${sourceBase}.tsx`, `${sourceBase}.ts`)
  }
  candidates.push(
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  )
  return candidates.find((candidate) => entries.has(candidate))
}

/** Scan source entries and their reachable local relative imports. */
export function scanSourceBoundaries(files) {
  const entries = new Map(
    files.map(({ projectPath, source }) => [projectPath, source]),
  )
  const failures = []
  const seenFailures = new Set()
  const roots = [...entries.keys()].filter((projectPath) =>
    moduleKind(projectPath),
  )

  function report(root, chain, kind, specifier) {
    const location = chain.length === 1 ? chain[0] : chain.join(' -> ')
    const failure = `${location}: ${kind} cannot import ${specifier}`
    if (!seenFailures.has(failure)) {
      seenFailures.add(failure)
      failures.push(failure)
    }
  }

  for (const root of roots) {
    const kind = moduleKind(root)
    const visited = new Set()
    const visit = (projectPath, chain) => {
      if (visited.has(projectPath)) return
      visited.add(projectPath)
      for (const specifier of importsIn(
        projectPath,
        entries.get(projectPath),
      )) {
        if (forbiddenSpecifier(kind, specifier)) {
          report(root, chain, kind, specifier)
        }
        const importedPath = localEntryPath(projectPath, specifier, entries)
        if (importedPath) visit(importedPath, [...chain, importedPath])
      }
    }
    visit(root, [root])
  }
  return failures
}

export { importsIn }
