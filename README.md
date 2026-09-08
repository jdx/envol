# Envol

A release control plane for CLIs: prepare a candidate, build and test it once,
then promote the exact tested commit and coordinate publication of the retained
artifacts from the project's own GitHub Actions workflow.

> [!WARNING]
> **Work in progress:** Envol is an early implementation and has not yet been
> validated for production releases. Live release operations are disabled unless
> `ENVOL_RELEASES_ENABLED=true` is set.

## Architecture

- Shared TypeScript API and release engine with a React dashboard.
- Cloudflare Workers, D1, and R2 for the hosted deployment.
- Node.js 24, SQLite, and local artifact storage for self-hosting.
- Rust CLI in `crates/envol` for configuring and operating releases.
- The Rust CLI uses the compiled `usage-rs` parser built on portable usage specs.
- GitHub Actions runners build candidates and publish them; GitHub OIDC authenticates
  artifact transfers and informational publication reports to Envol.

The intended release sequence freezes the source branch with a dedicated GitHub
ruleset, prepares an immutable candidate commit and PR, runs checks and uploads
artifacts, fast-forwards the source branch to the tested commit, creates the tag,
and unfreezes the branch. Envol then dispatches `envol-publish.yml` at that exact
tag. The repository workflow downloads and verifies the retained bytes before
publishing with credentials held only by GitHub. Envol independently verifies the
external release with read-only APIs before recording it as published. Publication
is resumable. Release lines configure stable, next-major prerelease, and maintenance
branches.

Envol defaults to `publishers = ["github"]`; this repository opts into both
GitHub and crates.io publication. Add `"crates"` to another project's publisher
list to publish the exact `.crate` produced by its candidate workflow. crates.io Trusted
Publishing is preferred; `CARGO_REGISTRY_TOKEN` is an optional fallback repository
secret. Envol itself neither receives these credentials nor writes releases or
registry packages.

Set `cargo_package` when `version_files` contains `Cargo.lock` and the released
package name cannot be read from one of the listed Cargo manifests.

## Local development

```sh
npm ci
npm run build
npm start
```

The dashboard listens on `http://localhost:8787`. Set `ENVOL_ADMIN_TOKEN` to enable
administrative API access; see `.env.example` for other environment variables.
The Node process reads environment variables supplied by the caller, so export
them before starting. Docker Compose is also provided for SQLite self-hosting.

```sh
npm run format:check
npm run check
npm test
npm run build
npx wrangler deploy --dry-run
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo run --locked -- check
```

Database contract tests run against both Node SQLite and Miniflare D1. The CI
`final` job requires every formatting, application, and CLI job to succeed;
failed or unexpectedly skipped jobs cannot produce a successful gate.

## Hosted deployment

After merge, GitHub Actions deploys to Cloudflare using the repository secret
`CLOUDFLARE_API_TOKEN`. The workflow creates Envol's D1 database and R2 bucket if
missing, applies migrations, seeds public project trackers, and deploys the
Worker. Configure the account and resource names in `wrangler.jsonc` for your
own account. Initial custom-domain setup is separate; CI does not need DNS access.

## Current limits

- The supplied publication workflow supports GitHub Releases and one retained
  crates.io package per candidate. Other registries need destination jobs and
  independent verification adapters.
- Cargo lockfile version updates currently assume the released crate has the same
  name as the repository; multi-crate workspaces need explicit package selection.
- GitHub's release API must expose asset SHA-256 digests, and crates.io must expose
  the published package checksum, before Envol will mark those destinations as
  published. Workflow reports alone never advance release state.
- Administration currently uses a shared token, not GitHub login or per-user ACLs.
- GitHub branch rules, PR readiness under a freeze, cancellation recovery,
  publication-workflow retries, Trusted Publishing, and registry propagation delays
  need live pilot validation before production use.
- Analytics collection and historical import helpers are preliminary; the full
  public popularity and milestones experience is not yet connected.

Do not enable live releases on an existing production project until the pilot
and recovery paths are validated. Never move a release tag, force-push a source
branch, or overwrite a published artifact.
