# Release Contract

Praxis ships as the unscoped `praxis-agent` npm package with the `praxis`
executable. Publishing is a separate, explicit operation; release validation
never contacts a registry for publication.

Runtime prerequisites are Node.js 24 or newer, `ripgrep` (`rg`) for the Grep
tool, and the native command shell: `/bin/zsh` on macOS or `/bin/bash` on Linux.
Praxis invokes those shells without user startup files and removes
credential-named ambient variables from child environments.

## Package boundary

The tarball contains only:

- compiled `dist/` JavaScript, declarations, and source maps;
- `package.json`;
- `README.md` and `LICENSE`.

Source, tests, fixtures, compatibility probes, local configuration, and project
documentation are not published. Compressed package size must stay below 1 MiB
and unpacked size below 4 MiB.

Run the complete tarball gate with:

```sh
npm run test:package
```

The gate builds, packs without lifecycle scripts, installs the tarball into an
empty project, and runs the installed npm bin through `--version`, `--help`, and
an isolated `sessions --json` smoke test. It then drives the installed CLI
through real local OpenAI Chat Completions and Anthropic Messages HTTP/SSE
providers. Each adapter must complete the same workspace `Read`, shared-rule
authorized `Bash`, canonical memory-detail `Read`, permission-authorized shared
memory `Write`, persisted tool-result continuation, final response, and resumed
turn. The gate also checks the package allowlist, size limits, version, license,
and Claude write-safety matrix.

`npm run check` is a prerequisite for packaging. Its security cases run real
Bash, hook, and MCP children, verify explicit MCP credential grants are usable
but redacted on return, enforce post-redaction output bounds, cover structured
and interactive diagnostics, and reject any canary credential in shared hook
JSONL.

## Runtime matrix

| Surface                             | Matrix                                   | Expected behavior                            |
| ----------------------------------- | ---------------------------------------- | -------------------------------------------- |
| Node.js                             | 24 and 25                                | clean install and full installed CLI loop    |
| OS                                  | current macOS and Ubuntu GitHub runners  | package and performance gates                |
| Provider API                        | OpenAI-compatible and Anthropic Messages | identical installed tool/resume scenario     |
| Claude Code 2.1.208                 | verified native profile                  | read-write plus all compatibility probes     |
| Claude Code 2.1.207, 2.1.209, 3.0.0 | unverified profiles                      | read-only parse; append and fork fail closed |
| Any other Claude version            | unverified profile                       | read-only until promoted below               |

Promoting a new Claude version to read-write requires new black-box fixtures,
an explicit versioned adapter, all unit and compatibility probes, tarball gate,
and Standards/Spec review. Version proximity is never treated as schema
compatibility.

## Manual package creation

```sh
npm ci
npm run check
npm run test:performance
npm run test:package
npm pack
```

Install the resulting artifact without publishing:

```sh
npm install --global ./praxis-agent-0.1.0.tgz
praxis --version
```
