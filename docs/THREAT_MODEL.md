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

| Threat                                         | Control                                                                                                                |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Prompt injection requests unsafe tools         | Model text never grants permission; normalized tool input is evaluated by local allow/ask/deny rules                   |
| Path traversal or symlink escape               | Resolve and validate filesystem targets at execution time; session IDs must be UUIDs                                   |
| Shell injection                                | Execute explicit argv when possible; display exact shell command before approval                                       |
| Secret disclosure                              | Redact known credentials from diagnostics; do not persist provider auth or environment snapshots in transcripts        |
| Malicious hook, skill, or MCP server           | Treat as user-installed executable code; show origin, preserve Claude scopes, require the applicable permission policy |
| Transcript corruption or confused parent chain | Append-only writes, advisory lock, tail fingerprint, `parentUuid` check, no auto-repair                                |
| Unsupported Claude format                      | Version adapter selects read-only fallback before any write                                                            |
| Provider payload incompatibility               | Persist only translated Claude-native completed events; raw payload stays in sidecar                                   |
| Resource exhaustion                            | Bound model turns, output, tool runtime, subprocess tree, and context size                                             |
| Dependency compromise                          | Lockfile, minimal dependencies, CI audit, explicit release review                                                      |

## Explicit assumptions

- User may intentionally grant broad shell/filesystem access.
- Claude Code does not honor Praxis locks; optimistic checks reduce but cannot
  eliminate a simultaneous append race from an uncooperative process.
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
- keep permission checks between normalized tool input and execution.
