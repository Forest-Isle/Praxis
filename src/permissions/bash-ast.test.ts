import { describe, expect, it } from 'vitest'

import {
  analyzeBashCommands,
  analyzeBashStructure,
  validateBashSemantics,
} from './bash-ast.js'

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

  it('exposes static argv and redirects for path validation', () => {
    expect(
      analyzeBashStructure(
        "NODE_ENV=test timeout 5 cp -- 'input file' output > result.log 2>&1",
      ),
    ).toEqual({
      parsed: true,
      commands: [
        {
          text: "NODE_ENV=test timeout 5 cp -- 'input file' output",
          argv: ['timeout', '5', 'cp', '--', 'input file', 'output'],
        },
      ],
      redirects: [
        { operator: '>', target: 'result.log' },
        { operator: '>&', target: '1' },
      ],
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

  it.each([
    ['eval "rm -rf /"', 'evaluates arguments as shell code'],
    ['nohup timeout 5 nice -2 eval "rm x"', 'evaluates arguments'],
    ['env -i FOO=bar eval "rm x"', 'evaluates arguments'],
    ['env -S "eval rm x"', 'cannot be statically analyzed'],
    ['stdbuf --output 0 eval x', 'cannot be statically analyzed'],
    ['$COMMAND output.txt', 'runtime-determined'],
    ['echo {safe,unsafe}', 'brace expansion'],
    ['cat /proc/self/environ', '/proc/*/environ'],
    ['jq "system(\\"id\\")"', 'system()'],
    ["printf -v 'arr[$(id)]' value", 'array subscript'],
    ['read "name\n# hidden"', 'hide arguments'],
    ['echo\u00a0hidden', 'Unicode whitespace'],
  ])('fails closed for semantic hazard %s', (source, reason) => {
    expect(validateBashSemantics(source)).toMatchObject({
      safe: false,
      reason: expect.stringContaining(reason),
    })
  })

  it.each([
    'command -v npm',
    'fc -ln 1',
    'compgen -c',
    'NODE_ENV=test timeout --signal TERM 5s npm test',
    'nice -10 git status',
    'stdbuf -o0 -e L npm test',
    'env -i -u HOME FOO=bar npm test',
    'echo $(git status)',
  ])('accepts statically modeled command %s', (source) => {
    expect(validateBashSemantics(source)).toEqual({ safe: true })
  })
})
