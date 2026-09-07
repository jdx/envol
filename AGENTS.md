# Envol

TypeScript release engine and React dashboard; Cloudflare Workers/D1/R2 or Node/SQLite/local storage. Rust CLI in crates/envol.

- Run `npm run check`, `npm test`, `npm run build`, and `npx wrangler deploy --dry-run` for application changes.
- Run `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings`, and `cargo test --locked` for CLI changes.
- Never move release tags, force-push source branches, or replace published artifacts.
- Validate database behavior against both SQLite and Miniflare D1.
- No live branch freezes or releases during development without selecting an explicit pilot repository.
- Keep live integration gaps documented. Do not label mocked GitHub tests as live validation.
- Use conventional commit subjects. Create review-ready PRs, not drafts.
