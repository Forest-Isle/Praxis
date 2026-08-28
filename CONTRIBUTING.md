# Contributing to Praxis

## Development setup

Praxis requires Node.js 24 or newer, npm 11, and `ripgrep`.

```sh
git clone git@github.com:Forest-Isle/Praxis.git
cd Praxis
npm ci
npm run check
```

`npm run check` includes formatting, linting, internal documentation links,
module boundaries, typechecking, unit/integration tests, and a clean build.

`npm run test:coverage` measures all production code under `src/**` with V8 and
enforces global floors of 79% statements, 70% branches, 85% functions, and 81%
lines.

Keep changes focused and add tests for observable behavior. Changes affecting
Claude interoperability must retain Claude Code 2.1.208 and run:

```sh
npm run test:compat:all
```

Package, persistence, provider, permission, hook, MCP, or performance changes
must also run the relevant release gates:

```sh
npm run test:package
npm run test:performance
npm audit --omit=dev
```

## Pull requests

- Open an issue first for product-boundary or compatibility-contract changes.
- Use a Conventional Commit pull-request title: `feat:`, `fix:`, `docs:`,
  `test:`, `refactor:`, `perf:`, `build:`, `ci:`, or `chore:`.
- Describe user-visible behavior, compatibility impact, and verification.
- Update relevant documentation in the same pull request.
- Keep README user-oriented; place detailed contracts and references under
  `docs/` and add them to [docs/README.md](docs/README.md).
- Keep generated `dist/`, release tarballs, credentials, and local Claude data
  out of commits.

Squash merge is the canonical strategy. Release Please derives versions and
GitHub release notes from merged pull-request titles, then automatically
squash-merges its version pull request after the protected `CI` check passes.
Maintainers do not edit package versions, merge version pull requests, or
create release tags manually after bootstrap.

## Security reports

Do not open public issues for vulnerabilities. Follow [SECURITY.md](SECURITY.md).

Usage questions and setup help belong in
[GitHub Discussions](https://github.com/Forest-Isle/Praxis/discussions); see
[SUPPORT.md](SUPPORT.md). Keep the issue tracker for reproducible defects and
scoped feature requests.
