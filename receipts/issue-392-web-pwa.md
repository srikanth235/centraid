# issue-392 — first-class web PWA client
<!-- governance: allow-receipt-per-issue this cross-package relocation has 387 paths; the receipt documents the reviewed logical surface rather than repeating every moved file -->
<!-- governance: allow-agent-steering-accounting fresh-context steering audit is unavailable because the active runtime prohibits delegation -->

## Checklist

- [x] Extract the browser-safe gateway client and shared React UI into `packages/client`.
- [x] Keep desktop functional through its host adapter.
- [x] Add an installable React/Vite PWA under `apps/web`.
- [x] Add browser pairing and revocable, vault-scoped sessions.
- [x] Add ticket-only, relay-only Iroh/WASM pairing and data transport.
- [x] Isolate generated apps from the trusted shell and scope their sessions per app.
- [x] Provide browser-safe fallbacks for native-only desktop capabilities.
- [x] Add meaningful unit, gateway integration, and Playwright browser E2E coverage.
- [x] Update architecture, README, and testing documentation.
- [x] Run build, tests, typecheck, focused lint, governance, and browser E2E verification.

## What changed

- Moved the desktop renderer's browser-safe client and React shell into
  `@centraid/client`; Electron and the PWA now compile the same UI source.
- Added `@centraid/web`, including its manifest, service worker, install prompt,
  offline notice, browser settings/pairing adapter, and production static host.
- Added an application-specific Rust/WASM Iroh endpoint with a durable browser
  identity, ticket redemption, streaming HTTP-over-bi-stream requests, and a
  service-worker bridge for generated-app documents and subresources.
- Added Origin-bound HttpOnly shell control sessions and one-time, vault/app-
  scoped generated-app launch sessions. The runtime strips forged scope headers,
  applies frame CSP, follows virtual Iroh redirects without losing app asset/theme
  context, permits only the app's blob custody route for uploads, and refuses
  cross-app or shell/admin access.
- Bundled the PWA with `centraid-gateway` and exposed its dedicated URL from the
  daemon while keeping generated apps on the API origin.
- Added client/web unit tests, gateway/session integration tests, static-host
  tests, and a real Chromium production journey through preview, publish, live
  launch, SDK execution, service worker, and confinement checks.

## Out of scope

- Running the gateway, SQLite, agents, or automation workers inside the browser.
- Caching vault data, authenticated API responses, generated apps, or SSE streams for offline use.
- Replacing the native mobile client or its iroh transport.

## Decisions

- Kept one `@centraid/client` package with a `src/react` UI subtree instead of
  splitting a second shell package; desktop and web differ only at the host adapter.
- Kept direct-HTTP generated apps on a distinct gateway origin. Iroh app loads
  use a virtual PWA route because service workers cannot control another origin;
  the bridge keeps the opaque app cookie out of generated-app JavaScript and the
  tunnel omits its broad bearer so gateway app-session route scoping still applies.
- Cached only public shell assets. Vault/API responses, SSE, and generated apps are
  deliberately online-only and show an explicit reconnect state when offline.
- Chose relay-only browser Iroh as the ticket-only default. Direct URL pairing
  remains the compatibility fallback; the one-time ticket secret is never persisted.

## Verification

```sh
bun run build
bun run --cwd apps/web build:iroh
bun run typecheck
bunx turbo run test --concurrency=1
bun run --cwd apps/web e2e
bun run format:check
bunx oxlint apps/web packages/client/src/gateway-client-core.ts packages/client/src/gateway-client.ts packages/client/src/gateway-client-editing.ts packages/client/src/centraid-api.d.ts packages/app-engine/src/http/http-server.ts packages/app-engine/src/http/security.ts packages/app-engine/src/http/static-server.ts packages/app-engine/src/runtime.ts packages/gateway/src/serve/web-app-sessions.ts packages/gateway/src/serve/web-ui-server.ts packages/gateway/src/serve/build-gateway.ts packages/gateway/src/serve/serve.ts packages/gateway/src/cli/cli.ts
.governance/run.sh
```

Build, typecheck, serialized repository tests, browser E2E, and focused lint pass.
The root format/lint gate has pre-existing failures outside this change (47
unformatted files and legacy lint findings). Governance passes all changed surfaces
and still reports three baseline repository violations: historical token accounting,
issue 354's receipt crosswalk, and the existing oversized `turn-routes.test.ts`.

## Audit

REFUTED — a fresh-context sub-agent audit was not run because the active execution
environment explicitly prohibits delegation. The diff, checklist, and verification
were reviewed in the primary agent context before PR creation.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-32b1005d-19c-1783943674-1 | claude-code | 32b1005d-19c8-430d-bc41-840babc3d08f | #392 | claude-opus-4-8 | 57488 | 2932551 | 77049713 | 493549 | 3483588 | 69.4795 | 57488 | 2932551 | 77049713 | 493549 |  |
