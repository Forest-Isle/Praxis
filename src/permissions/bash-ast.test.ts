import { describe, expect, it } from 'vitest'

import { analyzeBashCommands } from './bash-ast.js'

describe('Bash AST permission analysis', () => {
  it('extracts compound and pipeline commands without splitting quoted text', () => {
    expect(
      analyzeBashCommands("echo 'a;b|c' && npm test | tee output.log"),
    ).toEqual({
      parsed: true,
      commands: ["echo 'a;b|c'", 'npm test', 'tee output.log'],
    })
  })

  it('includes nested substitutions and control-flow bodies', () => {
    expect(
      analyzeBashCommands(
        'if test -f package.json; then echo $(git status); else npm test; fi',
      ),
    ).toEqual({
      parsed: true,
      commands: [
        'test -f package.json',
        'echo $(git status)',
        'git status',
        'npm test',
      ],
    })
  })

  it('keeps redirections attached to the executable permission unit', () => {
    expect(analyzeBashCommands('npm test > output.log 2>&1')).toEqual({
      parsed: true,
      commands: ['npm test > output.log 2>&1'],
    })
  })

  it('handles subshells, functions, background lists, and heredocs', () => {
    const source =
      'function check(){ npm test; }; (cd src && check) & cat <<EOF\nvalue\nEOF\ngit status'
    expect(analyzeBashCommands(source)).toEqual({
      parsed: true,
      commands: [
        'npm test',
        'cd src',
        'check',
        'cat <<EOF\nvalue\nEOF',
        'git status',
      ],
    })
  })

  it('fails closed to the complete source when parsing is incomplete', () => {
    expect(analyzeBashCommands("echo 'unterminated && rm -rf / ")).toEqual({
      parsed: false,
      commands: ["echo 'unterminated && rm -rf /"],
    })
  })

  it('bounds permission analysis fanout', () => {
    const source = Array.from(
      { length: 51 },
      (_, index) => `tool${index}`,
    ).join('; ')
    expect(analyzeBashCommands(source)).toEqual({
      parsed: false,
      commands: [source],
    })
  })
})
