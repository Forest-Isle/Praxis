# Local Agent Threat Model

## Trust boundary

Praxis serves one local OS user. It does not treat workspace files, model
output, fetched content, MCP servers, hooks, skills, or existing transcript
entries as trusted. OS user access remains the outer security boundary.

Protected assets:

- files outside the active workspace;
- credentials, environment variables, keychain items, and provider tokens;
- shell/process integrity;
- shared Praxis sessions, memory, and configuration;
- user intent expressed through permission decisions.

## Main threats and required controls

| Threat                                         | Control                                                                                                                                                                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt injection requests unsafe tools         | Model text never grants permission; normalized tool input is evaluated by local allow/ask/deny rules                                                                                                              |
| Path traversal or symlink escape               | Resolve and validate filesystem targets at execution time; session IDs must be UUIDs                                                                                                                              |
| Shell injection                                | Execute explicit argv when possible; display exact shell command before approval                                                                                                                                  |
| Sandboxed Bash escape                          | Official sandbox runtime, settings-file/extension write denies, explicit rule precedence, bare-repository file cleanup, and fail-closed required mode                                                             |
| Secret disclosure                              | Strip credential-named ambient variables from child processes; disable shell startup files; redact exact configured values before diagnostics/transcripts                                                         |
| Malicious project hook or MCP server           | Discover as data, show canonical origin, and require exact-fingerprint workspace trust before constructing project/local processes                                                                                |
| Malicious project provider selection           | Require exact canonical fingerprint trust before Registry selection; profiles remain built-in or globally defined, with no project endpoints or credentials                                                       |
| Malicious user/explicit hook, skill, or MCP    | Treat as user-authorized executable code; preserve scopes and apply the relevant tool, sandbox, environment, and redaction controls                                                                               |
| Transcript corruption or confused parent chain | Append-only writes, advisory lock, tail fingerprint, `parentUuid` check, no auto-repair                                                                                                                           |
| Unsupported transcript format                  | Native codec selects read-only fallback before any write                                                                                                                                                          |
| Provider payload incompatibility               | Persist only translated native completed events; raw payload stays in sidecar                                                                                                                                     |
| Web fetch SSRF or DNS rebinding                | Require HTTPS, reject private/loopback targets, pin requests to validated public DNS results, and revalidate redirects                                                                                            |
| Fetched-page prompt injection                  | Serialize page text as untrusted JSON data and keep the user request distinct under a higher-priority system instruction                                                                                          |
| Resource exhaustion                            | Bound model turns, post-redaction output, tool runtime, subprocess tree, and context size                                                                                                                         |
| Scheduled prompt loss or duplicate             | Validate native state, atomically replace with fingerprint retry, verify PID/start ownership, and consume due jobs once per scheduler service                                                                     |
| Dependency compromise                          | Lockfile, minimal dependencies, CI audit, explicit release review                                                                                                                                                 |
| Provider credential theft                      | Native Vault prefers macOS Keychain; the file fallback is explicit/availability-gated, uses `0700`/`0600`, atomic writes, ownership/mode/symlink checks, revision reconciliation, and a serialized lease          |
| Unsafe credential helper                       | Helpers are configured as argv arrays, run without a shell with bounded output/time, are user-scope only, and their output is never logged or persisted unredacted                                                |
| OAuth interception or token replay             | PKCE, unpredictable one-use state, loopback-only callback with strict path/state checks, one-use non-cacheable browser redirect bridge, bounded waits, explicit device flow, and Vault-only refresh-token storage |
| Codex endpoint or contract drift               | Codex uses a fixed `https://chatgpt.com/backend-api` endpoint, rejects API keys/overrides, requires the experimental kill switch, and keeps its Responses/SSE adapter private                                     |
| Diagnostic secret execution                    | Doctor resolves target/source locally without network access or executing credential helpers; it reports skipped helpers and redacts secrets, tokens, account IDs, URL query/fragment, and helper output          |

## Explicit assumptions

- User may intentionally grant broad shell/filesystem access.
- Workspace trust is separate from tool permission and sandbox modes. A stored
  grant covers only one canonical workspace plus the exact executable
  project/local hook and MCP fingerprint; changing definitions, source, scope,
  or hook execution environment requires a new decision. `--safe-mode` and
  `--bare` suppress shared executables even when a matching grant exists.
- Explicit MCP `env` and sensitive HTTP headers grant that credential to the
  configured server. Exact values and common auth/cookie payloads are redacted
  on return; transformed or encoded values are the server's responsibility.
- Environment filtering alone is not a process sandbox. Bash uses OS isolation
  only when shared `sandbox.enabled` settings activate a supported runtime;
  excluded or explicitly overridden Bash commands, hooks, and MCP servers still
  run as the local user and may access files or OS credential services available
  to that user.
- External processes do not honor Praxis locks; optimistic checks reduce but
  cannot eliminate a simultaneous append race from an uncooperative process.
- External processes also do not honor the Praxis scheduled-task lease.
  Physical fingerprint checks narrow but cannot eliminate the final
  check/replace race.
- A process already running as the user can alter shared files and sidecars.
  Sidecars therefore provide coordination, not an authorization boundary.
- Enterprise managed-policy enforcement and multi-user isolation are outside
  product scope.
- ChatGPT subscription OAuth and its backend are third-party behavior that
  OpenAI does not document as a stable public contract. The experimental
  Codex integration may stop working or change; the kill switch disables both
  login and inference. It is not a general OpenAI API-compatible transport.

## Security acceptance tests

- reject traversal-shaped session IDs;
- reject append after external tail mutation;
- reject writes for unsupported Claude versions;
- never put Praxis-private fields in shared JSONL;
- preserve unknown Claude fields without executing them;
- cancel and reap tool subprocesses on run cancellation;
- keep permission checks between normalized tool input and execution;
- keep ambient API/access keys, auth/PAT/JWT/tokens, secrets/passwords/private
  keys/credentials, authorization, cookies, and common database/Docker/npm
  credentials out of Bash, hook, version, and MCP stdio child environments;
- preserve explicit MCP env/header grants while redacting their exact values
  from tool results, warnings, errors, hook attachments, and shared JSONL;
- prevent login/non-interactive shell startup files from restoring stripped
  credentials.
- block project/local hooks and MCP transports before trust; preserve user and
  explicitly supplied resources; invalidate trust after executable config,
  source symlink, scope, or hook-environment changes; and keep corrupt native
  state fail-closed without rewriting unknown fields;
- reject private WebFetch literals and DNS results; never pass an unvalidated
  address to the HTTPS request lookup;
- bound WebFetch DNS/request duration, redirect count, response bytes, processed
  output, and cache lifetime.
- verify provider settings reject plaintext secrets and unsafe URLs; verify
  Vault permissions, ownership, symlink rejection, atomic mutation, revision
  reconciliation, and exact provider/profile deletion.
- verify OAuth state/PKCE, loopback and device flows, refresh rotation, and
  redaction of tokens, account IDs, URLs, and helper output; browser child
  arguments contain only an unpredictable local bridge URL.
- verify Doctor performs no network request and never executes a configured
  credential helper while still reporting that the helper was skipped.
- validate background agent IDs before path resolution, create sidechains
  exclusively, and never let TaskStop cancel a different task or main run;
- bound TaskOutput waits and returned content, serialize same-ID continuations,
  and keep completion metadata inside native tool results and user messages.
- validate numeric durable-task and `b`-prefixed Bash IDs before path
  resolution; allocate against both high-watermark and existing task files;
- serialize Praxis task graph mutations, use atomic task-file replacement, and
  rebase over changed native fingerprints, clean reciprocal edges, and release
  token-owned leases only when ownership still matches;
- run foreground and background Bash through one sanitized, bounded process
  runner; redact before temporary output persistence, atomically replace and
  validate resumable sidecars, XML-escape notifications, and expose temporary
  output to `Read` only.
- when sandboxing is enabled, run foreground Bash through the official runtime,
  keep explicit deny/ask rules ahead of auto-allow, enforce filesystem/network
  policy on macOS, honor closed override mode, annotate violations, and remove
  planted bare-repository control files before later unsandboxed Git activity;
- validate eight-hex top-level job IDs before path resolution; publish state and
  dispatch exclusively, authenticate local attach/stop requests, verify worker
  PID records before signaling, bound wire lines and recent output, repair dead
  workers without process takeover, and remove terminal PID/socket/token data.
- validate eight-hex scheduled IDs and five-field cron, preserve unknown native
  fields, fail closed on corrupt state, retry changed-file mutations, compare
  PID plus process start before takeover, deliver once, and clear waiters on
  interactive teardown.
