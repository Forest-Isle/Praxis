# Local Agent Threat Model

## Trust boundary

Praxis serves one local OS user. It does not treat workspace files, model
output, fetched content, MCP servers, hooks, skills, or existing transcript
entries as trusted. OS user access remains the outer security boundary.

Protected assets:

- files outside the active workspace;
- credentials, environment variables, keychain items, and provider tokens;
- shell/process integrity;
- shared Claude sessions, memory, and configuration;
- user intent expressed through permission decisions.

## Main threats and required controls

| Threat                                         | Control                                                                                                                                                   |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt injection requests unsafe tools         | Model text never grants permission; normalized tool input is evaluated by local allow/ask/deny rules                                                      |
| Path traversal or symlink escape               | Resolve and validate filesystem targets at execution time; session IDs must be UUIDs                                                                      |
| Shell injection                                | Execute explicit argv when possible; display exact shell command before approval                                                                          |
| Secret disclosure                              | Strip credential-named ambient variables from child processes; disable shell startup files; redact exact configured values before diagnostics/transcripts |
| Malicious hook, skill, or MCP server           | Treat as user-installed executable code; show origin, preserve Claude scopes, require the applicable permission policy                                    |
| Transcript corruption or confused parent chain | Append-only writes, advisory lock, tail fingerprint, `parentUuid` check, no auto-repair                                                                   |
| Unsupported Claude format                      | Version adapter selects read-only fallback before any write                                                                                               |
| Provider payload incompatibility               | Persist only translated Claude-native completed events; raw payload stays in sidecar                                                                      |
| Web fetch SSRF or DNS rebinding                | Require HTTPS, reject private/loopback targets, pin requests to validated public DNS results, and revalidate redirects                                    |
| Fetched-page prompt injection                  | Serialize page text as untrusted JSON data and keep the user request distinct under a higher-priority system instruction                                  |
| Resource exhaustion                            | Bound model turns, post-redaction output, tool runtime, subprocess tree, and context size                                                                 |
| Scheduled prompt loss or duplicate             | Validate native state, atomically replace with fingerprint retry, verify PID/start ownership, and consume due jobs once per scheduler service             |
| Dependency compromise                          | Lockfile, minimal dependencies, CI audit, explicit release review                                                                                         |

## Explicit assumptions

- User may intentionally grant broad shell/filesystem access.
- Explicit MCP `env` and sensitive HTTP headers grant that credential to the
  configured server. Exact values and common auth/cookie payloads are redacted
  on return; transformed or encoded values are the server's responsibility.
- Environment filtering is not a process sandbox. Approved shell commands,
  hooks, and MCP servers still run as the local user and may access files or OS
  credential services available to that user.
- Claude Code does not honor Praxis locks; optimistic checks reduce but cannot
  eliminate a simultaneous append race from an uncooperative process.
- Claude Code also does not honor the Praxis scheduled-task lease. Physical
  fingerprint checks narrow but cannot eliminate the final check/replace race.
- A process already running as the user can alter shared files and sidecars.
  Sidecars therefore provide coordination, not an authorization boundary.
- Enterprise managed-policy enforcement and multi-user isolation are outside
  product scope.

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
- reject private WebFetch literals and DNS results; never pass an unvalidated
  address to the HTTPS request lookup;
- bound WebFetch DNS/request duration, redirect count, response bytes, processed
  output, and cache lifetime.
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
- validate eight-hex top-level job IDs before path resolution; publish state and
  dispatch exclusively, authenticate local attach/stop requests, verify worker
  PID records before signaling, bound wire lines and recent output, repair dead
  workers without process takeover, and remove terminal PID/socket/token data.
- validate eight-hex scheduled IDs and five-field cron, preserve unknown native
  fields, fail closed on corrupt state, retry changed-file mutations, compare
  PID plus process start before takeover, deliver once, and clear waiters on
  interactive teardown.
