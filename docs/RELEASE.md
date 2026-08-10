# Release Contract

Praxis ships as the unscoped `praxis-agent` npm package with the `praxis`
executable. Publishing is a separate, explicit operation; release validation
never contacts a registry for publication. GitHub Actions is the authoritative
release path; local publication is an emergency-only fallback.

Runtime prerequisites are Node.js 24 or newer, `ripgrep` (`rg`) for the Grep
tool, and the native command shell: `/bin/zsh` on macOS or `/bin/bash` on Linux.
Praxis invokes those shells without user startup files and removes
credential-named ambient variables from child environments.

## Package boundary

The tarball contains only:

- compiled `dist/` JavaScript, declarations, and source maps;
- versioned MCPB manifest schemas required by the runtime;
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
isolated `sessions --json`, `inspect --json`, and byte-exact `export` smoke
tests for writable, unsupported-version, and corrupt transcripts without a
provider. It then drives the installed CLI
through real local OpenAI Chat Completions and Anthropic Messages HTTP/SSE
providers. Each adapter must complete the same workspace `Read`, shared-rule
authorized `Bash`, canonical memory-detail `Read`, permission-authorized shared
memory `Write`, persisted tool-result continuation, final response, and resumed
turn. It then executes provider-free `praxis fork --json`, verifies the fork
preserves complete Read/Bash/memory/tool-result history field-for-field under a
new session ID, and proves the fork creates no provider request. The gate also
checks the package allowlist, size limits, version, license, and Claude
write-safety matrix.

`npm run check` is a prerequisite for packaging. Its security cases run real
Bash, hook, and MCP children, verify explicit MCP credential grants are usable
but redacted on return, enforce post-redaction output bounds, cover structured
and interactive diagnostics, and reject any canary credential in shared hook
JSONL.

## Runtime matrix

| Surface                             | Matrix                                   | Expected behavior                             |
| ----------------------------------- | ---------------------------------------- | --------------------------------------------- |
| Node.js                             | 24 and 25                                | clean install and full installed CLI loop     |
| OS                                  | current macOS and Ubuntu GitHub runners  | package and performance gates                 |
| Provider API                        | OpenAI-compatible and Anthropic Messages | identical installed tool/resume/fork scenario |
| Claude Code 2.1.208                 | verified native profile                  | read-write plus all compatibility probes      |
| Claude Code 2.1.207, 2.1.209, 3.0.0 | unverified profiles                      | read-only parse; append and fork fail closed  |
| Any other Claude version            | unverified profile                       | read-only until promoted below                |

Stage 53 clean-room evidence: `test:package` and `test:performance` passed in
all four combinations macOS/Node 24, macOS/Node 25, Linux ARM64/Node 24, and
Linux ARM64/Node 25. `test:compat:all` passed 34 isolated Claude/Praxis gates on
macOS/Node 25. The aggregate gate is intentionally separate from package and
performance runs because Claude Code is a local installation dependency while
the release matrix must stay provider-fixture based.

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

## Automated release path

Release Please maintains a version pull request from Conventional Commit pull
request titles. Merging that pull request creates an immutable `v<version>` tag
and GitHub release, then dispatches the isolated `Publish` workflow. No
repository workflow writes directly to `main`.

`Publish` checks out the immutable tag and repeats quality, credential-free CLI
surface compatibility, installed-package, performance, and production-audit
gates. It then creates the
npm tarball, CycloneDX SBOM, and `SHA256SUMS`, records GitHub artifact
attestations, attaches all files to the GitHub release, and publishes the exact
same tarball to npm with provenance. Publication is idempotent: rerunning an
already published version verifies its presence and succeeds without replacing
it.

The one-time initial npm publication uses a short-lived local bootstrap token
because npm cannot attach a trusted publisher to a package that does not yet
exist. Publish the exact attested GitHub release tarball, revoke the token, and
configure npm Trusted Publishing for `Forest-Isle/Praxis`, workflow
`publish.yml`, environment `npm`. Repository secrets are not a supported
publication path; every automated release authenticates only with GitHub OIDC.

See [RELEASE_AUTOMATION.md](RELEASE_AUTOMATION.md) for bootstrap, retry, and
recovery procedures.
