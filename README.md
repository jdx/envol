# Envol

A release control plane for CLIs: prepare a candidate, build and test it once,
then promote the exact tested commit and publish the retained artifacts.

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
- GitHub Actions runners build candidates; GitHub OIDC authenticates artifact uploads.

The intended release sequence freezes the source branch with a dedicated GitHub
ruleset, prepares an immutable candidate commit and PR, runs checks and uploads
artifacts, fast-forwards the source branch to the tested commit, creates the tag,
unfreezes the branch, and publishes retained artifacts. Publication is resumable.
Release lines configure stable, next-major prerelease, and maintenance branches.

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

- GitHub release publication is implemented; crates.io and other registry
  publishers are not yet implemented.
- Administration currently uses a shared token, not GitHub login or per-user ACLs.
- Candidate version editing does not yet synchronize package lockfiles.
- GitHub branch rules, PR readiness under a freeze, cancellation recovery, and
  publication retries need live pilot validation before production use.
- Analytics collection and historical import helpers are preliminary; the full
  public popularity and milestones experience is not yet connected.

Do not enable live releases on an existing production project until the pilot
and recovery paths are validated. Never move a release tag, force-push a source
branch, or overwrite a published artifact.
