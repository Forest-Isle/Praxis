# Release Automation

## Goal

Deliver every Praxis version from reviewed source to an immutable Git tag,
GitHub release, attested tarball, CycloneDX SBOM, checksums, and public npm
package through one reproducible pipeline.

## Design choice

Release Please manages version PRs and tags. A separate, explicitly dispatched
Publish workflow owns expensive regression and publication. This keeps routine
versioning automated, publication retryable, and npm credentials outside build
and pull-request workflows. Changesets were rejected because Praxis is one npm
package; manual-only versioning was rejected because it can drift from tags.

## Architecture

1. Pull requests and `main` run `CI`: quality, native-only production audit,
   macOS/Linux Node 24/25 installed-package lanes, and stable Linux Node 24 /
   macOS Node 25 performance sentinels. Claude Code is not installed or
   invoked by CI.
2. Release Please opens or updates one version PR from Conventional Commit
   titles. Changelog files remain intentionally disabled; GitHub release notes
   are authoritative. Because GitHub suppresses workflows from resources made
   by `GITHUB_TOKEN`, Release Please explicitly dispatches `CI` on the version
   branch, then enables squash auto-merge for that exact PR. The real aggregate
   `CI` check remains the branch-protection gate. Release Please waits for the
   exact same-SHA run and writes a `CI` commit status, linked to that run, only
   after its actual conclusion; a timeout or failed run writes a non-success
   status instead. Once every exact-head check and status is complete, the job
   observes automatic merge for at most 10 minutes. It immediately releases the
   concurrency group if the version PR becomes behind, closes without merging,
   or remains open past that window. When the PR merges, it dispatches one
   follow-up Release Please run from `main`; this is necessary because GitHub
   suppresses the ordinary `push` workflow caused by `GITHUB_TOKEN`. The release
   job has a 135-minute ceiling, which covers the three serial 40-minute
   protected-check windows, the bounded merge observation, and setup overhead.
3. After `CI` succeeds, GitHub automatically squash-merges the version PR,
   creating `v<package.version>` and a GitHub release.
4. Release Please sends a `release-created` repository dispatch carrying the
   exact tag.
5. Publish checks out that tag, repeats all native release gates,
   builds artifacts, attests and uploads them, then publishes the same tarball
   to npm.

## Key components

- `.github/workflows/ci.yml`: stable required `CI` status over all test lanes.
- `.github/workflows/release-please.yml`: version PR, exact-CI status bridge,
  tag, release, and dispatch.
- `.github/workflows/publish.yml`: tag validation, regression, artifacts, npm.
- Publish provisions the same Linux sandbox runtime prerequisites as CI before
  its complete release regression, so sandbox coverage cannot be bypassed by a
  release-only runner image.
- `scripts/verify-release-ref.mjs`: exact tag/package-version invariant.
- `scripts/build-release-artifacts.mjs`: deterministic tarball, SBOM, checksums.
- `release-please-config.json`: single Node package, `v` tags, no changelog file.
- CodeQL, dependency review, Scorecard, and Dependabot: continuous supply-chain
  maintenance independent of release credentials.

## Bootstrap

1. For the unclaimed initial package only, create a short-lived granular token
   on an npm account permitted to create public packages.
2. Create GitHub environment `npm`. Do not expose secrets to pull requests.
3. Push `main`, wait for required `CI`, then create the initial `v0.1.0` release.
4. Download and checksum the exact GitHub release tarball, publish it locally
   with the bootstrap token, then revoke the token.
5. In npm package settings, add trusted publisher repository
   `Forest-Isle/Praxis`, workflow `publish.yml`, environment `npm`.
6. Require 2FA and disallow bypass-2FA tokens for the package. No repository
   `NPM_TOKEN` secret may exist.

## Error handling and recovery

- Tag/version mismatch fails before package creation.
- A version PR stays open when a dispatched protected workflow fails or times
  out. The exact release head receives an explicit non-success bridge status,
  linked to the observed run when one exists, as long as that head has not
  changed during verification. Fixing source and merging it to `main` updates
  the PR and reruns the protected auto-merge path.
- Any regression failure stops artifact upload and npm publication.
- Artifact upload uses `--clobber`; a retry replaces only same-release files.
- npm versions are immutable. Publish checks the registry first and skips an
  exact version, making workflow retries safe.
- Never move or recreate a published tag. Fix source through a pull request and
  issue a new patch version.
- If GitHub release exists but npm does not, manually dispatch Publish with the
  existing tag. If npm exists but artifact upload failed, rerun the same tag.

## Test strategy

Before merge, run:

```sh
npm ci
npm run check
npm run test:package
npm run test:performance
npm audit --omit=dev
npm run release:artifacts -- "v$(node -p "require('./package.json').version")" /tmp/praxis-release
```

qualification gate, not a public CI dependency. Public and fork CI never needs
Claude subscription state, provider credentials, or billable model requests.

Validate workflows with `actionlint`. On GitHub, branch protection requires the
aggregate `CI` check; publication additionally requires the `npm` environment.
The installed-package gate audits the consumer dependency graph, not only the
repository lockfile, so root-only overrides cannot hide downstream advisories.
