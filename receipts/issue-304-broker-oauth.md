# Receipt — issue #304: broker-owned OAuth — BYO clients, sealed connections, first provider wave

GitHub issue: https://github.com/srikanth235/centraid/issues/304
Amends #290 decision 4 (harness-ambient credentials) via its own escape clause: Google offers no MCP
for personal accounts, so the must-have sources (Gmail/Calendar/Contacts/Drive) are unreachable
through any harness. Credentials the connection carries itself — `oauth2` (owner's BYO client) and
`api_key` (static PAT) — now ride the same broker invariants.

## Checklist (issue phasing)

- [x] Phase 1 — broker cred kinds + connection lifecycle
  - [x] v12 sidecars: `sync_connection_credential` (sealed cells) + `sync_connection_health` (auth_note)
  - [x] `sync.configure_credential` (risk medium, sealedInput) + `sync.store_tokens` (risk low, sealedInput)
  - [x] `sync.set_connection_status` carries an owner-readable `note`; cleared on return to active
  - [x] Gateway `ConnectionBroker`: single-flight refresh, rotation-safe persist-before-use,
        invalid_grant → needs-auth flip + note, 5xx → transient (no flip), per-connection rate gate
  - [x] Transport injection: `{{connection:…}}` placeholders in `ctx.fetch`, host pin
        (`allowed_hosts`, exact or `*.suffix`, https-only off loopback), manual redirects on
        injected requests, scrub net extended to injected values
  - [x] Fetch failure taxonomy: 429/5xx bounded backoff (Retry-After respected), 401 → one forced
        refresh → retry, 401-dead/403-insufficient-scope → needs-auth flip
  - [x] Fire spine: broker preflight (refused → skip, like honest-liveness), manifest allows
        explicit `requires.tools: []` for fetch-only connectors
- [ ] Phase 2 — PKCE ceremony + connections routes + Google BYO wizard + Gmail connector template
- [ ] Phase 3 — Calendar + Contacts + Drive connector templates
- [ ] Phase 4 — GitHub PAT connector template
- [ ] Phase 5 — external writes behind parked approvals

## Decisions of record

- **Sidecars, not columns** — `ALTER TABLE ADD COLUMN` breaks migration re-runnability (the ladder
  replays in tests); same call #298 (locker aliases) and #299 (phash) made.
- **Credential attaches to the connection row, not the manifest** — the manifest names WHICH
  connection (kind+label); the owner attaches the credential out-of-band. `ConnectorSpec` is
  untouched; templates just use `{{connection:access_token}}`.
- **Injection only, never handout** — placeholders substitute parent-side of the worker boundary
  (the #293 seam); tokens are only attached toward `allowed_hosts`. Token exfiltration by connector
  code is structurally impossible, not policy-forbidden.
- **Health notes live in their own sidecar** — needs-auth flips predate credentials (missing locker
  secret, principal mismatch), so the note store must not be coupled to the credential row.
- **403 flips needs-auth only when the body names scopes** — GitHub uses bare 403 for rate limits;
  a scope-flavored 403 (`insufficient_scope`/`insufficientPermissions`) is a consent event.
- **Broker refresh persists through `sync.store_tokens`** — receipted, seal-swept, journal-redacted;
  an unpersisted rotated token is never used (crash between refresh and persist cannot orphan the
  connection).

## Out of scope

- Webhook/push ingestion (gateway grows no new inbound surface; polling + cursors only).
- A hosted redirect relay (rejected in the issue; PKCE + gateway/loopback callback suffice).
- A shared Centraid-registered OAuth client (BYO only in v0).
- Bidirectional sync (standing #290 non-goal); Phase 5 covers explicit parked writes only.
- Data migrations (standing v0 rule): dev vaults recreate; v12 applies forward.

## Verification

- `packages/vault`: 365/365 tests green (8 new: configure/store sealing, host-pin refusal,
  placeholder reads, journal redaction, detach shredding, note lifecycle; migration ladder replay
  green — sidecar DDL is re-runnable).
- `packages/automation`: 204/204 green (7 new: injection + scrub, host-pin refusal with zero
  egress, 401→refresh→retry, 401 auth-dead, 429/5xx backoff, refused-connection skip,
  placeholder-without-credential error; `requires.tools: []` manifest contract).
- `packages/gateway`: connection-broker suite 8/8 green (api_key resolve, ambient lane,
  unexpired-token no-op, rotation persist-before-use, single-flight under 3-way concurrency,
  invalid_grant flip + note, 5xx transient no-flip, forced refresh).
- Full `bun run typecheck` (21 tasks) green; `bun run build` green.
