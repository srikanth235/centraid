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
SIGKILL'd host), `process.report` is defined non-writable as `undefined` so
`getReport()` can never leak the real OS environ around the frozen `env`, and
`argv`/`execArgv` are frozen to empty arrays inside worker threads only
(`isMainThread` guard keeps the vitest harness's own argv intact). No lane
needs `process.kill` — the only subprocess lane shells out through the
allowlisted `child_process` builtin.

### F5 — SSRF: push-wake endpoints + runner pin bypass

New `packages/server/src/push/endpoint-guard.ts`;
`push-wake-routes.ts`, `web-push.ts`, `automation/handler/runner.ts`.
Registration refuses push endpoints that are non-https, credential-bearing, or
resolve (DNS or IP literal) to loopback/link-local/private/unique-local/
IPv4-mapped/NAT64/multicast space, failing closed on resolution failure; send
time applies a synchronous reserved-IP-literal backstop so rows persisted by
older builds cannot wake. The runner no longer skips https/host-pin/redirect
validation when a template injects no placeholders — validation is
unconditional; injection semantics are unchanged.

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
first touch; the cookie Max-Age was always advisory against a stolen cookie
file and no longer carries the guarantee alone.

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
  open for expired ones) rather than adding a second sweeper pass.

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

## Verification

```sh
bun run lint && bun run typecheck && bun run test
cargo test && cargo clippy --all-targets   # in packages/tunnel/data-plane
```

- Root gates: `bun run lint`, `bun run format`, `bun run typecheck`
  (turbo 25/25) — clean.
- Full `bun run test`: green across packages/blueprints (4803), client (2312),
  mobile (1660), desktop (323), tunnel (123+2 skip), oauth-worker (42),
  vault (1386+1 skip). `packages/server`: 3272 passed; the only failures are
  23 pre-existing macOS-only cases in `sandbox-escape` / `confined-fs`
  (tests read `/etc/hostname`, absent on Darwin, and compare taint sets built
  from symlinked temp dirs that Node realpaths to `/private/var/...`);
  identical at baseline before this branch's changes, green on Linux CI.
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
- SECURITY.md
- docs/oauth-assist.md

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
