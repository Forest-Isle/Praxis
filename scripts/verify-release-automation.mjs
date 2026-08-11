import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { parse } from 'yaml'

const releasePath = '.github/workflows/release-please.yml'
const dependencyPath = '.github/workflows/dependency-review.yml'
const releaseSource = await readFile(releasePath, 'utf8')
const dependency = parse(await readFile(dependencyPath, 'utf8'))
const release = parse(releaseSource)

assert.equal(
  release.permissions?.statuses,
  'write',
  'Release Please must be able to publish protected commit statuses',
)

assert.ok(
  dependency.on?.workflow_dispatch !== undefined,
  'Dependency review must support release-branch dispatch',
)
assert.equal(
  dependency.on.workflow_dispatch.inputs?.base_ref?.required,
  true,
  'Dispatched dependency review must require a base ref',
)
assert.equal(
  dependency.on.workflow_dispatch.inputs?.head_ref?.required,
  true,
  'Dispatched dependency review must require a head ref',
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
assert.match(releaseSource, /--json headRefName,headRefOid,state/u)
assert.match(releaseSource, /\.headRefOid[^\n]*\$HEAD_SHA/u)
assert.match(releaseSource, /ci\.yml\) CHECK_NAME=CI/u)
assert.match(
  releaseSource,
  /dependency-review\.yml\) CHECK_NAME='Dependency review'/u,
)
assert.match(
  releaseSource,
  /statuses\/\$HEAD_SHA[\s\S]*state=pending[\s\S]*context="\$CHECK_NAME"/u,
)
assert.match(
  releaseSource,
  /statuses\/\$HEAD_SHA[\s\S]*state=success[\s\S]*context="\$CHECK_NAME"/u,
)
assert.match(releaseSource, /target_url="\$RUN_URL"/u)
assert.match(releaseSource, /-f base_ref=main/u)
assert.match(releaseSource, /-f head_ref="\$HEAD_BRANCH"/u)
assert.doesNotMatch(releaseSource, /contexts\/[^\s"']+/u)

console.log(
  'Release automation dispatches and fails closed on CI, CodeQL, and dependency review for the exact release head',
)
