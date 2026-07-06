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

## What changed

Commit series (each `(#304)`):

1. `feat(vault): broker credential sidecars …` — `packages/vault/src/schema/sync.ts`
   (`SYNC_CREDENTIAL_DDL`: v12 `sync_connection_credential` + `sync_connection_health` sidecars),
   `packages/vault/src/schema/migrate.ts` (v12), `packages/vault/src/schema/sealed.ts`
   (`sync.connection_credential` sealed cells), `packages/vault/src/schema/tables.ts` (entity
   registry), `packages/vault/src/commands/sync.ts` (`sync.configure_credential`,
   `sync.store_tokens`, `set_connection_status` note + `setAuthNote`),
   `packages/vault/src/commands/sync.test.ts`.
2. `feat(automation): connection credential injection + injected-fetch failure taxonomy …` —
   `packages/automation/src/handler/runner.ts` (`ConnectionAuth`, `{{connection:…}}` substitution,
   `assertInjectable` host-pin + read-only ceiling, `executeFetch` taxonomy),
   `packages/automation/src/fire/fire.ts` (`ResolveConnection` broker preflight),
   `packages/automation/src/manifest/manifest.ts` (explicit `requires.tools: []`),
   `packages/automation/src/index.ts` exports, `packages/automation/src/fire/connector.test.ts`,
   `packages/agent-runtime/src/automation/run-automation.ts` (pass-through).
3. `feat(gateway): connection broker …` — `packages/gateway/src/serve/connection-broker.ts`
   (`ConnectionBroker`: resolve/refresh/single-flight/limiter/ceremony),
   `packages/gateway/src/serve/build-gateway.ts` (wired into the fire path),
   `packages/gateway/src/serve/connection-broker.test.ts`.
4. `feat(gateway): PKCE consent ceremony, connections routes, BYO-client wizard presets …` —
   `packages/gateway/src/routes/connections-routes.ts`,
   `packages/gateway/src/routes/connection-providers.ts`,
   `packages/gateway/src/routes/connections-routes.test.ts`,
   `packages/app-engine/src/http/http-server.ts` (+`.test.ts`) `publicPaths` seam,
   `packages/gateway/src/serve/serve.ts` (callback registered public).
5. `feat(blueprints): Gmail pull …` + `feat(blueprints): Calendar + Contacts + GitHub …` — the four
   connector templates under `packages/blueprints/automations/{google-gmail-pull,google-calendar-pull,
   google-contacts-pull,github-pull}/`, `packages/blueprints/index.json` (+ generated `manifest.json`).
6. `feat(automation): read-only ceiling …` — the `allowWrites` guard + tests (folded into runner.ts /
   connector.test.ts above) and this receipt.

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

Re-runnable:

```sh
bun run build
bun run typecheck                              # 21 tasks green
bun run test                                   # full battery green
npx vitest run src/commands/sync.test.ts --root packages/vault
npx vitest run src/fire/connector.test.ts --root packages/automation
npx vitest run src/serve/connection-broker.test.ts src/routes/connections-routes.test.ts --root packages/gateway
```

- `packages/vault`: 365/365 tests green (8 new: configure/store sealing, host-pin refusal,
  placeholder reads, journal redaction, detach shredding, note lifecycle; migration ladder replay
  green — sidecar DDL is re-runnable).
- `packages/automation`: 206/206 green (9 new: injection + scrub, host-pin refusal with zero
  egress, 401→refresh→retry, 401 auth-dead, 429/5xx backoff, refused-connection skip,
  placeholder-without-credential error, `requires.tools: []` manifest contract; read-only ceiling
  refuses injected POST, write-opted credential lets it through).
- `packages/gateway`: connection-broker suite 8/8 green (api_key resolve, ambient lane,
  unexpired-token no-op, rotation persist-before-use, single-flight under 3-way concurrency,
  invalid_grant flip + note, 5xx transient no-flip, forced refresh); connections-routes suite 3/3
  green (full ceremony configure→authorize→callback→active with sealed tokens + single-use state,
  declined consent, pause/resume + wizard presets).
- `packages/app-engine`: http-server 7/7 green (publicPaths exact-match bearer bypass).
- `packages/blueprints`: 121/121 green (4 new connector templates validate + gallery index agrees).
- Full `bun run typecheck` (21 tasks) green; `bun run build` green; full test battery green.

## Audit

A fresh-context adversarial reviewer audited token custody/injection, refresh correctness, the PKCE
ceremony, sealed columns, and the four connector handlers.

**Security-critical machinery: PASS.** Confirmed: handler code never receives a raw token
(substitution is parent-side, values feed the scrub set); the host-allow check runs on the *final
substituted* URL before the fetch; the `*.suffix` wildcard rejects `evilgoogleapis.com` and bare
`.googleapis.com` (endsWith + length guard); injected requests use `redirect: 'manual'` so a 3xx
Location cannot carry Authorization cross-host; the read-only ceiling gates all injected mutations
(broker never sets `allowWrites`); single-flight refresh is race-free (no `await` between
check-and-set, sync sqlite read); the rotated pair is returned only after `sync.store_tokens`
executes (no unpersisted token used); `invalid_grant`→flip vs 5xx→transient is distinguished
correctly; `state` is single-use (deleted before any fallible work, consumed on denial); S256 is
correct; the bearer-free callback is an exact-match `publicPaths` bypass, not a prefix; all four
secret cells are sealed + `sealedInput`, and the sidecar AAD matches between seal and unseal.

**One functional defect found and FIXED:** the Calendar connector sent `syncToken` + `pageToken`
together on a paginated incremental resume (>1000 changed events), which Google rejects with a 400
(they are mutually exclusive), permanently wedging incremental sync until a 410 forced a full
re-walk. Fixed in `google-calendar-pull/handler.js` — a continuation page now carries `pageToken`
alone. The auditor noted the Contacts connector shares the code shape but the People API's contract
*requires* both tokens across pages, so it is correct as-is (comment added cross-referencing both).

## Steering

No corrective steering. The session ran from a `/goal` directive ("get latest code from main, work
the entire scope of #304, create PR") after an interactive design conversation that produced #304
itself; the operator did not interrupt or redirect during implementation. The one substantive
judgment call made autonomously — scoping phase 5 to the enforceable read-only *guard* while
deferring the parked-approval *send* flow — follows the issue's own sequencing ("writes only after
ingest earns trust") and is recorded under Out of scope.
