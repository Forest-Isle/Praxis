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
- `README.md`, `LICENSE`, and `THIRD_PARTY_NOTICES.md`.

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
checks the package allowlist, size limits, version, license, and native
transcript write-safety matrix.

`npm run check` is a prerequisite for packaging. Its security cases run real
Bash, hook, and MCP children, verify explicit MCP credential grants are usable
but redacted on return, enforce post-redaction output bounds, cover structured
and interactive diagnostics, and reject any canary credential in shared hook
JSONL.

## Runtime matrix

| Surface                         | Matrix                                   | Expected behavior                                   |
| ------------------------------- | ---------------------------------------- | --------------------------------------------------- |
| Node.js                         | 24 and 25                                | clean install and full installed CLI loop           |
| OS                              | current macOS and Ubuntu GitHub runners  | package and performance gates                       |
| Provider API                    | OpenAI-compatible and Anthropic Messages | identical installed tool/resume/fork scenario       |
| Native transcript schema v1     | Praxis-owned `praxis.transcript`         | read-write append/resume/fork for validated events  |
| Unsupported or malformed format | unverified transcript                    | read-only parse/export; append and fork fail closed |

The package and performance gates stay provider-fixture based and do not depend
on a Claude installation. Native transcript schema changes require focused
fixtures, the tarball gate, and Standards/Spec review; unsupported formats are
always read-only and are never migrated.

## Native-only release boundary

The 0.39.x line is the first release with the native-only runtime data plane.
New and existing native sessions use `PRAXIS_HOME` or `~/.praxis`; `.claude`
and `CLAUDE_CONFIG_DIR` are not read. Legacy Claude transcripts and metadata
are unsupported and cannot be migrated or resumed. Claude-shaped protocol
fields remain where needed for wire compatibility, but persistence ownership
is Praxis-native.

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
request titles. It dispatches the real `CI` workflow for that exact version
branch and enables GitHub squash auto-merge. It waits for that exact run and
writes the required `CI` commit status only with the run's real conclusion and
details URL. Once the protected aggregate `CI` check passes, GitHub merges the
version pull request, creates an immutable `v<version>` tag and GitHub release,
then dispatches the isolated `Publish` workflow. No repository workflow writes
directly to `main`.

`Publish` checks out the immutable tag and repeats quality, native CLI surface,
installed-package, performance, and production-audit gates. It then creates the
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
