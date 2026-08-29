import { describe, expect, it } from 'vitest'
import {
  canonicalTriageLabels,
  extractMarkdownStructure,
  governanceDiagnostics,
} from './document-governance.mjs'

const table = `| Skill role | Tracker label | Meaning |
| --- | --- | --- |
${canonicalTriageLabels.map((label) => `| \`${label}\` | \`${label}\` | x |`).join('\n')}`
const forms = [{ path: 'bug.yml', labels: ['bug', 'needs-triage'] }]

describe('document governance verifier', () => {
  it('accepts matching README structures and canonical forms', () => {
    expect(
      governanceDiagnostics({
        englishReadme: '# A\n\n```sh\nrun\n```\n## B',
        chineseReadme: '# 甲\n\n```sh\n运行\n```\n## 乙',
        issueForms: forms,
        triageDocumentation: table,
      }),
    ).toEqual([])
  })

  it('detects heading and fence mismatches', () => {
    const diagnostics = governanceDiagnostics({
      englishReadme: '# A\n```sh\nx\n```',
      chineseReadme: '# A\n## B\n```text\nx\n```',
      issueForms: forms,
      triageDocumentation: table,
    })
    expect(diagnostics.join('\n')).toContain('heading-level')
    expect(diagnostics.join('\n')).toContain('fenced-code')
  })

  it('ignores headings inside backtick and tilde fences', () => {
    expect(
      extractMarkdownStructure(
        '## A\n```md\n# hidden\n```\n~~~text\n## hidden\n~~~\n### C',
      ),
    ).toEqual({ headings: [2, 3], fences: ['md', 'text'] })
  })

  it.each([
    ['zero canonical roles', []],
    ['multiple canonical roles', ['needs-triage', 'ready-for-agent']],
  ])('rejects %s', (_name, labels) => {
    expect(
      governanceDiagnostics({
        englishReadme: '',
        chineseReadme: '',
        issueForms: [{ path: 'x.yml', labels }],
        triageDocumentation: table,
      }).join('\n'),
    ).toContain('exactly one canonical')
  })

  it('rejects obsolete triage and malformed tables', () => {
    const diagnostics = governanceDiagnostics({
      englishReadme: '',
      chineseReadme: '',
      issueForms: [
        { path: 'x.yml', labels: ['bug', 'needs-triage', 'triage'] },
      ],
      triageDocumentation: table.replace(
        '`wontfix` | `wontfix`',
        '`wontfix` | `wrong`',
      ),
    })
    expect(diagnostics.join('\n')).toContain('undocumented triage label')
    expect(diagnostics.join('\n')).toContain('exactly the five canonical')
  })

  it('rejects a role-shaped label outside the canonical set', () => {
    const diagnostics = governanceDiagnostics({
      englishReadme: '',
      chineseReadme: '',
      issueForms: [{ path: 'x.yml', labels: ['bug', 'needs-review'] }],
      triageDocumentation: table,
    })
    expect(diagnostics.join('\n')).toContain('undocumented triage label')
  })

  it('rejects extra triage table roles', () => {
    const diagnostics = governanceDiagnostics({
      englishReadme: '',
      chineseReadme: '',
      issueForms: forms,
      triageDocumentation: `${table}\n| \`help-wanted\` | \`help-wanted\` | x |`,
    })
    expect(diagnostics.join('\n')).toContain('exactly the five canonical')
  })
})
