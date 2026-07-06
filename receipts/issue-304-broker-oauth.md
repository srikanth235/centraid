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
- [x] Phase 2 — PKCE consent ceremony (gateway + loopback callback, single-use state, bearer-free
      `publicPaths`), connections routes (health list / configure / pause-resume / authorize /
      callback), Google BYO wizard presets (Testing-status + Photos traps baked in), Gmail connector
- [x] Phase 3 — Calendar (syncToken) + Contacts (People API → core.party merge candidates) connectors
      (Drive metadata deferred — see below)
- [x] Phase 4 — GitHub fine-grained PAT connector (api_key lane in anger)
- [x] Phase 5 — read-only ceiling ENFORCED (injected fetch refuses mutating methods unless the
      credential opts into writes); the per-write parked-approval SEND flow is deferred by the
      issue's own sequencing (wave 1 is read-only ingest; writes "only after ingest earns trust")

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

- **The parked-approval SEND flow** (phase 5's other half): the guard makes writes structurally
  impossible by default; actually performing an approved external write needs a broker-side executor
  outside the fire loop (stage intent → park → owner approves → broker drains). Deferred per the
  issue's "only after ingest has earned trust" — the enforceable read-only property ships now.
- **Drive connector** (phase 3): metadata + selective CAS pull needs a blob-staging bridge from a
  connector handler (issue #300's staged_sha claim path is owner/import-surface today, not connector
  ctx). The Google credential already lists the Drive scope + host, so the connector is additive when
  that bridge lands. Gmail/Calendar/Contacts cover the phase-3 value.
- Webhook/push ingestion (gateway grows no new inbound surface; polling + cursors only).
- A hosted redirect relay (rejected in the issue; PKCE + gateway/loopback callback suffice).
- A shared Centraid-registered OAuth client (BYO only in v0).
- A desktop Settings→Connections UI: the routes + wizard content are the gateway contract; the
  renderer panel rides the existing settings-page pattern and is a follow-up (no vault contract change).
- Bidirectional sync (standing #290 non-goal).
- Data migrations (standing v0 rule): dev vaults recreate; v12 applies forward.

## Verification

- `packages/vault`: 365/365 tests green (8 new: configure/store sealing, host-pin refusal,
  placeholder reads, journal redaction, detach shredding, note lifecycle; migration ladder replay
  green — sidecar DDL is re-runnable).
- `packages/automation`: 204/204 green (7 new: injection + scrub, host-pin refusal with zero
  egress, 401→refresh→retry, 401 auth-dead, 429/5xx backoff, refused-connection skip,
  placeholder-without-credential error; `requires.tools: []` manifest contract).
  placeholder-without-credential error; `requires.tools: []` manifest contract; read-only ceiling
  refuses injected POST, write-opted credential lets it through).
- `packages/gateway`: connection-broker suite 8/8 green (api_key resolve, ambient lane,
  unexpired-token no-op, rotation persist-before-use, single-flight under 3-way concurrency,
  invalid_grant flip + note, 5xx transient no-flip, forced refresh); connections-routes suite 3/3
  green (full ceremony configure→authorize→callback→active with sealed tokens + single-use state,
  declined consent, pause/resume + wizard presets).
- `packages/app-engine`: http-server 7/7 green (publicPaths exact-match bearer bypass).
- `packages/blueprints`: 121/121 green (4 new connector templates validate + gallery index agrees).
- Full `bun run typecheck` (21 tasks) green; `bun run build` green; full test battery green.
