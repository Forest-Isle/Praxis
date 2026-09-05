# Outcome-Driven Coding Agent Roadmap

Status: accepted implementation direction
Tracking map: [#540](https://github.com/Forest-Isle/Praxis/issues/540)
First module: [#541](https://github.com/Forest-Isle/Praxis/issues/541)

## Goal

Make Praxis a measurably excellent local-first, single-user CLI coding agent.
Runtime, tool, context, and provider changes must improve repository outcomes,
not merely add surface area or make isolated unit tests pass.

Success means Praxis can repeatedly complete bounded coding tasks while
recording enough local evidence to explain success, regression, cost, safety,
and recovery behavior.

## Product boundaries

- Keep the native Praxis data plane authoritative and append-only.
- Remain local-first, single-user, and CLI-only.
- Keep permissions and sandboxing in the runtime, not optional extensions.
- Keep provider-specific behavior behind capability-aware adapters.
- Do not add accounts, organizations, RBAC, billing, remote control, IDE
  surfaces, hosted dashboards, or a telemetry control plane.
- Do not rewrite `session-service.ts` in one migration.

## Strategy

The dependency order is deliberate:

```text
Outcome evidence
  -> recovery correctness
  -> tool/context efficiency
  -> provider-native depth
  -> turn-kernel deepening
  -> measured coding optimizations
```

## Audited current state

Phases 0–5 record implemented deterministic harness, runtime, tool, context,
provider, turn-kernel, and measured-optimization behavior backed by the listed
fixtures and evaluations. The current harness strongly qualifies deterministic
runtime, tool, and safety contracts, but does not yet fail every individual
case regression, enforce provider/model/configuration/corpus identity, or
establish real-model coding quality. Real-provider coding remains an opt-in
qualification frontier with pinned configuration, held-out tasks, and
local-only artifacts.

## Target architecture

```text
Project eval adapter / Plugin eval adapter
                  |
             Eval kernel
  case -> isolated workspace -> runtime -> trajectory
                         |          |
                  workspace diff   usage/cost
                         |          |
                    verifiers -> deterministic score -> artifacts

SessionService
  -> TurnCoordinator
  -> ContextPreparation
  -> ProviderClientSession
  -> ToolBatchLifecycle
  -> TurnPersistence
  -> TurnAccounting
```

## Evidence contract

Every coding run records a versioned, local-only artifact set:

- case identity and schema version;
- Praxis version, selected provider/model identity, and configuration digest;
- terminal status, turns, duration, usage, and cost availability;
- provider-neutral runtime trajectory;
- added, modified, and deleted workspace paths;
- bounded verifier argv, exit status, timeout, stdout, and stderr;
- expected, allowed, and forbidden path checks;
- permission decisions, tool errors, retry, and termination evidence;
- a deterministic pass/fail result.

Unknown cost is unavailable, never zero. Repository tests and hard workspace
checks outrank LLM judges.

## Phase 0 — Outcome evaluation foundation

### Task 0.1: Project outcome harness [implemented by #541]

- Extract shared provider-neutral eval runtime, trace, and grader contracts from
  the existing plugin-oriented implementation.
- Add `praxis eval <target>` project-case discovery.
- Copy contained fixtures into isolated workspaces without changing sources.
- Detect workspace mutations and enforce explicit changed-path allowlists.
- Run explicitly authorized, no-shell verifier argv with bounded output/time.
- Persist per-run and aggregate artifacts.
- Preserve `praxis plugin eval` behavior and reports.

Acceptance: a deterministic injected runtime passes with complete artifacts;
unsafe paths, unauthorized verifiers, forbidden changes, timeout, and nonzero
verification fail closed.

Tasks 0.1 through 3.3, 4.1, 4.2, 4.3a, and 4.3b are implemented.
TurnAccounting is the turn-kernel accounting seam.

### Task 0.2: Baseline suite [depends: Task 0.1]

Add hermetic fixtures for bug fix, small feature, refactor, repository
navigation, long context/resume, denied permission recovery, malformed tool
input, and active-turn steering. Start with deterministic provider scripts;
add opt-in real-model lanes after artifact stability.

Acceptance: one command compares named baseline and candidate configurations
and reports pass-rate, safety, turn, token, cost, and latency deltas. The
comparison consumes separate local artifacts; its null metrics and pass/safety
gate are documented in the CLI reference. The hermetic eight-case lane is
available with `npm run test:eval:baseline`; real-model lanes remain opt-in.

## Phase 1 — Recovery correctness

### Task 1.1: Recover malformed tool input [implemented by #138]

Provider decoders return a typed invalid-input call. The runtime emits a paired,
model-visible error result without executing the tool or losing the turn.
Anthropic Messages, OpenAI-compatible Chat Completions, and Codex subscription
Responses share the provider-neutral diagnostic. Native transcripts persist
the canonical diagnostic so an interrupted turn resumes to exactly one safe
error result without scheduling, permission, approval, or execution.

### Task 1.2: Stream timeout recovery [implemented by #550 and #553; tracks #121]

The #550 lifecycle slice separates connect, byte-idle, and absolute-total
timeouts and reports typed timeout phases. The #553 recovery slice adds one
default-on Anthropic-only non-streaming replay after explicitly eligible stream
transport failures or byte-idle timeout. Each attempt has independent clocks;
both are buffered until terminal success, while connect/total timeout,
cancellation, HTTP/auth/rate-limit, prompt-too-long, malformed responses, and
unsupported provider protocols remain ineligible.

Acceptance: outcome fixtures show no duplicated mutation, orphaned tool call,
or silent partial output across both recovery modules, including detached
workers and the explicit fallback opt-out.

## Phase 2 — Tool and context efficiency

### Task 2.1: Deferred tool catalog [implemented by #555; depends: Task 0.2, split from #126]

`DeferredToolCatalog` creates one turn-scoped active registry. Default tool
selection exposes non-MCP tools plus `ToolSearch`, activates at most eight
deterministic name/description matches for the next model request, and retains
the base registry's permission, preparation, execution, and scheduling
semantics. Known interrupted MCP calls are preactivated for recovery;
activation never persists into the next user turn. Explicit tool selection and
the `ToolSearch` deny opt-out load MCP definitions directly so tools remain
reachable. This is a Praxis context-efficiency contract, not a claim of
verified Claude Code 2.1.208 parity.

### Task 2.2: MCP context bounds [implemented by #558, #561, and #564; depends: Task 2.1, #147]

Published descriptions are capped at 2,048 Unicode code points. Text-only
results above 100,000 UTF-8 bytes are redacted and externalized to mode-`0600`
session files, while structured, mixed-media, and binary-resource behavior is
preserved. `readOnlyHint: true` retains validated concurrent scheduling and now
supplies grant-only, provider-neutral metadata at tool preparation so the final
default permission decision allows the tool. Explicit PreToolUse outcomes,
permission ask/deny rules, modes, and safety checks retain precedence; missing
or false hints keep existing behavior. These are Praxis MCP context and
permission contracts, not claims of verified Claude Code 2.1.208 parity.

### Task 2.3: Volatile repository context [implemented by #152; depends: Task 0.2]

Native context keeps environment and memory lifecycle-stable while refreshing
Git status on every assembly from the caller-resolved cwd, including isolated
subagent worktrees. Default Git status is a volatile system section outside the
stable-system prefix; explicit relocation remains a volatile first-user
wrapper. The rendered block is bounded to 2,048 UTF-8 bytes with an exact
`... [truncated]` marker, uses `--no-optional-locks`, and fails closed by
omitting Git context when repository detection or status fails.

Acceptance: focused native context and run/resume fixtures prove fresh Git
status, stable environment/memory, cwd-specific subagent context, bounded
UTF-8 output, volatile placement, and non-persistence.

### Task 2.4: Payload-independent image budgeting [implemented by #639; tracks #150]

Provider-neutral deterministic context estimates assign each typed user or
tool-result image a fixed 1,600 visual tokens plus the existing bounded
framing. They never interpret base64 payload length as text, so compression or
encoded byte size cannot trigger disproportionate preflight compaction.
Provider-reported usage remains authoritative after its observation watermark.
Provider/model-specific pixel formulas remain out of Core unless a future
capability-aware adapter explicitly supplies one.

### Task 2.5: Anthropic context-window model specs [implemented by #642; tracks #150]

Anthropic Messages advertises 200,000 tokens for ordinary and unknown models;
an exact terminal `[1m]` suffix advertises 1,000,000, remains public, strips
only from the wire model, and adds `context-1m-2025-08-07` once. The explicit
`PRAXIS_CONTEXT_WINDOW_TOKENS` override wins. Other adapters do not infer
windows. Alias resolution, pricing/output limits, reserve/buffer changes,
image formulas, and shared provider-wire/runtime/transcript types are
non-goals.

## Phase 3 — Provider-native depth

### Task 3.1: API-key Responses adapter [implemented by #569; depends: Tasks 1.2, 2.1]

Delivered a public `openai-responses` provider with explicit model capability
selection, API-key authentication, and `/responses` SSE transport. A shared
stateless Responses codec preserves full provider-neutral local history,
reasoning/tool/output continuity, and `store:false` without
`previous_response_id` or provider-native transcript fields. Request capture
and codec fixtures cover the public API-key path.

### Task 3.2: Turn-scoped provider client — implemented by #574 and #576 [depends: Task 3.1]

The #574 main-session slice owns a fresh client for each run/resume Turn,
including transport, sticky routing, continuation, bounded retry, buffering,
and request-aware fallback admission. The #576 auxiliary slice applies the same
ownership to Agent initial executions and later background follow-ups, fresh-
process recovery, Workflow invocations, Team generations, and Project-memory
selection/extraction. Session-memory requests retain isolated completion-scoped
routing that restarts from primary; auto-mode critic and eval-judge clients
remain independently constructed one-shots. The first successful route, whether
primary or fallback, remains sealed through that logical Turn's tool
continuations; incompatible routes fail closed, and the next independent Turn
starts from primary. Recovery persists only the provider-neutral selected model
as optional native sidechain metadata and never provider route or wire state. No
provider wire payload enters core or transcripts.

Acceptance for the implemented slice: partial retries cannot repeat side
effects, and the sealed route remains stable through each main or auxiliary
logical Turn's tool continuations without leaking into independent work.
Baseline/candidate comparison evidence across Chat Completions and Responses is
covered by Task 3.3.

### Task 3.3: OpenAI protocol comparison evidence — implemented by #580 [depends: Task 3.2]

The #580 evidence lane captures fixed provider-neutral text and function
call/output trajectories through the public Chat Completions and Responses
adapters, including terminal, usage, capability, failure, and continuation
boundaries. The checked-in versioned fixture records the narrow structurally
portable subset and the incompatible reasoning, hosted-state, protocol-native
terminal, and richer-usage semantics. Automatic cross-protocol fallback
remains `not_authorized`; no implementation issue is authorized by this
evidence.

## Phase 4 — Turn-kernel deepening

### Task 4.1: TurnCoordinator — implemented by #582 [depends: Phases 1–3]

`TurnCoordinator` owns single-active-turn registration, the steering mailbox,
cancellation, cleanup, and terminal sealing behind typed outcomes. Sequential
follow-up turns remain TUI-owned and cross this seam through ordinary `resume()`.

### Task 4.2: ContextPreparation and generation — implemented by #584 [depends: Task 4.1]

`ContextPreparation` owns the turn-scoped projection of canonical stable and
volatile system context, active Transcript history, Project-memory recall,
pending input, first-user and agent-mention decoration, and active-tool
definitions. Each lifecycle starts at generation 1 after branch selection;
live refreshes remain at that generation, while only successful guarded history
replacements advance it monotonically. A stale replacement fails before its
durable callback and all following effects, and generation remains private
operational state rather than a provider, runtime, Transcript, or persistence
field.

### Task 4.3a: TurnPersistence — implemented by #586 [depends: Task 4.2]

`TurnPersistence` is constructed after active-branch selection and exposes only
snapshot reads, explicit projection refresh, and a typed command union. It
serializes projection-only, native message, tool-start, tool-completion, and
compaction commits. Combined projection/native message commands stage the
ephemeral Claude-shaped projection, await the authoritative append-only native
Transcript commit, and publish the staged view only after success. Typed
receipts gate caller-owned hooks, context effects, runtime events, memory, and
accounting. Compaction preserves boundary/summary/replay atomicity and does not
refresh compatibility state before the established PostCompact ordering point.

### Task 4.3b: TurnAccounting — implemented by #590 [depends: Task 4.3a]

Extract usage, cost, API/tool duration, line-change, preflight, and
no-double-count aggregation behind the accepted persistence receipt boundary.
Accounting remains outside Transcript/provider/runtime schemas and may not
weaken cancellation or externally committed auxiliary-metric behavior.

The main turn now delegates compaction, recovery, shell, runtime, cost,
duration, and foreground line accounting through `TurnAccounting`, with
clone-based preflight and explicit unrecorded metrics preserving exact-once
summary behavior.

Acceptance: characterization, native fixture, outcome, package, performance,
and security gates remain unchanged or improve after every extraction.

## Phase 5 — Measured optimizations

Admit ApplyPatch, LSP, search, distribution, and cross-platform work only when
Phase 0 artifacts show a specific bottleneck.

### Task 5.1: ApplyPatch admission evidence — implemented by #601 [depends: Tasks 0.2, 4.3b]

The hermetic admission lane compares the production `Read` + `Edit` surface
with a test-only bounded batch candidate across multi-hunk, multi-file, stale
context, and workspace-escape cases. Both variants pass 4/4 task and safety
checks with two expected negative-path tool errors and no retry, timeout, or
interruption. The Edit baseline uses 18 model turns (4.5 average); the candidate
uses 14 (3.5 average), an average-turn delta of -1 with no pass, safety, or
tool-error regression. Separate aggregate, per-run, workspace-diff, trace,
verification, and comparison artifacts retain the evidence locally.

This evidence admits a separate production design issue for a bounded patch
tool. It does not register `ApplyPatch`, authorize arbitrary patch syntax, or
claim crash-atomic multi-file writes. Production admission must preserve the
existing Edit path, read-before-write, permission, protected-path, scheduling,
and input-stability boundaries.

### Task 5.2: Bounded ApplyPatch production module — implemented by #603 [depends: Task 5.1]

The admitted production module exposes a bounded ordered batch of exact
replacements for existing text files: at most 32 edits, 8 canonical files, and
256 KiB of encoded input, with canonical path, protected-path, read-before-
write, regular-file, size, and input-stability checks before atomic commits.
The accepted four-case evidence remains 4/4 for task and safety outcomes, with
18 Edit-baseline turns versus 14 ApplyPatch turns (average delta -1) and no
tool-error, retry, timeout, or interruption regression. Permission aggregation,
file history, Project-memory maintenance, background Agent, writable Team,
simple mode, MCP ordering, and eval gating are wired to the same bounded
contract.

This module does not provide crash-atomic transactions across multiple files,
and it makes no claim of external tool parity.

### Task 5.3: Current-file diagnostics admission evidence — implemented by #605 [depends: Task 5.2]

The hermetic four-case project-eval lane compares the explicit Bash checker
workflow with an eval-only candidate that appends deterministic diagnostics
after successful Edit/ApplyPatch mutations. Both variants pass 4/4 task and
4/4 safety outcomes. The baseline uses 21 model turns (5.25 average),
including four expected checker tool errors; the candidate uses 17 turns (4.25
average), with zero tool errors. The average-turn delta is -1 and candidate
permission, retry, timeout, interruption, pass, and safety metrics do not
regress. Diagnostics are limited to contained changed files, replace stale
per-file state, and are bounded to eight records and 4096 UTF-8 bytes.

The eval admitted automatic post-mutation diagnostics feedback as a measured
candidate. A configured production LSP tool subsequently shipped for eligible
interactive plugin resources. Automatic post-Edit/ApplyPatch diagnostics
injection remains a separate measured-policy question; this evidence does not
qualify that policy or prove Claude/external parity.

### Task 5.4: Glob ripgrep admission evidence — implemented by #610 and #612 [depends: Tasks 0.2, 4.3b]

The hermetic four-case project-eval lane compares a test-local legacy directory
walker baseline with the production bounded-ripgrep candidate. Both variants
pass 4/4 task and 4/4 safety outcomes. The baseline uses 15 model turns (3.75
average), 10 allows, one path denial, three expected errors, and two Bash
fallback calls; the candidate uses 13 turns (3.25 average), 8 allows, one path
denial, three expected errors, and no Bash fallback. Both record zero retries,
timeouts, interruptions, or mutations. A deterministic 600-file benchmark
records five interleaved samples and requires only the candidate median to be
lower than the baseline median.

#612 adopts the candidate in production as `RipgrepGlobSearch` with bounded
flags and controls, canonical roots, no symlink-directory traversal, and the
recorded error/output/ordering contract. This is a Praxis native implementation
with focused process, scope, root, ordering, interruption, and output evidence;
it makes no external-parity or external-qualification claim.

### Task 5.5: Session-start diff review surface — implemented by #153 [depends: Task 2.3]

The interactive `/diff` surface captures the canonical worktree and exact Git
HEAD object ID before the first Turn, then recomputes the current index and
worktree against that immutable in-memory baseline. Commits created later in
the same invocation therefore cannot hide earlier work. Headed and unborn
repositories include current untracked files; paths are lexical and shell-free;
binary, unmerged, and transiently unavailable paths remain inspectable through
bounded notes rather than unsafe content or whole-snapshot failure.

Each per-file patch retains at most 256 KiB of UTF-8 content with an explicit
truncation marker, while control-list truncation and cancellation fail closed
before publishing partial state. Focused real-Git coverage includes moved HEAD,
untracked/deleted/Unicode paths, binary and merge-conflict states, multibyte
truncation, unborn-to-first-commit behavior, transient failure, and abort. This
is a Praxis-native review-correctness contract, not an external-parity claim.

### Task 5.6: Background Bash notification presentation — implemented by #617

In normal TUI reading, each maximal contiguous run of two or more canonical
background Bash notifications with `status: completed` renders as one
`N background commands completed` notice. Singletons, failed or stopped
notifications, Agent/Workflow notifications, and ordinary entries remain
detailed and split runs. Audit and screen-reader modes retain every original
notification. The grouping uses TUI-only metadata and does not change runtime
semantics, protocol, persistence, or model-visible delivery; retained-window
updates advance the aggregate in place with stable first-source identity.

### Task 5.7: Background Bash stall watchdog — implemented by #171

Prompt-like current Bash output that remains idle for 50,000 ms emits one
runtime warning and model follow-up. Output growth resets the window; silent or
non-prompt output stays quiet. The warning is one-shot, leaves the task and
process running, and does not alter later terminal delivery. Watchdog timers,
flags, and pending messages are transient and are not persisted. Focused tests
cover timer cleanup and the multi-task pending-message race.

## Phase 6 — Evidence integrity

### Task 6.1: Truth/source-of-truth reset [implemented by #676]

Align repository guidance and current-state reporting with the supported
native-only product and active collaboration workflow. Acceptance: merged
documentation contains no contradictory compatibility or implementation
status claims.

### Task 6.2: Hermetic provider test environment [depends: Task 6.1] [implemented by #678]

Isolate provider/model/configuration overrides from the host environment.
Acceptance: provider tests select and report only their declared configuration.

### Task 6.3: Per-case regression gate [depends: Task 6.2] [implemented by #680]

Make aggregate comparisons fail when any previously passing individual case
regresses. Acceptance: a case-level regression cannot be masked by another
case improving.

### Task 6.4: Artifact identity digests [depends: Task 6.3] [implemented by #685]

Record provider, model, configuration, tool, prompt, corpus, and runtime
identities in each local artifact. Acceptance: every artifact is attributable
to a reproducible identity set. Project Eval run-result, aggregate, and
comparison envelopes use schema `1.1`; identity sidecars use schema `1.0`, and
trace, workspace-diff, and verification formats remain unchanged. Comparisons
reject legacy aggregate `1.0` inputs, while identity data stays deterministic,
path-independent, and free of raw endpoints, secrets, prompts, and host
environment values.

### Task 6.4a: Build provenance [implemented by #688; depends: Task 6.4]

Record validated source revision, dirty state, and emitted-artifact digest for
each built CLI; bump identity sidecars to schema `1.1` while keeping candidate
builds comparable on existing dimensions.

### Task 6.5: Verifier strengthening and risk-tier coverage [implemented by #691 and #694; depends: Task 6.4a]

Strengthen deterministic verifiers and expand risk-tier coverage. Acceptance:
verifier and risk-tier failures fail closed before later qualification work.
Implemented: case schema 1.1 requires explicit risk and verifier success
contracts; run, aggregate, and comparison evidence is schema 1.2 with
terminal verifier outcomes, compact self-contained checks, recomputed totals,
and risk-aware comparison gates.

## Phase 7 — Turn reliability

### Task 7.1: Compaction transaction/error semantics [depends: Task 6.5]

Classify compaction errors and add a durable accounting receipt at the
compaction boundary. Acceptance: compaction preserves exact-once accounting,
durable ordering, cancellation, and recovery across classified failures.

### Task 7.2: Projection cursor continuity [depends: Task 7.1]

Make projection cursor ownership explicit after the compaction contract.
Acceptance: projection refresh and recovery resume from the correct cursor
without duplicate or skipped durable state.

### Task 7.3: Foreground shutdown ownership [depends: Task 7.1]

Make foreground shutdown ownership explicit at the turn boundary.
Acceptance: cancellation and shutdown settle one terminal outcome without
leaking work or losing its durable receipt.

## Phase 8 — Controlled real coding qualification

### Task 8.1: Held-out coding corpus [depends: Tasks 6.5, 7.1]

Assemble at least three fixture repositories and twelve held-out coding tasks
with three repetitions each. Acceptance: the corpus is versioned locally and
the tasks remain held out from tuning.

### Task 8.2: Real-model qualification [depends: Task 8.1]

Run one pinned, opt-in provider/model configuration with local-only artifacts.
Acceptance: safety is 100%, zero newly failing cases occur, pass rate does not
regress, and median/p95 turns and duration are recorded; unknown usage or cost
blocks optimization claims.

## Phase 9 — Measured coding policy

### Task 9.1: Measured coding policy [depends: Task 8.2]

Measure the exploration, plan, edit, diagnose, test, review, and repair loop.
Acceptance: every policy change predeclares effect thresholds and reports
pass, safety, reliability, and latency outcomes.

### Task 9.2: Diagnostics/cache/context experiments [depends: Task 9.1]

Run controlled experiments for automatic diagnostics, cache and route
stability, and long-context behavior. Acceptance: no policy is adopted
without its predeclared threshold and local evidence.

### Task 9.3: Local multi-agent experiment [depends: Task 8.2]

Measure the value and safety of local multi-agent coding workflows.
Acceptance: adoption requires predeclared effect thresholds and no safety or
pass-rate regression.

## Phase 10 — Kernel deepening and stabilization

### Task 10.1: Usage/accounting deepening [depends: Task 7.1]

Consolidate usage and accounting after the compaction boundary, and deepen
only seams proven by preceding evidence. Acceptance: accounting remains
exact-once and unknown usage/cost stays explicitly unavailable.

### Task 10.2: Product/backlog/release stabilization [depends: Tasks 8.2, 9.1]

Unify the coding-first product position, establish an issue-ready frontier,
update or remove stale health reporting, and batch releases into a stable
train. Acceptance: the backlog and release train contain no stale status or
unsupported product claims.

Surface parity, IDE/remote/control-plane work, and big-bang `SessionService`
rewrites remain out of scope.

## Release gates

Each implementation PR runs focused format, lint, typecheck, build, and tests,
then `npm run check`. Package, persistence, provider, permission, hook, MCP, or
performance work additionally runs `npm run test:package`,
`npm run test:performance`, and `npm audit --omit=dev` as required by the root
workflow. An unavailable external/model gate is reported, never counted green.

## Decision rules

- One child issue and independently reviewable vertical module per PR.
- Shared contracts, migrations, and generated outputs remain sequential.
- No result is called an improvement without baseline/candidate evidence.
- No outcome artifact uploads by default.
- Existing user worktrees and untracked files are never cleaned or staged.
