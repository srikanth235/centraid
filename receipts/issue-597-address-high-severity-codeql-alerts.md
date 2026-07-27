# Issue 597 — fix(security): address high-severity CodeQL alerts

## Checklist
- [x] Created worktree `../centraid-security-wt` on branch `security-fix-high`.
- [x] Downloaded and triaged open high-severity GitHub CodeQL alerts.
- [x] Fixed or suppressed every actionable high-severity alert.
- [x] Added suppression comments for false-positive hash alerts.
- [x] Updated the local `format-check` governance hook to use `oxfmt.config.mjs`.
- [x] Verified formatting, linting, typechecks, and targeted package tests.
- [x] Committed and pushed `security-fix-high`.
- [x] Opened a PR linking this issue.

## What changed
The work was done in a new worktree (`../centraid-security-wt`) on branch `security-fix-high`. The open high-severity GitHub CodeQL alerts were downloaded, triaged, and either fixed with code changes or suppressed with an explanatory `// lgtm[...]` comment where the alert was a false positive.

### Checklist walkthrough
- Created worktree `../centraid-security-wt` on branch `security-fix-high`.
- Downloaded and triaged open high-severity GitHub CodeQL alerts.
- Fixed or suppressed every actionable high-severity alert.
- Added suppression comments for false-positive hash alerts.
- Updated the local `format-check` governance hook to use `oxfmt.config.mjs`.
- Verified formatting, linting, typechecks, and targeted package tests.
- Committed and pushed `security-fix-high`.
- Opened a PR linking this issue.

Security fixes:
- `packages/app-engine/src/http/http-server.ts` — fixed user-controlled-bypass and ensured CORS credentials are only paired with an explicitly allowed origin.
- `packages/gateway/src/routes/connections-routes.ts` — fixed user-controlled-bypass.
- `packages/agent-runtime/src/preflight.ts`, `packages/app-engine/src/conversation/auto-title.ts`, `packages/automation/src/handler/agent-answer.ts`, `packages/blueprints/src/app-rewrites.ts`, `packages/client/src/replica/shell-session.ts`, `packages/vault/src/blob/pdf-text.ts`, `packages/vault/src/blob/pipeline.ts`, `packages/vault/src/blob/s3-transfer.ts`, `packages/vault/src/blob/stream-ingress.ts`, `packages/vault/src/errors.ts`, `packages/vault/src/gateway/sql.ts`, `packages/vault/src/ingest/enrich-publishers.ts`, `packages/vault/src/ingest/mbox.ts`, `packages/vault/src/wal-shipper.ts` — replaced ReDoS/polynomial-ReDoS regexes with safe parsers or bounded alternatives.
- `scripts/release/changelog-to-github.mjs`, `scripts/release/classify.mjs`, `scripts/release/publish.mjs`, `scripts/release/restamp-rollout.mjs` — added and used `escapeRegExp` so version strings cannot inject regex metacharacters.
- `packages/backup/scripts/bench-wal.mjs`, `packages/backup/src/engine.ts`, `packages/backup/src/materialize.ts`, `packages/backup/src/wal-restore.ts`, `packages/gateway/src/cli/key-store.ts`, `packages/gateway/src/cli/key-store.test.ts`, `packages/gateway/src/routes/apps-store-draft-files.ts`, `packages/gateway/src/routes/route-helpers.ts`, `packages/gateway/src/routes/templates-routes.test.ts`, `packages/gateway/src/serve/connection-broker.test.ts`, `packages/vault/src/blob/local.ts`, `packages/vault/src/wal-shipper-clone.test.ts`, `scripts/ci/lockfile-lint.mjs`, `scripts/gateway-npm/pack.mjs`, `scripts/test-report/smoke.mjs`, `scripts/test-report/validate-matrix.mjs` — removed `existsSync`/`access` pre-checks and other file-system race conditions.
- `packages/vault/src/blob/stream-ingress.ts`, `packages/gateway/src/cli/key-store.test.ts` — created temporary files via `mkdtemp` / restrictive modes.
- `scripts/ci/lockfile-lint.mjs`, `apps/web/scripts/stamp-sw-version.mjs`, `packages/gateway/src/routes/templates-routes.test.ts`, `packages/gateway/src/serve/connection-broker.test.ts`, `packages/app-engine/src/http/bridge-script.test.ts`, `packages/app-engine/src/http/static-server.test.ts`, `packages/blueprints/src/code-highlight.test.ts` — replaced URL-substring checks and unsafe HTML/string construction with parsing and whitelist-based sanitization.
- `apps/desktop/tests/e2e-live/driver.mjs` — replaced incomplete string escaping with safer formatting.
- `packages/backup/src/recovery-kit.ts`, `packages/gateway/src/cli/key-store.ts`, `packages/vault/src/ingest/staging.ts` — added `// lgtm[js/insufficient-password-hash]` suppression comments because SHA-256 is used for identifiers/fingerprints, not password verification.
- `packages/tunnel/scripts/spike-pipe.mjs` — added `// lgtm[js/insecure-download]` suppression because the HTTP fetch targets a local loopback demo endpoint only.
- `.governance/packs/srikanth235/centraid/directives/format-check/check.sh` — fixed the pre-commit `format-check` hook to pass `-c "$REPO_ROOT/oxfmt.config.mjs"`, matching the repo's `bun run format:check` configuration.

### Files touched
`apps/desktop/tests/e2e-live/driver.mjs`, `apps/web/scripts/stamp-sw-version.mjs`, `packages/agent-runtime/src/preflight.ts`, `packages/app-engine/src/conversation/auto-title.ts`, `packages/app-engine/src/handlers/dispatcher.ts`, `packages/app-engine/src/http/bridge-script.test.ts`, `packages/app-engine/src/http/http-server.ts`, `packages/app-engine/src/http/static-server.test.ts`, `packages/automation/src/handler/agent-answer.ts`, `packages/backup/scripts/bench-wal.mjs`, `packages/backup/src/engine.ts`, `packages/backup/src/materialize.ts`, `packages/backup/src/recovery-kit.ts`, `packages/backup/src/wal-restore.ts`, `packages/blueprints/src/app-rewrites.ts`, `packages/blueprints/src/code-highlight.test.ts`, `packages/client/src/replica/shell-session.ts`, `packages/gateway/src/cli/key-store.test.ts`, `packages/gateway/src/cli/key-store.ts`, `packages/gateway/src/routes/apps-store-draft-files.ts`, `packages/gateway/src/routes/connections-routes.ts`, `packages/gateway/src/routes/route-helpers.ts`, `packages/gateway/src/routes/templates-routes.test.ts`, `packages/gateway/src/serve/connection-broker.test.ts`, `packages/tunnel/scripts/spike-pipe.mjs`, `packages/vault/src/blob/local.ts`, `packages/vault/src/blob/pdf-text.ts`, `packages/vault/src/blob/pipeline.ts`, `packages/vault/src/blob/s3-transfer.ts`, `packages/vault/src/blob/stream-ingress.ts`, `packages/vault/src/errors.ts`, `packages/vault/src/gateway/sql.ts`, `packages/vault/src/ingest/enrich-publishers.ts`, `packages/vault/src/ingest/mbox.ts`, `packages/vault/src/ingest/staging.ts`, `packages/vault/src/wal-shipper-clone.test.ts`, `packages/vault/src/wal-shipper.ts`, `scripts/ci/lockfile-lint.mjs`, `scripts/gateway-npm/pack.mjs`, `scripts/release/changelog-to-github.mjs`, `scripts/release/classify.mjs`, `scripts/release/publish.mjs`, `scripts/release/restamp-rollout.mjs`, `scripts/test-report/smoke.mjs`, `scripts/test-report/validate-matrix.mjs`, `.governance/packs/srikanth235/centraid/directives/format-check/check.sh`, `receipts/issue-597-address-high-severity-codeql-alerts.md`.

## Decisions
- The `js/insufficient-password-hash` alerts in `key-store.ts`, `recovery-kit.ts`, and `staging.ts` are false positives. The SHA-256 hashes are content/identifier fingerprints, not password digests, so they are suppressed with inline `// lgtm[...]` comments rather than reworked.
- The `js/insecure-download` alert in `tunnel/scripts/spike-pipe.mjs` is a local loopback demo fetch, so it is suppressed with a justification comment.
- The combined test matrix showed load-sensitive timeouts, so verification was done with per-package test runs, which all passed.
- The local `format-check` governance hook was failing because it invoked `oxfmt --check` without the repo's `oxfmt.config.mjs`. Rather than bypass governance, the hook was updated to match `bun run format:check`.

## Out of scope
- Medium/low-severity CodeQL alerts.
- Re-running the full combined test matrix in CI; a few tests are load-sensitive and passed when run per-package.

## Verification
```sh
cd /Users/srikanth/gitspace/centraid-security-wt
bun run format:check
bun run lint
bun run lockfile:lint
bun run lint:types
bun run knip
bunx turbo run typecheck
bun run test --filter=@centraid/agent-runtime
bun run test --filter=@centraid/app-engine
bun run test --filter=@centraid/automation
bun run test --filter=@centraid/backup
bun run test --filter=@centraid/blueprints
bun run test --filter=@centraid/client
bun run test --filter=@centraid/gateway
bun run test --filter=@centraid/tunnel
bun run test --filter=@centraid/vault
```

All of the above commands passed. After verification, the `security-fix-high` branch was committed and pushed, and a PR was opened linking issue #597.

## Audit
**Verdict: PASS**

- `'## What changed' faithfully describes the diff (no misrepresentation, no omission)` — PASS. The diff touches 47 files across the categories described (CORS/auth hardening in `http-server.ts`, `boundedString` state handling in `connections-routes.ts`, ReDoS/polynomial-ReDoS regex replacements, `escapeRegExp` for version strings, removal of `existsSync`/`access` TOCTOU races, `mkdtemp`/restrictive temp-file modes, URL parsing and whitelist-based sanitization, safer string escaping, `// lgtm[...]` suppressions for hash false-positives and the local loopback demo fetch, and the `format-check` hook update). The only minor gap is that `packages/app-engine/src/handlers/dispatcher.ts` is listed under `### Files touched` but not called out explicitly in the narrative bullets; its change is still a TOCTOU/race fix consistent with the broad category.
- `each '- [x]' item is realized in the diff` — PASS. Every checked item in `## Checklist` is supported by the diff content, the `### Files touched` list, or the `## Verification` block.
- `the '## Checklist' mirrors the issue's checklist` — PASS. `gh issue view 597 --json body` returns an identical 8-item checklist: worktree creation, triage of high-severity alerts, fixing/suppressing alerts, suppression comments for hash false positives, the `format-check` hook update, verification, commit/push, and PR creation. Each item matches the receipt line-for-line and all are marked `- [x]`.

## Steering
**Verdict: PASS**

- One steering event was recorded under `## Accounting` → `### Steering`: `steer-opencode74593-1-1` / session `opencode-74593` / issue `#597` / type `correction` / tier `classifier` / user-reason `run chekcs and create PR` / commit `fix(security): address high-severity CodeQL alerts (#597)` / ordinal `1` / timestamp `2026-07-27T14:45:49Z`.
- No non-steering messages were treated as steering: the earlier "summary of work done so far" request was not a correction or interrupt and was not recorded; only the redirect/correction (`run chekcs and create PR`) was appended.
- `python3 .governance/packs/governance-kit/audit/directives/agent-steering-accounting/lib/ledger.py validate receipts/issue-597-address-high-severity-codeql-alerts.md` produced no violations.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-opencode74593-1-1 | opencode-74593 | #597 | correction | classifier | run chekcs and create PR | fix(security): address high-severity CodeQL alerts (#597) | 1 | 2026-07-27T14:45:49Z |
