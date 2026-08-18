import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { parse } from 'yaml'

const releasePath = '.github/workflows/release-please.yml'
const dependencyPath = '.github/workflows/dependency-review.yml'
const publishPath = '.github/workflows/publish.yml'
const releaseSource = await readFile(releasePath, 'utf8')
const dependency = parse(await readFile(dependencyPath, 'utf8'))
const publishSource = await readFile(publishPath, 'utf8')
const release = parse(releaseSource)

assert.equal(
  release.permissions?.statuses,
  'write',
  'Release Please must be able to publish protected commit statuses',
)
assert.equal(
  release.jobs?.release?.['timeout-minutes'],
  135,
  'Release Please must bound the release job so a stale release PR cannot hold its concurrency group indefinitely',
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

for (const command of ['bwrap', 'socat']) {
  assert.match(
    publishSource,
    new RegExp(`command -v ${command} >/dev/null`, 'u'),
    `Publish must verify the ${command} sandbox prerequisite before release regression`,
  )
}
assert.match(
  publishSource,
  /apt-get install -y ripgrep bubblewrap socat/u,
  'Publish must install the Linux sandbox prerequisites when absent',
)
assert.match(
  publishSource,
  /kernel\.apparmor_restrict_unprivileged_userns/u,
  'Publish must handle Ubuntu AppArmor user-namespace restriction like CI',
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
assert.match(releaseSource, /WORKFLOW_RESULTS\[\$WORKFLOW\]=\$CONCLUSION/u)
assert.match(releaseSource, /WORKFLOW_RESULTS\[\$WORKFLOW\]=timeout/u)
assert.match(
  releaseSource,
  /-f state=failure[\s\S]*context="\$CHECK_NAME"/u,
  'Release Please must replace pending bridge statuses with failure when a dispatched workflow fails or times out',
)
assert.match(
  releaseSource,
  /for WORKFLOW in ci\.yml dependency-review\.yml; do[\s\S]*test "\$\{#FAILED_WORKFLOWS\[@\]\}" -eq 0/u,
  'Release Please must publish every bridge status before exiting for failed workflows',
)
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
assert.match(releaseSource, /MERGE_DEADLINE=\$\(\(SECONDS \+ 600\)\)/u)
assert.match(releaseSource, /--json state,mergeStateStatus/u)
assert.match(releaseSource, /test "\$PR_MERGE_STATE" = "BEHIND"/u)
assert.match(
  releaseSource,
  /test "\$PR_STATE" = "MERGED"; then[\s\S]*gh workflow run release-please\.yml[\s\S]*--ref main/u,
  'Release Please must dispatch a follow-up run only after the release pull request has merged',
)
assert.doesNotMatch(
  releaseSource,
  /Release pull request did not auto-merge before timeout/u,
  'Release Please must release the concurrency group when auto-merge is slow instead of failing the handoff loop',
)
assert.match(releaseSource, /-f base_ref=main/u)
assert.match(releaseSource, /-f head_ref="\$HEAD_BRANCH"/u)
assert.doesNotMatch(releaseSource, /contexts\/[^\s"']+/u)

console.log(
  'Release automation dispatches exact-head checks, bounds release handoff, and provisions Linux sandbox prerequisites for publish regression',
)
