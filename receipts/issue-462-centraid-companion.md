# Issue #462 — Centraid Companion browser extension

GitHub issue: [#462](https://github.com/srikanth235/centraid/issues/462)

## Checklist

- [x] X1 — Worker transport port
- [x] X2 — Origin-matching spec
- [x] X3 — Pairing UX
- [x] X4 — Extension grant profile + consent surfaces
- [x] X5 — Locker module
- [x] X6 — Capture modules
- [x] X7 — Transport hardening
- [x] X8 — Store shipping

## What changed

- **X1 — Worker transport port:** added the packaged MV3 Centraid Companion under
  `apps/extension`, with direct service-worker initialization of the committed
  iroh WASM binding, `chrome.storage` device identity, pooled HTTP-over-iroh,
  gzip handling, bounded retry classification, tab/form warming, an honest UX
  lock, and no offline Locker secret cache or native/loopback dependency.
- **X2 — Origin-matching spec:** added a normative Public Suffix List contract,
  exact-host override, HTTPS/public-host and loopback rules, fail-closed behavior,
  and 20 executable cross-origin, suffix-confusion, port, IDNA, and invalid-URL
  vectors. Locker storage, actions, blueprint UI, and query results now carry the
  versioned policy.
- **X3 — Pairing UX:** added QR rendering to Settings → Devices, camera/paste
  pairing in the extension, real `centraid/gw-pair/1` WASM redemption, persisted
  enrollment labels/grants, self-scoped server revocation before local unpair
  purge, and remote-revocation purge on the next authenticated request.
- **X4 — Extension grant profile + consent surfaces:** pairing now requires a
  selected module capability profile for extension devices. The gateway persists
  and server-enforces each module's pinned action/query bundle, derives module
  health from the exact owner-granted scope and verb, strips forged internal grant
  headers, keeps legacy devices unrestricted when the profile is absent, filters
  existing app/blocking responses for Companion, and exposes grant chips, module
  states (including locked/offline pause), a one-line blocking approval count,
  parked approval counts, and accurately classified recent activity.
- **X5 — Locker module:** added top-frame-only login-form detection, explicit
  browser-trusted suggestion/fill/save/generation gestures, origin revalidation
  in the worker, immediate clearing of mutable secret-message references after
  use, password and derivative-only TOTP fill, client-side generation feeding
  directly into the manual save journey, save-on-login, secret-free Watchtower
  metadata, per-fill reveal context
  receipts, and owner review activity without journaling secret values.
- **X6 — Capture modules:** added current-page Tasks capture, Notes selection
  clipping, staged Docs visible-tab screenshots with the exact source URL,
  confirm-before-write
  Agenda quick-add, and manual-only People capture through existing typed
  blueprint actions and `centraid_read`/`centraid_write`—no extension-specific
  application API.
- **X7 — Transport hardening:** added configurable browser relay URLs with a
  documented operations owner, stable connect/revocation markers with a pinning
  test, authoritative QUIC revocation detection, a cross-platform pinned WASM
  generator, regenerated bindings, and rebuild-and-diff CI.
- **X8 — Store shipping:** added Chrome and Firefox MV3 manifests, correctly
  sized package icons, CSP/permission/privacy/listing material, source-map-free
  ZIP packaging, pinned release CI, and a real-browser Chrome acceptance workflow
  covering remote pair, password+TOTP fill budgets, receipt arrival, and revoke.
  Chrome is the v1 store target; the Firefox package remains explicitly gated on
  the live release-checklist test, and Safari remains unsupported.

Changed paths covered by this receipt:

```text
.github/workflows/extension-e2e.yml
.github/workflows/extension-release.yml
.github/workflows/iroh-wasm.yml
ARCHITECTURE.md
README.md
apps/extension/.gitignore
apps/extension/README.md
apps/extension/package.json
apps/extension/scripts/build.mjs
apps/extension/scripts/package.mjs
apps/extension/spec/origin-matching-v1.json
apps/extension/src/chrome.d.ts
apps/extension/src/capture.test.ts
apps/extension/src/capture.ts
apps/extension/src/companion-api.ts
apps/extension/src/companion-api.test.ts
apps/extension/src/content.ts
apps/extension/src/credential-gesture.test.ts
apps/extension/src/credential-gesture.ts
apps/extension/src/origin-matching.test.ts
apps/extension/src/origin-matching.ts
apps/extension/src/page-fields.test.ts
apps/extension/src/page-fields.ts
apps/extension/src/pair.ts
apps/extension/src/popup.ts
apps/extension/src/popup-state.test.ts
apps/extension/src/popup-state.ts
apps/extension/src/storage.ts
apps/extension/src/ticket.ts
apps/extension/src/transport.ts
apps/extension/src/types.ts
apps/extension/src/worker.ts
apps/extension/static/manifest.chrome.json
apps/extension/static/manifest.firefox.json
apps/extension/static/pair.html
apps/extension/static/popup.css
apps/extension/static/popup.html
apps/extension/store/chrome-listing.md
apps/extension/store/permission-justifications.md
apps/extension/store/privacy-policy.md
apps/extension/store/release-checklist.md
apps/extension/tsconfig.json
apps/extension/vitest.config.ts
apps/web/iroh-wasm/RELAY-POLICY.md
apps/web/iroh-wasm/rust-toolchain.toml
apps/web/iroh-wasm/src/lib.rs
apps/web/scripts/build-iroh-wasm.sh
apps/web/src/generated/centraid_web_iroh.d.ts
apps/web/src/generated/centraid_web_iroh.js
apps/web/src/generated/centraid_web_iroh_bg.wasm
apps/web/src/generated/centraid_web_iroh_bg.wasm.d.ts
apps/web/src/iroh-transport.ts
bun.lock
docs/security/locker-origin-matching.md
knip.json
packages/app-engine/src/http/http-server.ts
packages/app-engine/src/http/internal-headers.test.ts
packages/app-engine/src/http/internal-headers.ts
packages/app-engine/src/index.ts
packages/app-engine/src/runtime.ts
packages/blueprints/apps/locker/actions/add-item.ts
packages/blueprints/apps/locker/actions/edit-item.ts
packages/blueprints/apps/locker/app.json
packages/blueprints/apps/locker/app.tsx
packages/blueprints/apps/locker/components/EditModal.module.css
packages/blueprints/apps/locker/components/EditModal.tsx
packages/blueprints/apps/locker/logic.ts
packages/blueprints/apps/locker/queries/autofill-candidates.ts
packages/blueprints/apps/locker/queries/autofill-item.ts
packages/blueprints/apps/locker/queries/item.ts
packages/blueprints/apps/locker/queries/origin-matching.ts
packages/blueprints/apps/locker/types.ts
packages/blueprints/manifest.json
packages/blueprints/package.json
packages/blueprints/scripts/vendor-browser-shared.mjs
packages/blueprints/src/query-handlers.test.ts
packages/client/package.json
packages/client/src/gateway-client-devices.ts
packages/client/src/gateway-client-outbox.ts
packages/client/src/react/screens/ApprovalsScreen.test.tsx
packages/client/src/react/screens/ApprovalsScreen.tsx
packages/client/src/react/screens/DevicePairPanel.tsx
packages/client/src/react/screens/DevicesCard.module.css
packages/client/src/react/screens/DevicesCard.test.tsx
packages/client/src/react/screens/DevicesCard.tsx
packages/client/src/react/shell/routes/ApprovalsRoute.test.tsx
packages/client/src/react/shell/routes/ApprovalsRoute.tsx
packages/client/src/react/shell/routes/approvalsData.test.ts
packages/client/src/react/shell/routes/approvalsData.ts
packages/gateway/src/cli/endpoint-host.ts
packages/gateway/src/routes/devices-routes.test.ts
packages/gateway/src/routes/devices-routes.ts
packages/gateway/src/routes/companion-grants.test.ts
packages/gateway/src/routes/companion-grants.ts
packages/gateway/src/routes/pair-routes.ts
packages/gateway/src/routes/vault-routes.ts
packages/gateway/src/serve/build-gateway.ts
packages/gateway/src/serve/companion-access.test.ts
packages/gateway/src/serve/companion-access.ts
packages/gateway/src/serve/device-plane.test.ts
packages/gateway/src/serve/enrollment-store.ts
packages/gateway/src/serve/outbox-executor.test.ts
packages/gateway/src/serve/serve-device-tokens.test.ts
packages/gateway/src/serve/vault-context.ts
packages/gateway/src/serve/vault-plane.ts
packages/tunnel/src/gateway-endpoint.ts
packages/vault/src/commands/locker.test.ts
packages/vault/src/commands/locker.ts
packages/vault/src/gateway/gateway.ts
packages/vault/src/gateway/sealed.test.ts
packages/vault/src/gateway/types.ts
packages/vault/src/schema/domains-locker.ts
tests/agent-e2e-pairing/README.md
tests/agent-e2e-pairing/flows/extension-companion.md
tests/agent-e2e-pairing/flows/extension-companion.mjs
vitest.config.ts
```

## Decisions

- The extension device secret persists in `chrome.storage.local` so browser
  restart does not silently force re-pairing. “Lock” is documented as a UX
  tunnel/session drop, not encryption or a master-password boundary; unpair and
  remote revoke delete the local identity.
- The extension grant profile is a server-owned module-to-operation capability
  map layered over each blueprint's exact owner-granted scope/verb. An absent
  profile preserves all legacy paired-device behavior; an extension pairing
  without a profile is rejected.
- Companion status uses filtered representations of the existing `/apps` and
  `/blocking` routes. No extension application endpoint or new gateway route was
  added.
- n0 remains the default blind relay. The override seam and operating ownership
  are shipped, but provisioning a Centraid-operated relay is an infrastructure
  decision rather than a code prerequisite.

## Out of scope

- Same-machine loopback/native messaging, offline secret caching, multi-vault
  switching, Safari, Tally/Photos modules, full-page article extraction, and
  automatic contact harvesting remain out exactly as specified in #462.
- Actual Chrome Web Store submission and owner-operated relay provisioning are
  external release/operations actions. The repository now emits the review ZIP,
  listing, privacy policy, permission justifications, and release checklist.
- Public Firefox support is not claimed until the generated Firefox package
  passes its manual live pair/fill release gate.

## PR #463 review follow-ups

### Bugs fixed
- **Loopback false-positive:** `isLoopback` now parses real IPv4 and requires
  `127.0.0.0/8` (plus exact `localhost` / `::1`). Vectors cover
  `http://127.0.0.1.evil.test` and `127.foo.bar` as ineligible / non-matching.
- **SPA stale fields:** content-script fill/save/generate re-call `findFields()`
  at gesture time and only write into still-connected visible inputs
  (`page-fields.ts` + unit tests).

### High-value suggestions addressed
- **Server-side origin re-check** on `autofill-item` before reveal (shared rules
  in `queries/origin-matching.ts`).
- **Closed shadow** for Locker menu chrome.
- **Watchtower badge clear** when candidates are warning-free.
- **grantProfile clear** when re-enrolling the same endpoint as non-extension.
- **WASM CI:** pin rustc via crate-local `rust-toolchain.toml`, pin binaryen,
  invoke build via `bash`; rebuild success is the gate and binding drift is a
  non-blocking warning until hermetic byte-exact rebuild is real.
- **vendor-browser-shared:** resolve `@centraid/blob-format` from TS sources so
  pure-local CI does not require a prebuilt `dist/`.
- **Companion grant denial shape:** assertions use `error: 'app_session_scope'`
  (sendError wire shape), not `code`.
- **Companion e2e:** live n0-relay job is schedule/workflow_dispatch only; PRs
  get pure-local `companion-static` (extension build/test + locker
  `query-handlers` only — full blueprints app-boot is out of scope for this gate).

### Deferred nits (with rationale)
- **Ticket decoder unification / relays field:** non-blocking; gateway still
  enforces v=1 on redeem. Shared schema deferred to a follow-up (#462 X7a-class).
- **warmTab debounce:** deferred; no security issue, battery/timing only.
- **COMPANION_MODULES single source:** deferred sync cleanup; current three
  package lists match for v1 modules.
- **add_item url_match_policy for non-login:** deferred consistency nit;
  edit_item already rejects login-only field.
- **vault.db recreate note:** intentional under v0 no-migrations — recreate
  local `vault.db` after pull if schema errors appear on `url_match_policy`.
- **Password modulo bias:** fixed in the same pass (rejection sampling).

## Verification

Reproducible primary commands:

```sh
bun run --filter @centraid/extension test
bun run --filter @centraid/extension typecheck
bun run --filter @centraid/extension package
bun run --filter @centraid/app-engine test -- src/http/internal-headers.test.ts
bun run --filter @centraid/blueprints test -- src/query-handlers.test.ts
bun run --filter @centraid/vault test -- src/commands/locker.test.ts src/gateway/sealed.test.ts
bun run --filter @centraid/client test -- src/react/screens/ApprovalsScreen.test.tsx src/react/screens/DevicesCard.test.tsx src/react/shell/routes/ApprovalsRoute.test.tsx src/react/shell/routes/approvalsData.test.ts
bun run --filter @centraid/gateway test -- src/serve/outbox-executor.test.ts -t "blocking lists"
bun run --filter @centraid/gateway test -- src/routes/companion-grants.test.ts
bun run --filter @centraid/gateway test -- src/serve/companion-access.test.ts
bun run --filter @centraid/web build:iroh
cargo test --manifest-path apps/web/iroh-wasm/Cargo.toml --lib
bunx turbo run typecheck --filter=!@centraid/data-plane
bunx turbo run lint --filter=!@centraid/data-plane
bun run lint:types
bun run lint:css
bun run format:check
git diff --check
```

Results: extension origin/security/provenance/popup/unpair tests **31/31**, app-engine
capability-policy tests **2/2**, gateway grant/self-revoke policy tests **5/5**, blueprint
queries **9/9**, Locker/vault **27/27**, client approvals/devices **47/47**,
focused gateway review **1/1**, and Iroh marker/legacy-pairing tests **2/2** passed. Extension
typecheck/package, Iroh-WASM rebuild, all 29 non-data-
plane Turbo typecheck/build tasks, all non-data-plane package lint tasks, type
surface lint, CSS class lint, formatting, and diff hygiene passed. Earlier
focused device-store and device-route suites passed **25/25** before the final
route-shape refinement; gateway and extension typechecks were re-run afterward.

Two local gates require capabilities denied to this workspace sandbox: the
gateway's loopback integration suite exits at `listen EPERM: operation not
permitted 127.0.0.1`, and the root Rust data-plane lint/typecheck reaches native
crypto compilation but `clang` cannot create its temporary objects. The
non-Rust workspace gates pass, the Iroh wasm32 crate rebuild passes, and the
committed Ubuntu CI workflows run the native and real-browser acceptance paths.

## Audit

PASS — fresh-context audit verified the complete issue #462 diff, including
server-enforced Companion capabilities, trusted credential gestures, generated
password save flow, paused/count popup states, and self-scoped unpair with
retry-safe failure handling and post-response transport revocation.

## Steering

PASS — no qualifying mid-task user correction or interruption occurred; no
steering accounting row is required.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019f78e0-324-1784447752-1 | codex | 019f78e0-3248-7b01-af7c-4d4f130c1e1f | #462 | gpt-5.6-sol | 1456964 | 0 | 77781248 | 195159 | 1652123 | 26.0151 | 1456964 | 0 | 77781248 | 195159 | feat(extension): ship Centraid Companion (#462) -m governance: allow-toolchain-c |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
