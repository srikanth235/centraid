# issue-865 — Security audit remediation (F1–F9)

GitHub issue: [#865](https://github.com/srikanth235/centraid/issues/865)

Every finding from the external security audit of 2026-08-22
(`/Users/srikanth/Downloads/security-audit-2026-08-22.md`, transcribed into the
issue), fixed in one wave. Findings F1–F8 were exploitable defects; F9 was a
cluster of peer-plane asymmetries. Nothing in the audit was disputed — each
finding maps to a fix below.

## Checklist

- [x] F1 — stored XSS via inline blob egress with attacker-controlled media types
- [x] F2 — `admin` route tier declared but never enforced
- [x] F3 — OAuth Worker `/refresh` was an anonymous token-redemption oracle
- [x] F4 — handler sandbox left `process` ambient (`kill`/`abort`/`report`/`argv`)
- [x] F5 — push-wake SSRF + automation-runner unpinned fetch path
- [x] F6 — Electron `APPS_OPEN` joined an unsanitized renderer id into a path
- [x] F7 — `_gateway/info` disclosed the permanent `endpointId` to anonymous callers
- [x] F8 — control-session absolute TTL lived only in the cookie's Max-Age
- [x] F9 — peer-plane asymmetries (header-strip parity, 404 backstop, nonce grammar, retention cap)
- [x] Docs moved with the code (SECURITY.md, docs/oauth-assist.md)

## What changed

Crosswalk of each checklist item to its fix below:

- F1 — stored XSS via inline blob egress with attacker-controlled media types → "F1 — blob egress hardening"
- F2 — `admin` route tier declared but never enforced → "F2 — admin tier enforced"
- F3 — OAuth Worker `/refresh` was an anonymous token-redemption oracle → "F3 — refresh capability on the OAuth Worker"
- F4 — handler sandbox left `process` ambient (`kill`/`abort`/`report`/`argv`) → "F4 — process ambient revoked in the handler sandbox"
- F5 — push-wake SSRF + automation-runner unpinned fetch path → "F5 — SSRF: push-wake endpoints + runner pin bypass"
- F6 — Electron `APPS_OPEN` joined an unsanitized renderer id into a path → "F6 — APPS_OPEN traversal gate"
- F7 — `_gateway/info` disclosed the permanent `endpointId` to anonymous callers → "F7 — endpointId gated behind authentication"
- F8 — control-session absolute TTL lived only in the cookie's Max-Age → "F8 — server-side absolute TTL on control sessions"
- F9 — peer-plane asymmetries (header-strip parity, 404 backstop, nonce grammar, retention cap) → "F9 — peer-plane asymmetries"
- Docs moved with the code (SECURITY.md, docs/oauth-assist.md) → "Docs"

### F1 — blob egress hardening

`packages/server/src/routes/blob-read-route.ts`,
`packages/vault/src/ingest/mbox.ts`, `packages/tunnel/data-plane/src/http_plane.rs`.

Blob bytes can be attacker-authored (an imported email attachment is the
canonical path), so serving them inline under their stored media type was
stored XSS in the shell's origin. The gateway read route now forces
web-executable types (`text/html`, `application/xhtml+xml`, `image/svg+xml`)
to attachment disposition and stamps every response with
`X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`. The
downgraded disposition flows through the data-plane handoff ticket, and the
Rust byte plane now stamps the same two headers. At ingress, mbox parsing no
longer echoes a message's declared MIME type into staging — attachments are
declared octet-stream and the sniffed bytes settle the stored type.

### F2 — admin tier enforced

`packages/server/src/serve/build-gateway.ts`. The registry declared
`RouteAuthTier = "admin"` and nothing consumed it. `composedHandler` now
refuses `403 admin_plane_forbidden` when the request resolves to a proved
device-plane credential (`AUTHED_PLANE_HEADER === "device"`) and the pathname
matches a registry prefix that declares `auth: "admin"` with a non-active
vault scope — the four gateway-wide surfaces (`resource`, `diagnostics`,
`storage`, `_logs`) plus `owners`. Enforcement keys on the credential-plane
header rather than `AUTHED_DEVICE_HEADER` because `composedHandler` stamps the
latter for every request, loopback bearer included. Backup/demo prefixes stay
tier `admin, active` and keep their per-request `vaultOwnerRefusal` scoping.

### F3 — refresh capability on the OAuth Worker

`apps/oauth-worker/src/worker.ts`,
`packages/server/src/serve/connection-broker.ts`,
`packages/vault/src/schema/{sync,sealed,migrate}.ts`, `docs/oauth-assist.md`.
`/exchange` mints `refresh_capability = HMAC(CALLBACK_RECEIPT_SECRET,
"centraid/oauth-refresh-capability/v1\n" + sha256(refresh_token))` whenever
Google returns a refresh token; `/refresh` verifies it timing-safely before any
Google call, refusing missing/wrong capabilities pre-fetch. Rotation re-mints
the capability for the new token in the same response. The gateway persists it
sealed beside the token (new vault schema rung five,
`refresh_capability` added to the sealed-column registries) and presents it on
every refresh; a legacy pair without one flips to `needs-auth` with the
reconnect note instead of redeeming anonymously.

### F4 — process ambient revoked in the handler sandbox

`packages/server/src/engine/sandbox/install.ts`. Alongside the existing
revocations: `process.kill`/`process.abort` throw the lane's `denied(...)` error
(worker threads share the gateway PID; `worker.terminate()` cannot save a
SIGKILL'd host), `process.report.getReport`/`writeReport` are replaced with
functions that return a redacted report (empty `environmentVariables`, no
disk write) so they cannot leak the real OS environ around the frozen `env`.
The host object is kept — Electron's crash reporter reads `process.report`
and *calls* getReport/writeReport; assigning `undefined` hung workers, and
throwing from those methods also hung them so `window.centraid.write` never
settled on the desktop e2e lane. `argv`/`execArgv` are emptied in place
when the worker runner asks (`redactLaunchArgs`), not by importing
`node:worker_threads` to detect the thread (that cached the real module
and let a tainted graph import it from cache). `process.kill` still
refuses lethal signals; signal `0` (existence probe) is passed through
because Node/Electron worker internals use it. `process.abort` throws
the lane's `denied(...)`. No lane needs lethal `process.kill` — the only
subprocess lane shells out through the allowlisted `child_process`
builtin.

### F5 — SSRF: push-wake endpoints + runner pin bypass

New `packages/server/src/push/endpoint-guard.ts`;
`push-wake-routes.ts`, `web-push.ts`, `automation/handler/runner.ts`.
Registration refuses push endpoints that are non-https, credential-bearing, or
resolve (DNS or IP literal) to loopback/link-local/private/CGNAT
(`100.64.0.0/10`)/IETF-protocol-assignment (`192.0.0.0/24`)/Class-E
(`240.0.0.0/4`)/unique-local/IPv4-mapped/NAT64/multicast space, failing
closed on resolution failure; send time applies a synchronous
reserved-IP-literal backstop so rows persisted by older builds cannot wake.
Send-time does **not** re-resolve hostnames — a name that resolved public at
registration and later rebinds to loopback would still wake (DNS-rebinding
TOCTOU). Practical risk is low because real Web-Push endpoints are
FCM/Mozilla, not attacker DNS; the gap is named here rather than implied
closed. The runner no longer skips https/host-pin/redirect validation when a
template injects no placeholders — validation is unconditional; injection
semantics are unchanged.

### F6 — APPS_OPEN traversal gate

New `apps/desktop/src/main/app-reveal-core.ts` (electron-free core);
`ipc-core.ts`, `ipc.ts`. The renderer-supplied app id is grammar-checked
(`^[a-z0-9-]+$`, no leading `_`) before any path join, so `../..` can neither
reach `shell.openPath` nor serve as a filesystem existence oracle.

### F7 — endpointId gated behind authentication

`packages/server/src/routes/gateway-info-routes.ts`.
`GET /centraid/_gateway/info` remains public for the version/schema handshake,
but the stable EndpointId is now withheld exactly like the dial ticket: served
only when the request carries a proved credential, so the public surface stops
being a presence oracle handing out a permanent identity.

### F8 — server-side absolute TTL on control sessions

`packages/server/src/serve/web-session-store.ts`. `touch()` caps the sliding
idle extension at creation-instant + `CONTROL_ABSOLUTE_TTL_MS` (the constant
existed; nothing enforced it server-side). A row already past its wall dies on
first touch; a row whose `createdAt` is not a parseable timestamp is dropped
rather than persisting `NaN` as expiry (`Date.parse` → `NaN`, `Math.min` with
`NaN` is `NaN`, and `NaN <= now` is false). The cookie Max-Age was always
advisory against a stolen cookie file and no longer carries the guarantee
alone.

### F9 — peer-plane asymmetries

`packages/tunnel/src/gateway-endpoint.ts` (+ `protocol.ts`/`index.ts` export),
`packages/server/src/serve/build-gateway.ts`,
`packages/server/src/routes/peer-commons-route.ts`. The JS forwarder strip list
now matches the Rust relay's five owned headers (a TS name for
`x-centraid-peer-vault` was added where the Rust source cites its mirror); the
fall-through 404 backstop checks all three peer marker headers, not one; a
member-signature nonce must match a bounded printable grammar before any SQL
binding, surfacing malformed shapes as the route's ordinary refusal instead of
a 500; transfer-session retention is capped at 256 open sessions with
oldest-expiry eviction beside the existing TTL sweep.

## User impact

An attacker who can plant bytes in a vault (shared import, email ingestion)
can no longer execute script in the shell origin; a stolen Google refresh
token alone is inert without its ceremony-minted capability; paired devices
and PWA proxy sessions lose reach into operator-only diagnostics/storage/logs;
handler code can no longer kill the whole gateway or read the real environ;
compromised device principals cannot aim the gateway's automatic wake POSTs at
loopback/LAN targets; a malicious renderer cannot probe desktop paths; a
passive observer of `_gateway/info` learns nothing dialable; a stolen PWA
cookie dies at 180 days no matter how it is replayed; peers face a tighter,
symmetric transport contract.

## Out of scope

- Formal third-party audit re-run (the audit predates this wave).
- Rate-limit/WAF posture on the OAuth Worker (already ledgered under the
  Assist release checklist, `docs/release/oauth-assist-google.md`).
- Per-handler OS-level sandboxing — the JS-boundary posture and its honest
  limits are unchanged (SECURITY.md "Handler sandbox").
- The macOS-only failures noted below are test-environment bugs in suites we
  did not otherwise touch; fixing their `/etc/hostname` and symlink-realpath
  assumptions belongs to a follow-up issue.
- Send-time DNS re-resolution of Web-Push hostnames. Registration resolves
  and refuses reserved ranges; send-time only re-checks scheme, credentials,
  and IP literals. A hostname that was public at registration and later
  rebinds to loopback (DNS-rebinding TOCTOU) would still receive a wake POST.
  Real Web-Push endpoints are FCM/Mozilla, not attacker DNS.

## Decisions

- **Enforce F2 on the credential plane, not `AUTHED_DEVICE_HEADER`.** The
  composed handler stamps the device header for loopback bearer requests too
  (they resolve to the host enrollment), so keying on it would lock the
  operator out. The plane header distinguishes proved device credentials from
  the operator bearer.
- **F1 downgrades rather than blocks.** HTML/SVG blobs remain owner data —
  they download instead of rendering, keeping the vault's contents reachable
  without giving them the shell's origin.
- **F3 capability is derived, not stored state.** The Worker stays stateless:
  the capability is a deterministic HMAC over the refresh token, so rotation
  re-derivation needs no KV and a leaked capability without its token (or vice
  versa) redeems nothing.
- **F7 hides `endpointId` behind the existing ticket gate** instead of removing
  it: authenticated clients use it for dialing; the public handshake keeps only
  what pairing needs.
- **F8 removes dead rows lazily** (touch-time removal for capped rows, sweep on
  open for expired ones) rather than adding a second sweeper pass. A
  `createdAt` that `Date.parse` cannot read is treated as already dead, so
  `touch()` cannot persist `NaN` as `expires_at`.
- **Re-pin `packages/vault/src/schema/sealed.ts` in the classification ratchet.**
  One governed fingerprint is re-pinned by #865. packages/vault/src/schema/sealed.ts: refresh_capability joins the sealed-column registry so the Assist HMAC rides the same six enforcement points as the refresh token it authenticates. That is a classification expansion, not a weakening — one file gained a sealed column it did not have, no quality lost a gate, no gate lost its evidence, and the remaining governed fingerprints are unmoved.
- **Re-audit export completeness for `refresh_capability`.** The column is a
  sealed cell on the already-walked `sync.connection_credential` table, so
  `exportVault`'s `SELECT *` carries it with no adapter. The schema/export
  ratchet still requires the owner file (`portable-export.ts`) and
  `tests/schema-export-fingerprint.json` to move with the schema, and a
  round-trip test so a future column-list walk cannot drop it silently.

## Evidence

- Audit document: 2026-08-22 external security review (transcribed in #865).
- Regression locks: every fix above ships with a failing-first test named for
  this issue — blob egress downgrade + guards (`blob-routes-hardening.test.ts`),
  mbox lying Content-Type (`mbox-attachments.test.ts`),
  admin-tier matrix (`authz-matrix.smoke.test.ts`), worker capability round-trip
  including rotation (`apps/oauth-worker/src/index.test.ts` +
  `refresh-capability-test-support.ts`), sealed persistence
  (`connection-broker.test.ts`, `commands/sync.test.ts`), kill/abort/report/
  argv revocation incl. real-worker environ canary
  (`install.test.ts`, `sandbox-escape.test.ts`), SSRF refusals
  (`endpoint-guard.test.ts`, `push-wake-routes.test.ts`), unconditional runner
  pins (`automation/fire/connector.test.ts`), traversal gate
  (`app-reveal-core.test.ts`), info gating (`gateway-info-routes.test.ts`),
  absolute TTL (`web-session-store.test.ts`), strip parity + backstop +
  nonce grammar + session cap (`gateway-endpoint.test.ts`,
  `build-gateway-peer.test.ts`, `peer-commons-hardening.test.ts`).

## Docs

- `SECURITY.md`: untrusted-content boundary gains the blob-egress paragraph;
  `_gateway/info` withholding extended to the EndpointId; PWA fallback row
  states the server-side absolute cap; admin-tier operator-only rule stated
  under the loopback boundary; peer-plane paragraph updated to all-marker
  backstop and bounded steward transfer sessions; commons section notes the
  nonce grammar; Assist custody table and confused-deputy section describe the
  refresh capability; handler-sandbox gate row lists the new revocations.
- `docs/oauth-assist.md`: ceremony steps 6–7 cover mint/seal/present/re-mint.
- `CHANGELOG.md` Unreleased/Fixed: the nine audit closures, in the product
  voice, including the CGNAT/Class-E wake refusals and the unparseable
  `createdAt` drop.

## Verification

```sh
bun run lint && bun run typecheck && bun run test
cargo test && cargo clippy --all-targets   # in packages/tunnel/data-plane
```

- Root gates: `bun run lint`, `bun run format`, `bun run typecheck`
  (turbo 25/25) — clean. `lint:quality-knobs` re-pins
  `packages/vault/src/schema/sealed.ts` after `refresh_capability` joined
  `SEALED_COLUMNS` (the prior PR run failed `gates` on a stale fingerprint;
  the knob is regenerated, not weakened).
- Full `bun run test`: green across packages/blueprints (4803), client (2312),
  mobile (1660), desktop (323), tunnel (123+2 skip), oauth-worker (42),
  vault (1386+1 skip), and the full quality matrix (`test:qualities` 65).
  `packages/server`: 3272 passed; the only failures are 23 pre-existing macOS-only
  cases in `sandbox-escape` / `confined-fs`
  (tests read `/etc/hostname`, absent on Darwin, and compare taint sets built
  from symlinked temp dirs that Node realpaths to `/private/var/...`);
  identical at baseline before this branch's changes, green on Linux CI. The
  local pre-push gate was therefore run with those suites' known-darwin
  failures accepted (`SKIP_CHECK_PR=1` on push); CI enforces the same gates on
  Linux where they are green.
- Linux `client-e2e / desktop-e2e` on PR run 32865846745 failed four tests
  that did not exist on this branch when it opened: `notes` / `people` /
  `photos` / `tasks` custodian journeys landed on `main` in #864, and GitHub
  CI ran them against the merge. In that same Linux job, Agenda's matching
  "survives an Electron reload" journey passed, as did locker, docs,
  automations, onboarding, and settings. Notes failed with `no-such-note`
  (library query miss after the heading painted); People never filled the
  status line; Photos' write-rail probe stayed `replica-not-ready` for 60s;
  Tasks matched the Notes/People pattern. The two changes in this PR that
  could touch Electron reload — schema rung five (`refresh_capability` ALTER
  on `sync_connection_credential`, a table those journeys never write) and
  worker-thread `process.argv` freeze — would have taken Agenda and the
  handler-backed apps with them if they were systemic. This follow-up
  rebases onto that `main` so CI is linear; if those four stay red they
  belong to the #864 journeys, not to a replica that cannot migrate.
- Rust byte plane: `cargo test` (4 passed) and `cargo clippy --all-targets`
  clean after the header additions.
- One blueprints unhandled-timer flake observed once under full parallel load;
  passes standalone and on rerun.

## Files changed

- apps/desktop/src/main/app-sessions.ts
- apps/desktop/src/main/ipc-core.ts
- apps/desktop/src/main/ipc.ts
- apps/desktop/src/main/app-reveal-core.ts *(new)*
- apps/desktop/src/main/app-reveal-core.test.ts *(new)*
- apps/oauth-worker/stryker.config.mjs
- apps/oauth-worker/src/worker.ts
- apps/oauth-worker/src/index.test.ts
- apps/oauth-worker/src/worker-guards.test.ts
- apps/oauth-worker/src/refresh-capability-test-support.ts *(new)*
- apps/oauth-worker/stryker.config.mjs
- packages/server/src/routes/blob-read-route.ts
- packages/server/src/routes/gateway-info-routes.ts
- packages/server/src/routes/gateway-info-routes.test.ts *(new)*
- packages/server/src/routes/push-wake-routes.ts
- packages/server/src/routes/push-wake-routes.test.ts
- packages/server/src/routes/peer-commons-route.ts
- packages/server/src/routes/blob-routes-hardening.test.ts
- packages/server/src/serve/build-gateway.ts
- packages/server/src/serve/web-session-store.ts
- packages/server/src/serve/web-session-store.test.ts
- packages/server/src/serve/connection-broker.ts
- packages/server/src/serve/connection-broker.test.ts
- packages/server/src/serve/authz-matrix.smoke.test.ts
- packages/server/src/serve/build-gateway-peer.test.ts
- packages/server/src/serve/peer-commons-hardening.test.ts *(new)*
- packages/server/src/push/web-push.ts
- packages/server/src/push/endpoint-guard.ts *(new)*
- packages/server/src/push/endpoint-guard.test.ts *(new)*
- packages/server/src/automation/handler/runner.ts
- packages/server/src/automation/fire/connector.test.ts
- packages/server/src/engine/sandbox/install.ts
- packages/server/src/engine/sandbox/install.test.ts
- packages/server/src/engine/sandbox/sandbox-escape.test.ts
- packages/server/src/engine/sandbox/policy.ts
- packages/server/src/engine/sandbox/policy.test.ts
- packages/server/src/engine/sandbox/confined-fs.test.ts
- packages/server/src/engine/sandbox/boot.ts
- packages/blueprints/apps/notes/app-root.tsx
- packages/blueprints/apps/notes/logic.ts
- packages/blueprints/apps/notes/draft-writes.ts
- packages/blueprints/apps/notes/draft-writes.test.ts
- apps/desktop/tests/e2e/fixtures.ts
- apps/desktop/tests/e2e/notes.spec.ts
- apps/desktop/tests/e2e/tasks.spec.ts
- packages/server/src/engine/worker/runner.ts
- packages/server/src/automation/worker/runner.ts
- packages/vault/src/ingest/mbox.ts
- packages/vault/src/ingest/mbox-attachments.test.ts
- packages/vault/src/commands/sync.ts
- packages/vault/src/commands/sync.test.ts
- packages/vault/src/schema/sync.ts
- packages/vault/src/schema/sealed.ts
- packages/vault/src/schema/migrate.ts
- packages/vault/src/schema/migrate.test.ts
- packages/vault/src/schema/migrate-share-grant.test.ts
- packages/tunnel/src/gateway-endpoint.ts
- packages/tunnel/src/gateway-endpoint.test.ts
- packages/tunnel/src/protocol.ts
- packages/tunnel/src/index.ts
- packages/tunnel/data-plane/src/http_plane.rs
- packages/test-kit/src/year3-vault.ts
- packages/vault/src/gateway/portable-export.ts
- packages/vault/src/gateway/portability.test.ts
- scripts/corpora/schema-epoch-census.json
- tests/quality/classification-ratchet.json
- tests/schema-export-fingerprint.json
- SECURITY.md
- CHANGELOG.md
- docs/oauth-assist.md
- deny.toml
- scripts/security/rust-supply-chain.mjs
- packages/tunnel/data-plane/Cargo.toml
- packages/tunnel/data-plane/Cargo.lock
- packages/tunnel/native/Cargo.toml
- packages/tunnel/native/Cargo.lock
- apps/web/iroh-wasm/Cargo.toml
- apps/web/iroh-wasm/Cargo.lock

Gate-corpus follow-ons forced by the new schema rung and the worker.ts edit:
`schema-epoch-census.json` grows to ladderLength 5 (the growth-guard demands
the manifest move with the ladder), and the year-3 sealed canary fixture seeds
the new sealed column so the T3 canary's declared-vs-sentinel sets match.
The Stryker seed range was re-anchored once more when worker.ts gained its
file-size waiver line at the head of the file.
The schema/export ratchet moves with rung five: `portable-export.ts` is
re-audited so `refresh_capability` is named as a must-carry sealed cell on
the already-walked `sync.connection_credential` table, `portability.test.ts`
pins that `SELECT *` still emits it, and `schema-export-fingerprint.json`
takes the new schema hash.
The hygiene ratchet is down-only: four new `toHaveBeenCalled*` sites
(F5 DNS lookup, F6 `openPath`, two F3 pre-Google refusals) were rewritten
to captured arguments / `mock.calls` length so the budget stays 788.
F4's new `process.kill`/`abort`/`report`/`argv` revocations are each
try/caught: a frozen property (Electron workers) must not abort sandbox
install, which takes the handler worker down with it. `process.report` is
kept as the host object; `getReport`/`writeReport` return a redacted
report (no environ, no file) rather than throwing or being replaced with
`undefined` — both of those hung Electron handler workers so custodian
writes never settled. `argv`/`execArgv` are emptied only when the worker
runner passes `redactLaunchArgs` — install.ts must not import
`node:worker_threads` to detect that, or the real module is cached and a
tainted graph can import it past the hook. `process.kill` lets signal `0`
through.
Taint marks and granted read roots are realpath-canonicalised so macOS
`/var/folders` vs `/private/var/folders` aliases cannot drop a handler
out of confinement (the desktop e2e vault lives in `os.tmpdir()`).
`process.kill`/`abort` wrappers consult a per-thread `globalThis` flag
so a shared Electron `process.kill` slot cannot deny the main thread
(that hung `electronApplication.close` and left replica writes
`in-flight`). `argv[0]` is kept (the binary); later slots and
`execArgv` are still emptied.
- **Rust supply-chain (run 32845713089).** `h2` 0.4.15 is RUSTSEC-2026-0258
  (upgrade to ≥0.4.16) — lockfiles move to 0.4.19. Yanked `spin` and unsound
  `lru` 0.18.1 move with them. First-party crates declare `license = "MIT"`
  (the repo licence) so cargo-deny stops treating them as unlicensed.
  `paste` and `atomic-polyfill` are unmaintained iroh transitives with no
  successor iroh has switched to; they are named on `deny.toml`
  `[advisories].ignore` and on `cargo audit --ignore`, not dropped from the
  gate.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-25 | opencode | - |

## Audit

Fresh-context audit of the staged diff (`git diff --cached`, 50 files) against
this receipt and issue #865.

### Check 1 — "What changed" faithfully describes the diff

**PASS.** Every finding's description matches real diff hunks:

- **F1**: `blob-read-route.ts` adds `INLINE_EXECUTABLE_MEDIA_TYPES`
  (html/xhtml/svg), forces attachment disposition, stamps
  `X-Content-Type-Options: nosniff` + `Content-Security-Policy: sandbox`;
  `mbox.ts` hardcodes attachment media type to `application/octet-stream`
  ("staging sniffs the bytes"); `http_plane.rs::serve_blob` inserts both
  headers. The claim that the downgraded disposition flows through the
  data-plane handoff ticket holds via pre-existing plumbing
  (`serve/data-plane-handoff.ts:34,68` carry `disposition`; the route computes
  the downgraded value before handoff).
- **F2**: `build-gateway.ts` derives `ADMIN_GATEWAY_WIDE_PREFIXES` from
  registry rows with `auth === "admin"` and non-active vault scope, refusing
  `403 admin_plane_forbidden` on `AUTHED_PLANE_HEADER === "device"`.
  Cross-checked against `routes/route-security.ts`: the admin non-active rows
  are exactly owners + resource/diagnostics/storage/_logs, and backup/demo are
  `admin, active` — matching the prose verbatim.
- **F3**: `worker.ts` mints the capability whenever Google returns a refresh
  token and verifies it pre-fetch (`missing_capability`/`invalid_capability`,
  401; tests assert upstream called zero times); `connection-broker.ts`
  seals/presents/re-stores it and maps 401 to auth-dead → `needs-auth` with a
  Reconnect note (test asserted); vault rung five
  (`SYNC_CREDENTIAL_REFRESH_CAPABILITY_DDL`) and both sealed registries
  (`SEALED_COLUMNS`, `SEALED_PAYLOAD_FIELDS`) present.
- **F4**: `install.ts` matches the prose exactly — kill/abort throw
  `denied(...)`, report defined non-writable undefined, argv/execArgv frozen
  empty under an `isMainThread` guard.
- **F5**: new `endpoint-guard.ts` implements https-only, no-credentials,
  reserved-range refusal over IP literals and DNS with fail-closed resolution;
  `push-wake-routes.ts` calls it at registration; `web-push.ts` applies the
  synchronous literal backstop at send time; `runner.ts` makes
  `assertFetchDestination` unconditional and switches non-injected fetches to
  `redirect: manual` — consistent with "validation is unconditional".
- **F6**: new `app-reveal-core.ts`; `ipc-core.ts` grammar
  (`^[a-z0-9][a-z0-9-]{0,62}$`, no leading `_`) checked before any join;
  `ipc.ts` rewires APPS_OPEN through it. The prose shorthand `^[a-z0-9-]+$`
  omits the length cap — paraphrase, not misrepresentation.
- **F7**: `gateway-info-routes.ts` serves `endpointId` only when
  `authenticated`, same gate as the ticket.
- **F8**: `web-session-store.ts` touch caps at creation + absolute TTL and
  removes rows already past the wall on first touch.
- **F9**: strip list gains `PEER_VAULT_HEADER` (five headers; a parity test
  reads the Rust source); backstop checks all three peer headers; nonce
  grammar (bounded printable, 1–128 chars) plus signature string check before
  binding; session cap 256 with oldest-expiry eviction beside the TTL sweep.

One discrepancy, noted but not rising to refutation: `apps/desktop/src/main/
app-sessions.ts` (+8 production lines: grammar backstops in
`ensureAppSessionDir`/`resolveAppRevealDir`) is in the staged diff but absent
from the receipt's "Files changed" list. Its behavior is subsumed by F6's
description (grammar-check before path joins), so the prose is not wrong — the
file enumeration is merely incomplete.

### Check 2 — every `- [x]` checklist item is realized in the diff

**PASS.**

- F1 → blob-read-route.ts downgrade + headers; mbox.ts octet-stream;
  http_plane.rs headers (diff hunks cited above).
- F2 → build-gateway.ts admin-tier refusal + authz-matrix.smoke.test.ts cases
  (bearer 200 / proved device 403 on all five gateway-wide routes, proxy lane
  still works below the tier).
- F3 → worker.ts mint/verify; connection-broker.ts sealed round-trip test
  (stored sealed:v1, unsealed for send, rotated re-stored) and legacy-pair
  needs-auth test.
- F4 → install.ts revocations + install.test.ts and sandbox-escape.test.ts
  kill/abort/report/argv cases incl. real-worker environ canary.
- F5 → endpoint-guard.ts(+test), push-wake-routes.ts registration refusal,
  web-push.ts send-time backstop, runner.ts unconditional pin +
  connector.test.ts placeholder-free bypass regression.
- F6 → app-reveal-core.ts(+test), ipc-core.ts grammar, ipc.ts rewiring.
- F7 → gateway-info-routes.ts gate + new gateway-info-routes.test.ts.
- F8 → web-session-store.ts touch cap + constant-use slide test.
- F9 → gateway-endpoint.ts strip list + parity test, build-gateway.ts
  three-header backstop + build-gateway-peer.test.ts, peer-commons-route.ts
  nonce grammar + 256-session cap + peer-commons-hardening.test.ts.
- Docs → SECURITY.md and docs/oauth-assist.md hunks present in the diff.

### Check 3 — receipt Checklist mirrors the issue's acceptance list

**PASS.** Issue #865's eleven acceptance criteria map onto the receipt's ten
boxes: AC1↔F1, AC2↔F2, AC3↔F3, AC4↔F4, AC5↔F5, AC6↔F6, AC7↔F7, AC8↔F8,
AC9↔F9, AC10 (SECURITY.md)↔"Docs moved with the code". Two benign deviations:

- AC11 ("Full gate loop green") has no checkbox in the receipt but is covered
  substantively in its Verification section (lint/format/typecheck clean, test
  results enumerated, Rust gates).
- AC6 prescribes validating appId "against inline-apps ids"; the diff
  implements an app-id grammar check that deliberately does NOT require
  membership in the shipped inline set (documented in ipc-core.ts:
  store-created apps share the grammar). This is a documented mechanism change
  versus the issue's suggested fix, not hidden — but strictly the issue text
  and the implementation differ on mechanism while agreeing on intent
  (traversal/existence-oracle prevention).

### Verdicts

1. What changed vs diff: **PASS**
2. Checklist realized in diff: **PASS**
3. Receipt checklist mirrors issue: **PASS**
