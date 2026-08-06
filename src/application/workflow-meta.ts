import { parse } from 'acorn'

export interface WorkflowPhaseDefinition {
  title: string
  detail?: string
  model?: string
}

export interface WorkflowMeta {
  name: string
  description: string
  phases?: readonly WorkflowPhaseDefinition[]
  whenToUse?: string
}

export interface ParsedWorkflowScript {
  meta: WorkflowMeta
  body: string
}

type AstNode = Record<string, unknown> & {
  type: string
  start: number
  end: number
}

function literal(node: AstNode): unknown {
  if (node.type === 'Literal') return node.value
  if (node.type === 'ArrayExpression') {
    return (node.elements as (AstNode | null)[]).map((element) => {
      if (!element) throw new Error('array holes are not allowed in meta')
      return literal(element)
    })
  }
  if (node.type === 'ObjectExpression') {
    const result: Record<string, unknown> = {}
    for (const property of node.properties as AstNode[]) {
      if (
        property.type !== 'Property' ||
        property.kind !== 'init' ||
        property.computed === true ||
        property.method === true ||
        property.shorthand === true
      ) {
        throw new Error(`non-literal node type in meta: ${property.type}`)
      }
      const keyNode = property.key as AstNode
      const key =
        keyNode.type === 'Identifier'
          ? String(keyNode.name)
          : String(literal(keyNode))
      result[key] = literal(property.value as AstNode)
    }
    return result
  }
  if (node.type === 'UnaryExpression' && node.operator === '-') {
    const value = literal(node.argument as AstNode)
    if (typeof value === 'number') return -value
  }
  throw new Error(`non-literal node type in meta: ${node.type}`)
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`meta.${field} must be a non-empty string`)
  }
  return value
}

function validateMeta(value: unknown): WorkflowMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('meta must be an object literal')
  }
  const record = value as Record<string, unknown>
  const name = nonEmpty(record.name, 'name')
  const description = nonEmpty(record.description, 'description')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(name)) {
    throw new Error('meta.name contains invalid characters')
  }
  let phases: WorkflowPhaseDefinition[] | undefined
  if (record.phases !== undefined) {
    if (!Array.isArray(record.phases))
      throw new Error('meta.phases must be an array')
    phases = record.phases.map((phase, index) => {
      if (!phase || typeof phase !== 'object' || Array.isArray(phase)) {
        throw new Error(`meta.phases[${index}] must be an object`)
      }
      const item = phase as Record<string, unknown>
      const title = nonEmpty(item.title, `phases[${index}].title`)
      if (item.detail !== undefined && typeof item.detail !== 'string') {
        throw new Error(`meta.phases[${index}].detail must be a string`)
      }
      if (item.model !== undefined && typeof item.model !== 'string') {
        throw new Error(`meta.phases[${index}].model must be a string`)
      }
      return {
        title,
        ...(item.detail === undefined ? {} : { detail: item.detail }),
        ...(item.model === undefined ? {} : { model: item.model }),
      }
    })
  }
  if (record.whenToUse !== undefined && typeof record.whenToUse !== 'string') {
    throw new Error('meta.whenToUse must be a string')
  }
  return {
    name,
    description,
    ...(phases ? { phases } : {}),
    ...(record.whenToUse === undefined ? {} : { whenToUse: record.whenToUse }),
  }
}

export function parseWorkflowScript(script: string): ParsedWorkflowScript {
  let program: AstNode
  try {
    program = parse(script, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    }) as unknown as AstNode
  } catch (error) {
    throw new Error(`Invalid workflow script: ${(error as Error).message}`)
  }
  const statements = program.body as AstNode[]
  const first = statements[0]
  if (!first || first.type !== 'ExportNamedDeclaration') {
    throw new Error(
      'Invalid workflow script: `export const meta = { name, description, phases }` must be the FIRST statement in the script',
    )
  }
  const declaration = first.declaration as AstNode | null
  const declarators = declaration?.declarations as AstNode[] | undefined
  const item = declarators?.[0]
  if (
    declaration?.type !== 'VariableDeclaration' ||
    declaration.kind !== 'const' ||
    declarators?.length !== 1 ||
    item?.id == null ||
    (item.id as AstNode).type !== 'Identifier' ||
    (item.id as AstNode).name !== 'meta' ||
    !item.init
  ) {
    throw new Error(
      'Invalid workflow script: `export const meta = { name, description, phases }` must be the FIRST statement in the script',
    )
  }
  let meta: WorkflowMeta
  try {
    meta = validateMeta(literal(item.init as AstNode))
  } catch (error) {
    const message = (error as Error).message
    throw new Error(
      message.startsWith('meta.')
        ? `Invalid workflow script: ${message}`
        : `Invalid workflow script: meta must be a pure literal: ${message}`,
    )
  }
  return { meta, body: script.slice(first.end) }
}
