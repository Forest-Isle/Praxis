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

assert.match(
  releaseSource,
  /steps\.release\.outputs\.prs_created == 'true' \|\| steps\.release\.outputs\.release_created != 'true'/u,
  'Release Please must resolve a release PR both when it created one and when an unchanged one is pending',
)
assert.match(
  releaseSource,
  /gh pr list[\s\S]*--state open[\s\S]*--base main[\s\S]*--label 'autorelease: pending'/u,
  'Release Please must look up an unchanged release PR by its autorelease label, open state, and main base',
)
assert.match(
  releaseSource,
  /PR_COUNT=\$\(jq 'length'[\s\S]*if test "\$PR_COUNT" -gt 1; then/u,
  'Release Please must fail when more than one pending release PR matches instead of choosing one',
)
assert.match(
  releaseSource,
  /steps\.resolve-release-pr\.outputs\.pr != ''/u,
  'Protected checks must run only when a resolved release PR exists',
)
assert.match(
  releaseSource,
  /RELEASE_PR: \$\{\{ steps\.resolve-release-pr\.outputs\.pr \}\}/u,
  'Protected checks must consume the resolved release PR output',
)
assert.match(
  releaseSource,
  /printf 'pr=%s\\n' "\$PR_JSON" >> "\$GITHUB_OUTPUT"[\s\S]*printf 'pr=%s\\n' "\$PR_JSON" >> "\$GITHUB_OUTPUT"/u,
  'The release PR resolver must expose the resolved JSON as the pr step output in both branches',
)

console.log(
  'Release automation dispatches exact-head checks, bounds release handoff, and provisions Linux sandbox prerequisites for publish regression',
)
