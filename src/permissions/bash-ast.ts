import Parser, { type SyntaxNode } from 'tree-sitter'
import Bash from 'tree-sitter-bash'

const parser = new Parser()
parser.setLanguage(Bash)
export const MAX_BASH_PERMISSION_COMMANDS = 50

function permissionUnit(node: SyntaxNode): SyntaxNode {
  const parent = node.parent
  return parent?.type === 'redirected_statement' ? parent : node
}

function commandNodes(root: SyntaxNode): readonly SyntaxNode[] {
  const commands: SyntaxNode[] = []
  const visit = (node: SyntaxNode) => {
    if (node.type === 'command') commands.push(permissionUnit(node))
    for (const child of node.namedChildren) visit(child)
  }
  visit(root)
  return commands
}

export interface BashCommandAnalysis {
  commands: readonly string[]
  parsed: boolean
}

export function analyzeBashCommands(source: string): BashCommandAnalysis {
  const trimmed = source.trim()
  if (!trimmed) return { commands: [], parsed: true }
  const tree = parser.parse(source)
  if (tree.rootNode.hasError) {
    return { commands: [trimmed], parsed: false }
  }
  const ranges = new Map<string, SyntaxNode>()
  for (const node of commandNodes(tree.rootNode)) {
    ranges.set(`${node.startIndex}:${node.endIndex}`, node)
  }
  const commands = [...ranges.values()]
    .sort(
      (left, right) =>
        left.startIndex - right.startIndex || right.endIndex - left.endIndex,
    )
    .map((node) => source.slice(node.startIndex, node.endIndex).trim())
    .filter(Boolean)
  if (commands.length > MAX_BASH_PERMISSION_COMMANDS) {
    return { commands: [trimmed], parsed: false }
  }
  return { commands: commands.length > 0 ? commands : [trimmed], parsed: true }
}
