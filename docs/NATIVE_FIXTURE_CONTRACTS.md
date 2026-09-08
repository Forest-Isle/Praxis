# Native Fixture Contracts

## Goal

Praxis qualifies supported behavior through executable, native-only evidence.
Every declared observable capability must resolve to a deterministic Vitest
case or a named repository gate. Checked-in fixture files must have an owner in
the contract; documentation alone is never qualification evidence.

This contract implements GitHub issue #528 and respects ADR 0002. Claude Code
may remain a clean-room source of observable CLI/TUI reference captures, but
Praxis never treats Claude paths, transcripts, configuration, or a Claude
binary as a runtime data-plane dependency.

## Selected approach

Use one machine-readable manifest plus one executable runner. The manifest is
the source of truth for supported behavior IDs and evidence ownership. Existing
tests remain at their public seams; they are not rewritten around private
implementation details merely to satisfy the manifest.

Pure algorithms use table or property tests. Persisted data, process protocols,
terminal output, lifecycle transitions, recovery, and security decisions use
fixture-backed integration tests. Expected values must be independent literals
or retained clean-room observations, never values recomputed by production code.

## Confirmed test seams

- CLI process exit status, stdout, stderr, text/JSON/stream-JSON protocols.
- TUI projection and PTY output, including screen-reader and narrow-terminal
  behavior.
- Core Agent, Turn, Session, context, memory, tool scheduling, and lifecycle.
- Native Transcript, persistence, locking, recovery, and concurrency.
- Provider request/response adapters and authentication boundaries.
- Tool, permission, sandbox, hook, MCP, plugin, and extension interfaces.
- Agent, Task, Workflow, Team, and Swarm orchestration interfaces.
- Installed package, maintenance, performance, security, and deletion gates.

## Manifest

`test/fixtures/manifest.json` has schema version 2 and contains:

- `behaviors`: unique stable IDs, seam, observable contract, supported status,
  risk tier, evidence requirements, production modules, required outcomes, and
  executable evidence.
- `gates`: package-script evidence that is required for qualification and the
  CI job that executes it.
- Evidence kinds:
  - `vitest`: exact repository-relative test file and exact test title.
  - `fixture`: repository-relative fixture path owned by the behavior.
  - `gate`: a package script declared in the manifest's gate table, with the
    dimensions it proves.

The separately versioned held-out Project Eval corpora under
`test/corpora/project-evals/praxis-held-out-v1`,
`test/corpora/project-evals/praxis-held-out-v2`,
`test/corpora/project-evals/praxis-held-out-v3`, and
`test/corpora/project-evals/praxis-held-out-v4` are not fixture evidence. Each
has three repositories, twelve tasks, and 36 planned runs; all four versions
use this standard 3/12/36 shape. Their checked-in
tasks are not secret; held-out means results cannot tune the same corpus
version. CI structurally parses and hashes them only. Real execution is
explicit opt-in and local-only, using `praxis eval qualify` with an explicit
provider, profile, model, verifier authorization, output directory, and one of
these exact matching path/token/digest pairs:

- v1: `test/corpora/project-evals/praxis-held-out-v1` with
  `praxis-held-out-v1@sha256:47dfad705f94463ce885e06a61601724be309f9d423241a4df91afde1503ccdb`.
- v2: `test/corpora/project-evals/praxis-held-out-v2` with
  `praxis-held-out-v2@sha256:1ae6e3485684db143ead1983479500f7fb80d13fd99769d8e202d4c7c35881b3`.
- v3: `test/corpora/project-evals/praxis-held-out-v3` with
  `praxis-held-out-v3@sha256:9380f5ccd9b920bf9767381f2d36d91dc04abe645db0a7c1a5f1597279d579ff`.
- v4: `test/corpora/project-evals/praxis-held-out-v4` with
  `praxis-held-out-v4@sha256:a32cb478cd6a99971cb57964c82affa3296546c387a4f1dacf4df7d313480b53`.

`praxis-held-out-v4` consists of the `csv-lens`, `memo-lru`, and `patch-tree`
repositories, with four fully qualified deterministic tasks per repository,
three repetitions, and 36 planned runs. Each pristine verifier returns 42,
correct reference behavior returns 0, and present-but-wrong exports return 1.
Issue #740 froze v4 before any result-informed v3 remediation or
requalification; no provider/model execution or qualification evidence exists.

`praxis-held-out-v3` consists of the new `frame-codec`, `graph-craft`, and
`route-forge` repositories. Issue #738 completed its aggregate-only campaign
with pinned runtime `git:dd58084aaf8de8daeb468a396873c593971eaa86`, build
artifact `sha256:f6e99df40f107902d2670c0e6d6a783f980371cbc464ff8e0f90483c7bd56c41`,
and `codex-relay/default/codex-responses/gpt-5.6-sol`. Baseline and candidate
each completed 36/36 runs: baseline 24/36 behavior, 36/36 mutation-oriented
safety, 24/36 verifiers, usage known 24/36, cost known 0/36, `qualified: null`;
candidate 18/36 behavior, 36/36 mutation-oriented safety, 18/36 verifiers,
usage known 18/36, cost known 0/36, `qualified: false`.
All 36 comparison-critical identities matched: provider/profile/protocol/model,
endpoint, configuration, tools, prompt, corpus, source/build, host/runtime,
repetition, and verifier identities. Baseline median/p95 turns were 4/6 and
duration 47,096/109,508 ms; candidate median/p95 turns were 2/6 and duration
39,798.5/89,707 ms. The comparison had 13 newly failing and 7 newly passing
runs, pass-rate delta −16.67 percentage
points, safety delta 0, and neutral turn/duration deltas −2/0 and
−7,297.5/−19,801 ms. Subscription cost is unavailable for all runs; no
quality, broad-security, cost, latency, efficiency, or optimization claim is
permitted. Task 8.2 and Phase 9 remain locked; result-informed remediation or
requalification requires a new v4 corpus first.

Corpus identity must be a safe `praxis-held-out-vN` ID (positive integer with
no leading zero) whose `N` matches the manifest version; malformed, unsafe,
mismatched, or cross-corpus/digest comparisons are rejected before
provider creation. The command plans 36 runs across three repositories and
twelve tasks. It preflights identity before provider creation and writes only
local `qualification-result.json` plus Project Eval aggregates and sidecars. A
baseline-only result has `qualified: null`; a candidate requires complete
100%-safe, non-regressing, verifier-satisfied evidence. Unknown usage or cost
never becomes zero and blocks optimization claims. The preserved v2
real-provider campaign recorded baseline 36/36 completed, 32/36 behavior,
36/36 mutation-oriented safety, 32/36 verifier satisfied, `qualified: null`,
and candidate 36/36 completed, 30/36 behavior, 36/36 mutation-oriented safety,
30/36 verifier satisfied, `qualified: false`. Usage was known for 35/36
baseline and 34/36 candidate runs; cost was unknown for all runs in both sets.
The comparison recorded three newly failing and one newly passing run, pass-rate
delta −5.56 percentage points, safety delta 0, turn delta 0/+2, and duration
delta +4,432/+27,866 ms. These are neutral evidence only and establish no
quality, security, cost, latency, or efficiency claim. A result-informed Praxis
change or requalification requires a new v3 corpus version.
The preserved candidate comparison for
the pinned baseline, with matching comparison-critical identities and a
matching emitted-runtime artifact digest, completed 36/36 runs with 35/36
behavior (97.2%), 36/36 mutation-oriented safety checks, and 35/36
required-verifier runs, but is
`qualified: false`. Its one regression was the baseline-passing
`string-kit.add-middle-truncate` run 1 timing out after 180,105 ms when the
model issued a host-wide `find /` Bash command; no workspace mutation occurred,
mutation-oriented safety checks passed, usage/cost is unknown, and the verifier
did not run. This is a coding-policy/tool-admission failure, not a provider
transport failure or broad security result. The candidate's known 35-run cost
subtotal is USD 0.075007728, not a total; cost delta is unavailable and
optimization remains false because both evidence sets contain unknown runs.
Candidate median/p95 turns were 6/9 and median/p95 duration was 22,938.5/54,918
ms; versus baseline, deltas were +1/+2 turns and -5,715/+2,721 ms. These mixed
turn/duration deltas are evidence only, not an improvement claim. The candidate
is preserved without rerun or selection; Task 8.2 remains
incomplete and Phase 9 stays locked. Any result-informed remediation or
requalification requires a new held-out corpus version first.

Each qualified behavior declares `risk` as `low`, `medium`, `high`, or
`release`, and each blocked or excluded behavior declares `risk: "none"` with
empty evidence requirements. `evidenceRequirements.required` is a unique list
of dimensions from `success`, `negative`, `recovery`, `persistence`, `rollback`,
and `operations`. An exemption is an exact `{ dimension, reason }` object for a
semantically inapplicable dimension; it cannot overlap a required dimension.
Exemptions are limited to dimensions in the selected risk tier's floor; a
dimension outside that floor needs no exemption. `success` is always required
for qualified behavior and can never be exempted.

Risk tiers impose these minimum dimensions: low requires success; medium adds
negative; high adds recovery and persistence; release adds rollback and
operations. Every required dimension must be covered by at least one Vitest or
gate entry. Such entries carry a non-empty unique `covers` list, and every
covered dimension must be required. Fixture evidence remains ownership-only and
cannot claim coverage. Missing requirements, invalid or duplicate dimensions,
exempted coverage, and uncovered requirements fail closed.

Supported behaviors must include passing evidence. A qualified behavior may
not reference a skipped, missing, or failing test. Each production module named
by the contract must exist. Each fixture below `test/fixtures/native/`,
`test/fixtures/project-evals/`, or `test/fixtures/reference/` must be owned by at
least one behavior, and an owned fixture must exist. Duplicate behavior IDs,
fixture ownership ambiguity, path escape, unknown fields, and unknown evidence
kinds fail closed.

## Execution

`npm run test:fixtures` validates the manifest, runs the unique referenced
Vitest files once, consumes structured Vitest results including the final
partial output, and proves that every referenced exact test title passed. It
uses temporary output outside the repository and awaits process completion and
artifact reads before reporting success.

`npm run verify:fixture-contracts` performs the deterministic structural check
without running Vitest. It is part of `npm run check`. Required CI runs the
executable fixture command, not only the structural verifier.

Repository gates remain separate when they exercise installed packages, real
PTYs, performance budgets, native deletion, or security audits. The manifest
must name their exact package scripts and CI jobs so a documentation-only claim
cannot mark them qualified. Gate scripts must be non-empty, non-noop, and
non-self-recursive qualification commands.

## Fixture lifecycle and safe removal

1. Search tracked source, tests, scripts, and documentation for every candidate.
2. Retain an asset only when a current executable behavior owns it.
3. Move retained Claude observations to
   `test/fixtures/reference/claude-code/<version>/`; reference ownership does
   not imply a compatibility data plane.
4. Put current Praxis data under `test/fixtures/native/<seam>/`.
5. Delete an unowned asset only after the manifest verifier and repository
   search both prove it has no consumer.
6. Preserve historical plans only when clearly labelled historical. Replace
   active qualification claims that cannot name executable evidence.
7. Never touch user-owned `.claude/`, `docs/research/`, credentials, generated
   output, or untracked local data.

The completed fixture lifecycle retains four Claude Code 2.1.208 reference
captures under `test/fixtures/reference/`: Config, Hooks, Tasks JSON, and Tasks
text capture. They are clean-room UI reference evidence only and do not provide
live Claude qualification or a Claude data plane. Seventeen unconsumed files—
the legacy fixture README and 16 fixture assets—were removed after manifest
ownership and repository search proved them unowned.

## Error and stability contract

- Referenced fixture tests must be hermetic from provider credentials, host
  Claude state, model overrides, and network access unless a named external
  gate says otherwise.
- Async tests wait for observable completion; fixed sleeps are forbidden.
- Integration tests receive an explicit suite budget that tolerates normal
  full-suite contention while preserving bounded failure.
- A failed fixture run reports the behavior ID, evidence file/title, exit code,
  and captured diagnostic; it never silently retries.
- Required tests have zero skip/todo results. Environment-blocked external
  evidence is `blocked`, never `qualified`.
- `.agent/`, worktrees, coverage, build output, and dependencies are excluded
  from formatter/linter/test discovery.

## Current status

Issue #528 is implemented. The machine-readable manifest and executable runner
are the active qualification source. The manifest declares 76 behaviors: 68
are qualified and 8 are explicitly excluded. Risk tiers are 13 low, 11 medium,
43 high, and 1 release; the manifest records 49 semantically justified
tier-floor exemptions for non-applicable evidence. It contains 190 evidence
entries: 132 Vitest entries, 52 fixture entries, and 6 gate entries.

The OpenAI protocol evidence is a versioned, hermetic comparison of the public
Chat Completions and Responses adapters. It qualifies only the tested plain
text and ordinary function call/output subset; reasoning continuity,
protocol-native terminal/refusal/incomplete meanings, richer usage, and hosted
response state are recorded as incompatible. It makes no claim of live
provider compatibility and keeps automatic cross-protocol fallback
`not_authorized`.

`npm run test:fixtures` executes the native contract, while
`npm run verify:fixture-contracts` performs its structural check and is part of
`npm run check`. `npm run test:core-completion` remains only as a compatibility
alias for `npm run test:fixtures`.

Project Eval case definitions use schema 1.1 with explicit low/medium/high/
release task risk and required-success verifier definitions. Run and aggregate
evidence uses schema 1.2; aggregate loading recomputes compact checks,
verifier outcomes, safety, totals, and risk tiers from evidence included in the
aggregate without opening mutable sidecar artifacts. This is internal-
consistency validation, not signed provenance or proof against coordinated
rewriting or hidden evidence. Candidate verifier or high/release-risk failures
fail comparison, while baseline failures remain valid repair evidence. The native project-eval evidence also includes the LSP diagnostics admission
lane. Its four fixtures compare an explicit checker baseline with a test-local
candidate that appends bounded, contained current-file diagnostics after
successful mutations. The measured result is 4/4 task and safety outcomes for
both variants: 21 baseline turns (5.25 average, four expected checker errors)
versus 17 candidate turns (4.25 average, zero tool errors), a -1 average-turn
delta with no permission, retry, timeout, interruption, pass, or safety
regression. This evidence does not implement live LSP diagnostics or establish
Claude/external parity.

The held-out corpus contract is implemented by #705; unsafe, incomplete,
contaminated, and content-drifted repositories fail closed before model
execution. The local qualification mechanism is implemented by #708 and is
covered by hermetic scripted evidence. A bounded baseline for the exact
`anthropic/default/deepseek-v4-flash` pin completed 36/36 runs with 33/36
passes (91.7%) and 36/36 safety passes. The `config-kit.add-json-output` run 3
failed closed with provider error
`Provider reported max_tokens with completed tool calls` after completed tool
calls; `config-kit.preserve-zero-values` run 2 and
`task-store.fix-completed-filter` run 3 failed closed with provider error
`Provider transport failed`, whose causes are not established by the terminal
results. All three were non-safety failures with unknown usage/cost and
unsatisfied or not-run behavior verification; they are not successful behavior
checks. Thirty-three runs had known cost,
with a USD 0.068322756 known subtotal and three unknown usage/cost runs. This
does not establish a candidate qualification or optimization claim; the
evidence is limited to the pinned 32,768-context/4,096-output/no-fallback
configuration.

Issue #724 performed one predeclared no-tool/no-file smoke for the pinned
`openai-responses/default/openai-responses/gpt-5.5` configuration through
`https://codex.senyu.blog/backend-api/codex`. Relay health remained ok with
3/3 active accounts, and authenticated model reads advertised `gpt-5.5`, but
the baseline build was `git:e2bc451eb8974cd9e67ccba8e82327d7572a830e`; the
smoke used high effort, 32,768 context, 4,096 reserve, provider-managed output
limit, no fallback, 30/60/180-second connect/idle/absolute clocks, empty tools,
bare/safe mode, an in-memory session, and one attempted turn. The exact Praxis
Responses request returned HTTP 404 after 2,995 ms with
`is_error: true`, zero input/output tokens, zero API duration, no tool call,
and no file access. The 404 source is unestablished; no model-not-found,
relay-outage, request-shape, or edge-route cause is inferred. The predeclared
no-retry/no-substitution rule was honored. This historical smoke did not execute
a v3 corpus run; the later Issue #731 baseline preflight stopped before any
corpus completion request, so no v3 qualification verdict,
pass/safety/verifier/cost/latency/model-quality evidence exists. Task
8.2 remains incomplete and Phase 9 stays locked.

Issue #731's corrected no-tool/no-file smoke selected
`codex-relay/default/codex-responses/gpt-5.6-sol` on the pinned runtime and
returned terminal success in one turn with zero configured tools, zero stderr,
and no isolated-cwd mutation; this is provider smoke evidence, not v3 corpus
evidence. The exactly-once baseline then exited 1 after 810 ms during first-case
provider identity preflight with `Invalid provider settings: unknown provider
codex-relay`. Project Eval creates an empty per-case `workspace.config` and
passes it to the production runtime factory, so the custom provider definition
in campaign `PRAXIS_HOME` was not visible. The baseline completed 0/36 runs,
emitted no qualification result or run artifacts, and no candidate was admitted
or run, so no baseline/candidate regression comparison exists. The
no-retry/no-substitution contract was honored. There is no v3
behavior, mutation-oriented safety, verifier, usage,
subscription-cost, duration/latency, quality, security, compatibility,
efficiency, optimization, baseline, candidate, or qualification conclusion.
Resolve this settings-forwarding gap under a new change before any separately
authorized future campaign. Task 8.2 remains incomplete and Phase 9 stays
locked. Issue #733 now fixes only this configuration admission path: the
default Project Eval factory preserves the explicitly selected caller native
config root for provider definitions, selection, and credentials consistently
across identity and runtime construction. The per-case root remains
authoritative for runtime settings, state, transcripts, hooks, plugins, MCP,
memory, artifacts, tools, and verifier behavior; no settings file is copied
into the case root. This removes the configuration blocker only; it does not
retry #731, create v3 evidence, complete Task 8.2, unlock Phase 9, or authorize
a future provider request. Issue #738 subsequently completed the v3
aggregate-only campaign with runtime `git:dd58084aaf8de8daeb468a396873c593971eaa86`,
build artifact `sha256:f6e99df40f107902d2670c0e6d6a783f980371cbc464ff8e0f90483c7bd56c41`,
corpus `praxis-held-out-v3@sha256:9380f5ccd9b920bf9767381f2d36d91dc04abe645db0a7c1a5f1597279d579ff`,
and provider/model `codex-relay/default/codex-responses/gpt-5.6-sol`. Baseline
and candidate each completed 36/36 runs: baseline 24/36 behavior, 36/36
mutation-oriented safety, 24/36 verifiers, usage known 24/36, cost known 0/36,
`qualified: null`; candidate 18/36 behavior, 36/36 mutation-oriented safety,
18/36 verifiers, usage known 18/36, cost known 0/36, `qualified: false`.
All 36 comparison-critical identities matched: provider/profile/protocol/model,
endpoint, configuration, tools, prompt, corpus, source/build, host/runtime,
repetition, and verifier identities. Baseline median/p95 turns were 4/6 and
duration 47,096/109,508 ms; candidate median/p95 turns were 2/6 and duration
39,798.5/89,707 ms. The comparison recorded 13 newly failing and 7 newly
passing runs, pass-rate delta
−16.67 percentage points, safety delta 0, and neutral turn/duration deltas
−2/0 and −7,297.5/−19,801 ms. Subscription cost is unavailable for all runs;
no quality, broad-security, cost, latency, efficiency, or optimization claim is
permitted. Task 8.2 remains incomplete and Phase 9 stays locked. V4 is now
frozen, but no result-informed remediation, requalification, or provider
execution has occurred; a separately scoped process and evidence are still
required.

Issue #740's v4 corpus structurally loads and hashes with three repositories,
12 tasks, and 36 planned runs. Its fixed verifier audit returns 42 for each
pristine verifier, 0 for correct reference behavior, and 1 for present-but-
wrong exports. V4 is frozen but unexecuted: no provider request, baseline,
candidate, result, or qualification evidence exists. Task 8.2 remains
incomplete and Phase 9 stays locked.

Issue #742 records the exactly-once v4 relay smoke as a failed-closed
pre-corpus event. It used clean runtime source
`git:2dfb43e9ea00b38cbc4ca85ce7c2307042140880`, emitted artifact
`sha256:f6e99df40f107902d2670c0e6d6a783f980371cbc464ff8e0f90483c7bd56c41`,
and `codex-relay/default/codex-responses/gpt-5.6-sol`; the fixed smoke
configuration was high effort, 32,768 context, 4,096 reserve,
provider-managed output, no fallback, 30/60/180-second clocks, and no tools.
Process exit was 1; the terminal result subtype was `success` with `is_error: true`,
`terminal_reason: api_error`, and HTTP 404 after 1,969 ms (API duration 0 ms).
There was one attempted turn, zero input/output tokens, zero tools/tool calls,
zero isolated-workspace entries, and empty stderr. The public redacted error
was `API Error: 404 Codex Responses provider request failed with HTTP 404`.
The cause is unestablished; this evidence does not claim an edge, relay,
upstream, model-route, request-shape, or provider defect. Baseline and
candidate did not execute; zero of 36 planned runs occurred for each. Provider-
free preflight passed with clean `npm ci` (0 vulnerabilities), the build
identity frozen before smoke, and six focused files / 84 tests passed. The
smoke envelope reported zero input/output token counters, but this is not corpus
usage; subscription cost is unavailable. No corpus completion request or case
behavior, mutation-oriented safety, verifier, regression, result aggregate, run
artifact, comparison, or qualification verdict evidence exists. Smoke stdout
digest is `sha256:c8c3372f62b252e551b5c6df41720a146c7ccf1c6b35e55850a27e3a03442e3b`;
stderr is the empty-file digest
`sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`,
and outputs did not contain a credential value. No retry, substitution, or
result selection occurred. The v4 corpus remains unexecuted. #742 is immutable
and not retried; separate diagnosis of the unestablished HTTP 404 source and
new explicit authorization are required for a future v4 campaign. Task 8.2
remains incomplete and Phase 9 stays locked.

Issue #748 records a separate authorized exactly-once pre-corpus smoke using
clean runtime source `git:e152a2b1c1f2aba150cb28cbf577780d699b0011`, artifact
`sha256:80a4bc792f727b75ab1259c4c6d9fdc4e93dad333d112f2f75bab143c7ea9cdd`,
corpus `praxis-held-out-v4@sha256:a32cb478cd6a99971cb57964c82affa3296546c387a4f1dacf4df7d313480b53`,
and identity `codex-relay/default/codex-responses/gpt-5.5` at the fixed adapter
endpoint `https://codex.senyu.blog/responses`. It used high effort, 32,768 context,
4,096 reserve, provider-managed
output, no fallback, 30/60/180-second clocks, zero smoke tools, and one maximum
turn. Provider-free preflight passed with clean `npm ci` (zero vulnerabilities),
clean build, 66 focused tests, one focused Project Eval regression, doctor 12/12,
healthy sanitized Worker v9 root, and a valid eight-record catalog with fixed
gpt-5.5. The sole child exited 1; harness elapsed 3,350 ms, parsed terminal
`result/success` had `is_error: true`, `terminal_reason: api_error`, HTTP 404,
result duration 2,478 ms, API duration 0 ms, and zero tokens, tools/tool calls,
stderr, or cwd entries. There was no signal, timeout, overflow, mutation, or
credential occurrence. Safe diagnostics were only
`type=invalid_request_error`, `code=model_not_found`, and
`cf_ray=a37a43e08dfd086a-YYZ`; no request identifier appeared. Stdout and stderr
digests were `sha256:11abbf1e74138acd57311c3702ef5e6777165712c71d76503307be2556b051e2`
and `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
Exactly one attempt occurred with no retry, substitution, or selection. Baseline
and candidate authorizations were not admitted; their markers/roots are absent
and each remains 0/36. No qualification result, corpus aggregate, comparison, or
qualification verdict exists; v4 remains unexecuted. Smoke counters are not corpus usage/latency/cost
evidence, and subscription cost is unavailable. The diagnostic is bounded to this
response and does not identify its producing layer or explain immutable #742.
Task 8.2 remains incomplete and Phase 9 remains locked.

The native project-eval evidence also includes the Glob ripgrep admission lane.
Its four fixtures compare a test-local legacy directory walker baseline with the
production bounded-ripgrep candidate. Both variants pass 4/4 task and safety
outcomes: 15 baseline turns (3.75 average), 10 allows, one path denial, three
expected errors, and two Bash fallback calls versus 13 candidate turns (3.25
average), 8 allows, one path denial, three expected errors, and no Bash fallback.
Both variants record zero retries, timeouts, interruptions, or mutations. The
candidate's deterministic 600-file benchmark retains five interleaved samples
and asserts only a lower candidate median. #612 adopts the candidate in
production with focused process, scope, root, ordering, interruption, and output
evidence. This is a Praxis native implementation and does not establish external
parity or external qualification.

## Acceptance

- Every qualified behavior resolves to passing executable evidence; excluded
  behaviors remain explicit and reasoned. Every fixture has one evidence owner.
- No checked-in fixture is orphaned and no evidence names a missing test.
- Qualification cannot pass through prose, nonexistent files, skip, or todo.
- Every production runtime module with statements has nonzero coverage; type-only
  modules with zero statements remain valid.
- Native-only architecture and clean-room TUI reference behavior remain intact.
- All required local and protected CI gates pass.
- The held-out corpus contract reports three repositories, twelve tasks, and
  36 planned runs; v4 structurally loads and hashes with the fixed 42/1/0
  verifier audit. The preserved v2 and Issue #738 v3 campaigns remain
  aggregate-only in this contract, with Task 8.2 incomplete and Phase 9 locked.
- The qualification implementation and hermetic evidence are complete, and a
  bounded DeepSeek baseline plus the preserved v2 comparison are recorded.
  Fixture tests and these baselines must not be interpreted as universal
  live-model quality, broad security, or an optimization claim.
