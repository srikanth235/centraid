# Issue #204 — gateway: group flat src/ into functional folders

Issue: #204

## Checklist
- [x] Group flat gateway src files into functional folders

## What changed

### Group flat gateway src files into functional folders
`packages/gateway/src/` was a flat directory of ~44 files. Grouped them into
functional folders — a pure move + intra-package import rewrite, no behavior
change:

- `routes/` — HTTP route handlers + helpers: agents-routes, apps-store-routes,
  automations-routes, templates-routes, lifecycle-routes,
  lifecycle-automation-routes, route-helpers
- `lifecycle/` — git-store lifecycle logic + its over-http integration tests:
  lifecycle-shared, publish-migrations, draft-data, and the
  clone/lifecycle/automation-lifecycle/publish-migrations/seed-draft-data/
  draft-preview `*-over-http` tests
- `cli/` — the gateway CLI: cli, cli-config, cli-paths, cli-runner-prefs,
  cli-token
- `serve/` — server bootstrap + serve integration tests: serve, build-gateway,
  default-logger, serve-git-store, serve-multiclient, serve-scheduler-reconcile
- `runs/` — run event bus + SSE + the unified conversation runner:
  run-event-bus, run-events-sse, unified-conversation-runner

`index.ts`, `paths.ts`, `validate-manifest.ts` (+ the
validate-automation-handler test) stay at root; the `worktree-store/` subtree
is unchanged. Each `.test.ts` moved with its source; all intra-package
relative imports (`.js` sources + tests' `.ts` imports) were rewritten.

## Out of scope
- No code/behavior changes — only file locations and import paths.
- The `lifecycle-*-routes` files live under `routes/` (they're route handlers);
  the `*-over-http` integration tests live under `lifecycle/` (they exercise the
  lifecycle flow end-to-end) — a deliberate split by file role.

## Verification
- On-disk import-resolution sweep: all 108 intra-package relative imports
  resolve to real files (0 broken).
- Governance gates pass (no broken doc links). Full tsc + test run is
  deferred to CI — this worktree can't resolve the package's `@centraid/*`
  source cross-package (the documented worktree limitation, unrelated to this
  move).
