import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { parse } from 'yaml'

const releasePath = '.github/workflows/release-please.yml'
const dependencyPath = '.github/workflows/dependency-review.yml'
const releaseSource = await readFile(releasePath, 'utf8')
const dependency = parse(await readFile(dependencyPath, 'utf8'))

assert.ok(
  dependency.on?.workflow_dispatch !== undefined,
  'Dependency review must support release-branch dispatch',
)

for (const workflow of ['ci.yml', 'codeql.yml', 'dependency-review.yml']) {
  assert.match(
    releaseSource,
    new RegExp(
      `WORKFLOWS=\\([^\\n]*${workflow.replace('.', '\\.')}[^\\n]*\\)`,
      'u',
    ),
    `Release Please must dispatch ${workflow}`,
  )
}

assert.match(releaseSource, /--arg sha "\$HEAD_SHA"/u)
assert.match(releaseSource, /\.headSha == \$sha/u)
assert.match(releaseSource, /\.databaseId > \$previous/u)
assert.match(releaseSource, /gh run watch "\$RUN_ID"[\s\S]*--exit-status/u)
assert.match(releaseSource, /FAILED_WORKFLOWS\+=/u)
assert.match(releaseSource, /test "\$\{#FAILED_WORKFLOWS\[@\]\}" -eq 0/u)
assert.doesNotMatch(releaseSource, /contexts\/[^\s"']+/u)

console.log(
  'Release automation dispatches and fails closed on CI, CodeQL, and dependency review for the exact release head',
)
