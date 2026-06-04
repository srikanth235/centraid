# Issue #201 — app-engine: group flat src/ files into functional folders

Issue: #201

## Checklist
- [x] Group flat app-engine src files into functional folders

## What changed

### Group flat app-engine src files into functional folders
`packages/app-engine/src/` was a flat directory of ~65 source files. Grouped
them into functional folders mirroring the domains already reflected in
`index.ts`'s export sections — a pure move + intra-package import rewrite, no
behavior change:

- `http/` — transport & routing: http-server, http-utils, router, static-server, changes-sse, security, cloud-routes, conversation-routes, turn-routes
- `registry/` — app registration & lifecycle: registry, app-paths, manifest, deregister-cleanup
- `handlers/` — handler execution & agent-tool dispatch: handler-runner, dispatcher, dispatcher-builtins, run-query, sql-ops, build-extra-prompt
- `data/` — per-app data.sqlite primitives: schema, table-rows, migrate, blob-store, log-store
- `settings/` — app-settings, settings-merge
- `conversation/` — chat surface & run ledger: conversation-history, conversation-runner, conversation-schema, conversation-store, conversation-store-sql, conversation-transcript, turn, run-stream-event, run-summary-sink
- `stores/` — gateway/identity DB: gateway-db, user-store
- `changes/` — change-bus, change-tracker

`index.ts`, `runtime.ts`, `types.ts` stay at the root (barrel, orchestrator,
widely-imported shared types); `concurrent-writers.test.ts` stays as a
cross-cutting test; `insights/` and `worker/` are unchanged. `model-pricing.ts`
also stays at root — it's the single file the `no-hardcoded-model-ids`
governance directive allowlists by exact path (the price table is a
model-id-to-price map), so keeping it put avoids fighting that constraint. Each `.test.ts`
moved with its source. All relative imports (both `.js` source imports and the
tests' `.ts` imports) were rewritten to the new layout, and the README's
file links were repointed. Also fixed a stale type-only import in
turn-routes.test.ts that pointed at a long-removed `./chat-runner.ts`
(now `conversation-runner`).

## Out of scope
- No code/behavior changes — only file locations and import paths.
- Pre-existing `docs/automations/*.mdx` references to non-existent
  `app-engine/src/automation-{manifest,webhook}.ts` were left as-is (unrelated
  to this move).
- `insights/` and `worker/` keep their current shape.

## Verification
- `tsc -p tsconfig.json --noEmit` clean (source tree).
- Full test suite green: 312 tests / 43 suites pass (unchanged from the
  pre-move baseline).
- README internal links re-verified to resolve to the moved files.
