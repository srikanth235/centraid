# Issue #417 — replica protocol hardening

## Checklist

- [x] Reject reused invocation ids before execution when journal identity differs.
- [x] Make ordinary invocation failures replay consistently without turning them into consent denials.
- [x] Elect one service-worker bridge owner per remembered device and prove a tunneled write executes once across multiple tabs.
- [x] Preserve the replica intent id through bridge timeout fallback.
- [x] Emit production settlement invalidations for dependency-only intents, preserve every debounced intent signal, and keep queued Agenda proposals visible.
- [x] Prevent the kit's swallow-first subscription heuristic from rendering stale-over-fresh when a rerun beats the initial read promise.
- [x] Bind device trust to owner-minted pairing tickets and enforce read-only trust at the authenticated gateway dispatch boundary.
- [x] Partition tunnel caches by bridge and app authority, require a live owner before cache hits, use opaque-origin CORS, and evict on revocation or purge races.
- [x] Resolve admission waiters on offline exits, bootstrap outcomes, and claim failures.
- [x] Keep a warm replica across online flaps and fence stale feed work during bootstrap.
- [x] Atomically rotate replica epochs and trigger contracts, hash generated trigger inputs, and scrub newly sealed extension values from retained change history.
- [x] Validate optimistic mutations before enqueue, tolerate legacy poison at read time, and normalize numeric primary keys.
- [x] Bind vault intent settlement to the authenticated device and app.
- [x] Harden SSE error classification, enrollment locking, bootstrap/lazy-row bounds, closed-session purge, dynamic subscriptions, non-progressing pulls, intent-conflict disclosure, and legacy enrollment loading.
- [x] Add focused unit, integration, browser, and performance regressions for the repaired seams.

## What changed

### Invocation and replica correctness

The vault now checks an existing journal row's immutable command, agent, and grant identity before either the parked or normal execution path can write. Sticky ordinary failures replay as failures using their durable receipt instead of being reclassified as owner denials. Final intent settlement verifies both the authenticated device and the app-to-consent binding, preventing a foreign intent id from terminating another outbox entry.

Replica trigger installation and epoch rotation now share one immediate transaction. The persisted contract marker covers SQLite schema state and the normalized generated trigger SQL, so changes to sealed or credential-column inputs self-heal even without an unrelated DDL change. Registering a newly sealed extension column also removes its plaintext from retained `old_values_json` snapshots.

### Client settlement and recovery

The client exports one production intent-invalidation derivation path used by both the coordinator and blueprint boot harness. It emits a distinct terminal event for every dependency-only or optimistic intent, while the app kit retains all intent details across its debounce window. Agenda leaves a queued proposal visible and labels it as saved on-device instead of closing an apparently empty modal.

The kit now prevents its swallow-first subscription heuristic from rendering stale-over-fresh when a rerun beats the initial read promise. A subscription value that arrives before the initial read settles is buffered and replayed after settlement, with a smoke regression covering the formerly reversed completion order.

Admission waiters now settle when connectivity drops, bootstrap already contains the outcome, or claiming the next IndexedDB intent fails. Online events resume incrementally when a cursor exists; stale pull generations cannot overwrite a newer bootstrap; repeated identical or non-progressing batches trip a bounded rebootstrap circuit breaker. Subscription filtering follows the current catalog, purge clears the SSE cursor even after close, and read-time optimistic application skips legacy malformed entries after enqueue-time validation catches all new ones.

### Device trust and gateway hardening

Pairing tickets carry the owner-selected `full` or `readonly` tier; clients cannot self-upgrade it, and read-only devices cannot mint replacement tickets. A shared authenticated-dispatch policy blocks mutation surfaces for read-only tokens while retaining explicit read, describe, and checkpoint operations. Legacy pre-#406 enrollment rows are normalized to `full` plus non-remembered instead of being silently discarded, so upgrading does not force re-pairing.

Replica SSE validates limits before starting a stream and reports transient polling failures as retryable. Bootstrap and synthetic-row scans have explicit size/work ceilings. Intent identity conflicts return the same in-flight envelope as unknown work, removing the cross-device existence oracle. Enrollment lock contention fails quickly rather than blocking the daemon event loop.

### PWA tunnel and app bridge

The service worker performs an effect-free ownership claim and sends each tunnel request to exactly one matching tab. Explicit iframe routes inherit their owning bridge and app authority; durable cache keys include both scopes; cache hits require a live owner. Cached blobs and assets conditionally revalidate authorization, 401/403 responses clear cookies and both cache buckets, and a purge generation prevents an in-flight write from recreating deleted caches. Opaque iframes receive `Access-Control-Allow-Origin: null` rather than wildcard access.

Only remembered-device bridge ids participate in persistent tunnel caches. The performance fixture now exercises that production identity form and verifies warm authorization checks transfer no response body. The bridge's direct-write fallback carries the original intent id, preserving end-to-end idempotency after a slow admission timeout.

### Review notes retained intentionally

Three low-severity observations in #417 describe existing protocol choices rather than correctness defects: server-backed query fan-out remains correctness-first, ephemeral devices still retain server-side checkpoints for daemon cleanup and retention accounting, and URL-addressed gateway identities continue to be reclaimed by the existing gateway lifecycle manifest/purge path. No verified actionable finding from #417 is intentionally left unresolved.

Repository-wide verification also exposed a stale gateway test that still expected an unconfigured backup surface to hide the active vault. The production route has intentionally inventoried that vault as `gateway-local` since the bounded-storage work, so the assertion now covers the current response contract rather than an obsolete empty list.

The final governance pass exposed 11 cohesive source or regression files already at, or moved just beyond, the repository's 500-line hygiene limit. Each now carries the directive's explicit file-level waiver with an issue-scoped reason; five otherwise untouched inherited files changed only to document that existing exception. No runtime behavior changed in those five files, and decomposing these cross-cutting modules is outside #417.

### Checklist crosswalk

- **Reject reused invocation ids before execution when journal identity differs.** `assertInvocationIdentity` runs before either execution path and regression coverage proves that a command mismatch cannot write or brick reopen.
- **Make ordinary invocation failures replay consistently without turning them into consent denials.** Replay now returns the latest durable ordinary-failure receipt, while only confirmed owner-denial receipts enter the denial path.
- **Elect one service-worker bridge owner per remembered device and prove a tunneled write executes once across multiple tabs.** The claim handshake selects one tab, and the multi-page browser regression counts one total execution.
- **Preserve the replica intent id through bridge timeout fallback.** `centraid_write` receives the original `intentId` in the direct fallback request.
- **Emit production settlement invalidations for dependency-only intents, preserve every debounced intent signal, and keep queued Agenda proposals visible.** The shared invalidation derivation is keyed per intent, the kit buffers every detail, and the modal retains its queued state.
- **Prevent the kit's swallow-first subscription heuristic from rendering stale-over-fresh when a rerun beats the initial read promise.** The kit buffers and replays a pre-settlement subscription update after the initial read, and the smoke test proves a late initial result cannot remain rendered over fresher data.
- **Bind device trust to owner-minted pairing tickets and enforce read-only trust at the authenticated gateway dispatch boundary.** Trust is stored on the ticket, ignored from redemption input, and checked before dispatch.
- **Partition tunnel caches by bridge and app authority, require a live owner before cache hits, use opaque-origin CORS, and evict on revocation or purge races.** Cache keys, owner checks, `null` origin, authorization revalidation, and purge generations implement the complete boundary.
- **Resolve admission waiters on offline exits, bootstrap outcomes, and claim failures.** Each exit path now settles its waiter as queued or rejects it with the storage failure.
- **Keep a warm replica across online flaps and fence stale feed work during bootstrap.** A warm cursor resumes the feed, and feed generations discard pre-bootstrap pulls.
- **Atomically rotate replica epochs and trigger contracts, hash generated trigger inputs, and scrub newly sealed extension values from retained change history.** One immediate transaction updates epoch, triggers, and the generated-SQL marker; extension registration scrubs historical snapshots.
- **Validate optimistic mutations before enqueue, tolerate legacy poison at read time, and normalize numeric primary keys.** New intents fail at admission, old invalid entries are skipped during reads, and canonical/optimistic identifiers compare through `String`.
- **Bind vault intent settlement to the authenticated device and app.** The vault choke point joins the outcome's external app identity to the consent app and compares both it and `intentDeviceId`.
- **Harden SSE error classification, enrollment locking, bootstrap/lazy-row bounds, closed-session purge, dynamic subscriptions, non-progressing pulls, intent-conflict disclosure, and legacy enrollment loading.** Focused route, store, session, and coordinator tests exercise every listed hardening seam.
- **Add focused unit, integration, browser, and performance regressions for the repaired seams.** The verification matrix below covers Vitest, full gateway/blueprint packages, Playwright cache behavior, and the warm-byte budget.

### Files

- `apps/web/public/sw.js`
- `apps/web/src/iroh-transport.ts`
- `apps/web/tests/e2e/perf-budgets.ts`
- `apps/web/tests/e2e/perf-waterfall.spec.ts`
- `apps/web/tests/e2e/web-pwa-cache.spec.ts`
- `packages/app-engine/src/http/bridge-script.test.ts`
- `packages/app-engine/src/http/bridge-script.ts`
- `packages/blueprints/apps/agenda/components/CreateModal.jsx`
- `packages/blueprints/apps/agenda/app.jsx`
- `packages/blueprints/kit/kit.js`
- `packages/blueprints/package.json`
- `packages/blueprints/src/app-boot-harness.ts`
- `packages/blueprints/src/kit-smoke.test.ts`
- `packages/client/package.json`
- `packages/client/src/replica/coordinator.test.ts`
- `packages/client/src/replica/coordinator.ts`
- `packages/client/src/replica/index.ts`
- `packages/client/src/replica/intent-invalidations.ts`
- `packages/client/src/replica/intents.ts`
- `packages/client/src/replica/query.test.ts`
- `packages/client/src/replica/query.ts`
- `packages/client/src/replica/shell-session-admission.test.ts`
- `packages/client/src/replica/shell-session.test.ts`
- `packages/client/src/replica/shell-session.ts`
- `packages/client/src/replica/sqlite-store.test.ts`
- `packages/client/src/replica/sqlite-store.ts`
- `packages/client/src/replica/types.ts`
- `packages/client/src/vault-change-feed.ts`
- `packages/gateway/src/cli/admin.test.ts`
- `packages/gateway/src/cli/device-admin.ts`
- `packages/gateway/src/cli/endpoint-host.ts`
- `packages/gateway/src/routes/devices-routes.test.ts`
- `packages/gateway/src/routes/devices-routes.ts`
- `packages/gateway/src/routes/pair-routes.ts`
- `packages/gateway/src/routes/replica-intent-route.test.ts`
- `packages/gateway/src/routes/replica-intent-route.ts`
- `packages/gateway/src/routes/replica-routes.test.ts`
- `packages/gateway/src/routes/replica-routes.ts`
- `packages/gateway/src/serve/build-gateway.ts`
- `packages/gateway/src/serve/device-plane.test.ts`
- `packages/gateway/src/serve/enrollment-store.ts`
- `packages/gateway/src/serve/pairing-store.ts`
- `packages/gateway/src/serve/replica-intent-context.ts`
- `packages/gateway/src/serve/serve-device-tokens.test.ts`
- `packages/gateway/src/serve/serve.test.ts`
- `packages/gateway/src/serve/vault-plane.ts`
- `packages/vault/src/gateway/execution.ts`
- `packages/vault/src/blob/blob.test.ts`
- `packages/vault/src/gateway/ext-sealed.test.ts`
- `packages/vault/src/gateway/ext.ts`
- `packages/vault/src/gateway/gateway.test.ts`
- `packages/vault/src/gateway/gateway.ts`
- `packages/vault/src/gateway/types.ts`
- `packages/vault/src/replica/invocation-commits.ts`
- `packages/vault/src/replica/change-log.test.ts`
- `packages/vault/src/replica/change-log.ts`
- `packages/vault/src/replica/parked.ts`
- `receipts/issue-417-replica-protocol-hardening.md`

## Out of scope

- Redesigning server-query fan-out into a dependency-aware invalidation protocol; the current path over-fetches but does not duplicate delivery or violate isolation.
- Changing checkpoint retention semantics for non-remembered devices; `rememberDevice` controls client persistence, not the server's authenticated cursor bookkeeping.
- Replacing the existing gateway lifecycle purge mechanism with a second URL-orphan collector.

## Decisions

- Treat the issue's final three low-severity notes as explicit protocol choices, not defects: correctness-first server-query fan-out, daemon-side cursor bookkeeping for ephemeral clients, and existing lifecycle-manifest cleanup for removed URL-addressed gateways.
- Make persistent tunnel caching conditional on the production remembered-device id prefix. This preserves the invariant that an ephemeral session leaves no reusable browser cache, at the cost of keeping authorization revalidation requests on remembered cache hits.
- Conceal a foreign intent-id conflict behind the normal in-flight response instead of introducing a new error shape, trading diagnostic specificity for removal of the cross-device existence oracle.
- Preserve pre-#406 enrollments as full/non-remembered for upgrade continuity; owners can subsequently narrow trust through the existing device controls.
- Correct the stale backup-status test discovered by the full suite because it asserted behavior the production route intentionally stopped providing before #417.
- Use the repository hygiene directive's narrow file-level waiver for 11 cohesive files rather than folding risky module decomposition into the protocol-hardening change; five inherited files receive only that documentation comment.

## Verification

```sh
bun run check
bun run typecheck
bunx turbo run test --concurrency=1
bun --cwd packages/gateway run test
bun --cwd packages/blueprints run test
bunx playwright test -c apps/web/tests/e2e/playwright.config.ts apps/web/tests/e2e/web-pwa-cache.spec.ts
git diff --check
```

- `bun run format`
- `git diff --check`
- `bun run check` — formatting and lint passed.
- `bun run typecheck` — 26/26 Turbo tasks passed.
- `bunx turbo run test --concurrency=1` — all changed-package suites passed; the only failure was the stale backup-status expectation above, corrected afterward.
- `bun run test` in `packages/gateway` — 91 files / 674 passed / 2 skipped after correcting that assertion.
- `bunx vitest run src/serve/serve.test.ts` — 18/18 passed in isolation.
- `bun run test` in `packages/blueprints` — 23 files / 163 tests passed in isolation; the default all-package fan-out can starve its existing 5-second jsdom/PDF tests, so the repository graph was verified sequentially.
- Focused Vitest suites across vault gateway/change-log/extensions, client coordinator/query/shell admission, gateway pairing/device/replica routes, app-engine bridge, and blueprint kit/boot harness.
- `bunx playwright test -c tests/e2e/playwright.config.ts tests/e2e/web-pwa-cache.spec.ts` — 10 passed.
- `bunx playwright test -c tests/e2e/playwright.config.ts tests/e2e/perf-waterfall.spec.ts --grep "sw tunnel cache"` — 1 passed; warm relay body bytes dropped from 12,288 to 0 while both authorization checks remained live.

## Audit

Fresh-context audit against the full amended diff and GitHub issue #417:

- **A1 — `## What changed` faithfully describes the diff:** PASS — The receipt accounts for every material change across vault invocation identity and replay, intent ownership and settlement, replica trigger/epoch repair, client admission/feed/query recovery, gateway trust and bounded routes, service-worker ownership/cache isolation, bridge fallback, Agenda/kit behavior, the stale backup assertion, and their regression coverage. It also names all 11 files carrying the directive-prescribed first-line file-size waiver, accurately states that six already participate in #417 implementation/test changes, and that the other five (`packages/blueprints/apps/agenda/app.jsx`, `packages/client/src/replica/sqlite-store.ts`, its test, `packages/vault/src/blob/blob.test.ts`, and `packages/vault/src/replica/invocation-commits.ts`) change only by that governance comment. Each waiver has a concrete cohesion/decomposition reason scoped to #417.
- **A2 — every checked item is realized:** PASS — All 15 checked claims have implementation and regression evidence across the vault invocation/trigger paths, client intent/feed/session paths, gateway trust/replica routes, service-worker tunnel, bridge fallback, Agenda and kit UX, and unit/browser/performance tests. The 11 file-size waivers alter no runtime or test behavior and do not weaken the realization of any checked item.
- **A3 — `## Checklist` mirrors the issue:** PASS — The checklist covers H1–H4, M1–M9, every actionable LOW / hardening finding (including the distinct kit swallow-first stale-over-fresh race), and the focused regression requirement, while explicitly deferring only the issue's three protocol-choice observations in `## Out of scope`. The file-size waivers are a disclosed governance-compliance decision, not additional issue scope requiring a checklist item.

## Steering

Fresh-context audit of Codex session `019f694d-b5c6-7d92-ab1b-862482aeb735`:

- **B1 — every human-steering event is recorded:** PASS — The 1,447-record transcript contains the initial issue #417 task request and no later human user message, explicit interrupt marker, correction, or redirect. The initial request is excluded by the directive, so no steering ledger row is required.
- **B2 — no non-steering message is recorded as steering:** PASS — No steering rows are present, correctly excluding the initial task, ordinary agent/tool traffic, approvals, and generated transcript context.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019f694d-b5c-1784182237-1 | codex | 019f694d-b5c6-7d92-ab1b-862482aeb735 | #417 | gpt-5.6-sol | 978165 | 0 | 44014848 | 92981 | 1071146 | 14.8438 | 978165 | 0 | 44014848 | 92981 | fix(replica): harden idempotency and settlement seams (#417) |
| codex-019f694d-b5c-1784182805-1 | codex | 019f694d-b5c6-7d92-ab1b-862482aeb735 | #417 | gpt-5.6-sol | 84967 | 0 | 2681344 | 7797 | 92764 | 0.9997 | 1063132 | 0 | 46696192 | 100778 | fix(replica): harden idempotency and settlement seams (#417) |
| codex-019f694d-b5c-1784183102-1 | codex | 019f694d-b5c6-7d92-ab1b-862482aeb735 | #417 | gpt-5.6-sol | 63736 | 0 | 1051392 | 4883 | 68619 | 0.4954 | 1126868 | 0 | 47747584 | 105661 | fix(replica): harden idempotency and settlement seams (#417) |
