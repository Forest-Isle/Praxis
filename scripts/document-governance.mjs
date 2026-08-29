export const canonicalTriageLabels = Object.freeze([
  'needs-triage',
  'needs-info',
  'ready-for-agent',
  'ready-for-human',
  'wontfix',
])

export function extractMarkdownStructure(source) {
  const headings = []
  const fences = []
  let fence = null

  for (const line of source.split(/\r?\n/)) {
    const opening = line.match(/^\s*(`{3,}|~{3,})(.*)$/)
    if (fence) {
      const closing = line.match(/^\s*(`{3,}|~{3,})\s*$/)
      if (
        closing &&
        closing[1][0] === fence.character &&
        closing[1].length >= fence.length
      )
        fence = null
      continue
    }
    if (opening) {
      const marker = opening[1]
      fences.push(opening[2].trim().split(/\s+/)[0] ?? '')
      fence = { character: marker[0], length: marker.length }
      continue
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+.*?\s*#*\s*$/)
    if (heading) headings.push(heading[1].length)
  }

  return { headings, fences }
}

export function extractTriageTable(source) {
  const rows = []
  for (const line of source.split(/\r?\n/)) {
    if (!/^\s*\|/u.test(line)) continue
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim().replace(/^`|`$/gu, ''))
    if (cells.length < 2) continue
    if (cells.every((cell) => /^:?-{3,}:?$/u.test(cell))) continue
    if (cells[0].toLowerCase() === 'skill role') continue
    rows.push({ role: cells[0], label: cells[1] })
  }
  return rows
}

function sameStructure(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function governanceDiagnostics({
  englishReadme,
  chineseReadme,
  issueForms,
  triageDocumentation,
}) {
  const diagnostics = []
  const english = extractMarkdownStructure(englishReadme)
  const chinese = extractMarkdownStructure(chineseReadme)
  if (JSON.stringify(english.headings) !== JSON.stringify(chinese.headings))
    diagnostics.push('README heading-level sequences must match')
  if (JSON.stringify(english.fences) !== JSON.stringify(chinese.fences))
    diagnostics.push('README fenced-code language sequences must match')

  const table = extractTriageTable(triageDocumentation)
  const expected = canonicalTriageLabels.map((label) => ({
    role: label,
    label,
  }))
  if (!sameStructure(table, expected))
    diagnostics.push(
      'Triage documentation must define exactly the five canonical role/label pairs',
    )

  for (const form of issueForms) {
    const labels = Array.isArray(form.labels) ? form.labels : []
    const canonical = labels.filter((label) =>
      canonicalTriageLabels.includes(label),
    )
    if (canonical.length !== 1)
      diagnostics.push(
        `${form.path} must define exactly one canonical triage label`,
      )
    const triageLike = labels.filter(
      (label) =>
        typeof label === 'string' &&
        /triage|^(?:needs|ready)-|^wontfix$/iu.test(label),
    )
    for (const label of triageLike) {
      if (!canonicalTriageLabels.includes(label))
        diagnostics.push(
          `${form.path} references undocumented triage label: ${label}`,
        )
    }
  }
  return diagnostics
}
