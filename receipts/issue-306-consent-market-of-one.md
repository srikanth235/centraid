# Receipt — issue #306: consent for a market of one — install-time scopes, the outbox, structural pins over approvals

GitHub issue: https://github.com/srikanth235/centraid/issues/306
Amends #294 decision 4 (standing grants now minted from outbox items; install-time scopes subsume
the enrollment choice for internal writes). Supersedes the deferred #304 parked-approval
send-executor shape and completes #304 phase 5's write half. Builds on #293 (sealed/reveal,
untouched), #299 (auto-publish precedent), #270 (parked surface), #290 (broker invariants).

## Checklist (issue phasing)

- [x] Phase 1 — flip the defaults
  - [x] Runtime parking for internal commands deleted: `RISK_RANK`-vs-ceiling gone from the invoke
        pipeline; `Identity.riskCeiling` removed (the `consent_app.risk_ceiling` column stays as
        inert metadata — no schema change, standing v0 rule)
  - [x] Parking survives ONLY for Tier 3/4 verbs: `CommandDefinition.confirm` → the
        `agent_capability.requires_confirmation` row; a non-owner invoking a confirm-gated command
        parks for every caller, regardless of risk. Marked: `social.send_message`,
        `business.send_invoice`, `sync.publish_batch`, `sync.set_connection_trust`,
        `core.merge_party`
  - [x] `risk` → salience marker: journaled in every invocation receipt's `detail.risk` (allow and
        deny), ranked by the review feed
  - [x] Purpose auto-default: `purpose?` across ReadRequest / SearchRequest / InvokeRequest /
        ChangesRequest / RevealRequest; `DEFAULT_PURPOSE = 'dpv:ServiceProvision'` applied at every
        gateway entry point; the journal records the defaulted notation; `consent.policy` purpose
        rules still evaluate (against the declared purpose when supplied, the default when not)
  - [x] Install-time scopes: `VaultPlane.ensureAppInstallGrant` / `ensureAgentInstallGrant`
        (idempotent exact-triple scope diff, top-up grants) wired at every enrollment site —
        vault mount, app publish (`onAppLive`), lifecycle `ensureRegistered`, `syncApps`, and the
        scheduler reconcile for automations (declared `manifest.vault` blocks)
- [x] Phase 2 — the outbox primitive
  - [x] v13 `outbox_grant` + `outbox_item` (artifact_json = the thing itself; request_json =
        the injectable call with `{{connection:…}}` placeholders, never tokens)
  - [x] `outbox.stage` (risk low, inert row) / `outbox.decide` (owner-only in the handler — a
        schema-wide `act` grant lets an actor stage, never decide) / `outbox.record_result`
        (owner-plane executor only) / `outbox.revoke_grant`
  - [x] `ConnectionBroker.resolveForDrain`: the ONE holder of `allowWrites: true`; `resolveForFire`
        unchanged — connector fires stay read-only (acceptance criterion 5)
  - [x] `OutboxExecutor` (gateway-side, outside the fire loop): drains `approved` items only,
        substitutes placeholders executor-side, re-asserts the #304 pin (https + allowed_hosts,
        manual redirects) on the substituted URL, one forced refresh on 401, per-connection rate
        gate, receipted `outbox.record_result` per drain; single-flight per vault; terminal 4xx →
        `failed`, transient/auth-dead → item stays `approved` for the next pass
  - [x] Drain triggers: owner approval (route kick), post-fire (grant-matched items a connector
        just staged), 60s slow clock per mounted vault
  - [x] First consumer: `google-gmail-send` blueprint template — condition trigger on released
        email messages (`delivery='sent'`, no `external_id`), renders RFC 2822 into the outbox;
        `requires.tools: []`, no ctx.fetch, dedupe via ctx.state
- [x] Phase 3 — standing grants as outbox bypass
  - [x] `(actor, verb, target)` rules minted lazily from a concrete item via
        `outbox.decide {always_allow: true}`; matched items auto-approve at staging time and still
        drain through the executor + land in the review feed; revocable
        (`outbox.revoke_grant` / DELETE route); revoked with the actor on uninstall (`revokeApp`)
- [x] Phase 4 — surfaces
  - [x] Blocking/review split: `GET /_vault/blocking` (pending outbox + needs-auth connections
        with notes + Tier 3/4 parked) and `GET /_vault/review` (salience-ranked receipt feed:
        risk-weighted, denies above allows, recency tiebreak)
  - [x] Outbox surface: `GET /_vault/outbox?status=`, `POST /_vault/outbox/<itemId>` (approve /
        edit-then-send / discard / always-allow), `GET|DELETE /_vault/outbox-grants`
  - [x] Enrichment is one decision: `POST /centraid/_automations/enrichment {enabled}` batch-flips
        every installed `category: "Enrichment"` template automation
  - [x] Install screen scopes: `GET /_vault/apps/<appId>/scopes` — granted scopes (both identity
        planes) + salience highlights (act commands risk-ranked, confirm-gated flagged)

## Acceptance criteria

- [x] Installed app invoking declared commands never parks below Tier 3/4; invocation journaled
      with its risk marker (`vault-plane.test.ts`, `gateway.test.ts`)
- [x] `ctx.vault.invoke` without a purpose succeeds; journal records the default;
      policy purpose rules still evaluate when supplied (`gateway.test.ts`)
- [x] Connector stages an item; item renders as its artifact; approve → executor performs the
      write via injected credentials toward pinned hosts; discard → no egress, receipted
      (`outbox.test.ts`, `outbox-executor.test.ts`)
- [x] "Always allow" mints a standing grant; the next matching item drains without owner action
      and appears in the review feed (`outbox.test.ts`, post-fire/clock drain)
- [x] Read-only ceiling remains: `resolveForFire` never sets `allowWrites`; only
      `resolveForDrain` (executor-only) does
- [x] Sealed reveal and purge/shred flows unchanged (reveal verb untouched; vault suite green)
- [x] Enrichers enabled in one action (`/_automations/enrichment`)

## What changed

Commit series (each `(#306)`):

1. `feat(vault): consent tiering — confirm-gated parking, risk as salience, purpose auto-default`
   — gateway/types.ts (`confirm`, `DEFAULT_PURPOSE`, `purpose?`), gateway/gateway.ts (parking off
   `requires_confirmation`, purpose normalization per entry point), gateway/identity.ts
   (riskCeiling removed), gateway/consent.ts (default in evaluation), gateway/evidence.ts,
   gateway/execution.ts (risk marker in receipts, defaulted ctx purpose), the five Tier 3/4
   `confirm: true` flags, index exports; tests updated + 3 new.
2. `feat(vault): the outbox — external writes as artifacts, standing grants`
   — schema/outbox.ts (v13), schema/migrate.ts, schema/tables.ts, commands/outbox.ts (+13 tests).
3. `feat(gateway): install-time scopes, outbox executor on the allowWrites lane, blocking/review split`
   — serve/vault-plane.ts (register outbox commands, install-grant top-ups, outbox/blocking/review/
   scopes surfaces, uninstall revokes standing rules), serve/connection-broker.ts
   (`resolveForDrain`), serve/outbox-executor.ts (+7 tests), serve/build-gateway.ts (wiring:
   install grants at every enrollment site, drain kicks + slow clock), routes/vault-routes.ts,
   routes/lifecycle-automation-routes.ts + lifecycle-routes.ts (enrichment batch toggle),
   comment-truth fixes (assistant runner, desktop vault tab); vault-plane tests updated + 2 new.
4. `feat(blueprints): google-gmail-send — the first outbox consumer`
   — the template (app.json / automation.json / handler.js), index.json, regenerated manifest.json.
5. `docs: receipt`.

## Decisions of record

- **Parking is a property of the command, not of the caller** — `confirm: true` writes
  `agent_capability.requires_confirmation`; the invoke pipeline consults the capability row (the
  gateway stays a declarative interpreter over consent/capability tables), so tests and future
  tooling flip the row, not code.
- **`Identity.riskCeiling` deleted, column retained** — risk stops being an approval input
  anywhere in the pipeline; the `consent_app.risk_ceiling` column stays (v0 no-migrations rule)
  as inert metadata.
- **The outbox row carries BOTH the artifact and the injectable request** — the artifact is what
  the owner reads and edits; the request is what the executor performs. Placeholders substitute
  executor-side only; a token never sits in a row, a receipt, or a log line (scrubbed).
- **`outbox.decide`/`record_result` are owner-only IN THE HANDLER** — a schema-wide `act` grant
  on `outbox` (what connectors get) covers `stage` only; the asymmetry is structural, not policy.
- **Terminal vs deferred drains** — provider 4xx is terminal (`failed` + scrubbed snippet);
  429/5xx/network/auth-dead leave the item `approved` for the next pass (needs-auth items wait
  for the owner's reconnect; the blocking surface names why).
- **Install-time grants are a top-up diff, not a replacement** — exact (schema, table, verbs)
  triples; already-covered scopes mint nothing, so enrollment is idempotent across restarts and
  republishes; ext-band ownership assertion still runs (an app cannot declare a sibling's band).
- **Purposes dormant, not deleted** — the vocabulary, `purpose_concept_id` columns, and
  `consent.policy` purpose rules all stay; only the invoke contract relaxed.
- **gmail-send composes with `social.send_message`, not around it** — releasing a draft is the
  Tier 3 intent gesture; the connector renders the released message into the outbox where the
  FIRST send to a recipient is approved concretely and "always allow" makes the rest flow.

## Out of scope

- Desktop renderer panels for blocking/review/outbox (the routes + payload shapes are the
  gateway contract; the renderer rides the existing settings-page pattern as a follow-up — same
  call #304 made for Settings→Connections).
- Multi-party/sharing consent semantics (issue non-goal; purposes stay dormant for it).
- A runtime policy engine (grants are rows; the outbox is a table; salience is a sort key).
- Offline device-side outbox queueing (the table is the seam; device sync is future work).
- Drive connector (issue decision 7: plumbing, not consent — still blocked on the
  connector→blob-staging bridge).
- Runtime cross-automation cycle detection (#294 non-goal stands; the executor is loop-safe by
  construction: drains only owner-approved/grant-matched items, receipted, outside the fire loop).
- Data migrations (standing v0 rule): dev vaults recreate; v13 applies forward.

## Verification

Re-runnable:

```sh
bun run build
bun run typecheck                          # 21 tasks green
bun run test                               # full battery green (21/21 tasks)
npx vitest run src/commands/outbox.test.ts src/gateway/gateway.test.ts src/gateway/sealed.test.ts --root packages/vault
npx vitest run src/serve/outbox-executor.test.ts src/serve/vault-plane.test.ts --root packages/gateway
```

- `packages/vault`: 377/377 green (13 new outbox command tests: inert stage, unknown-connection
  refusal, owner-only decide, discard-no-egress, edit-then-send, no re-decide, standing-grant
  mint/match/scope/revoke, drain-record gating incl. forged-record refusal; 3 new gateway tests:
  no-park + risk marker, omitted-purpose default journaled, policy purpose rules incl. defaulted
  evaluation; migration ladder replay green — v13 is IF-NOT-EXISTS re-runnable).
- `packages/gateway`: 188 green (7 new executor tests: inject-toward-pin + receipted sent,
  pending-never-drains, discard-terminal, out-of-pin zero-egress terminal failure, 401→refresh→
  retry on the oauth2 lane, credential-less defer, blocking/review split; 2 new vault-plane
  tests: install-time grant idempotence + widening + agent mirror + scope surface, no-park with
  risk marker; parked tests rewritten to the confirm-gated contract).
- `packages/automation`: 214/214 green — the read-only ceiling test (injected POST refused)
  passes UNCHANGED: connector fires still cannot write.
- `packages/blueprints`: 123/123 green (template validation covers google-gmail-send; gallery
  index and generated manifest agree).
- `packages/app-engine`: 225/225 green. Full `bun run typecheck` (21 tasks) + `bun run build`
  green. `oxlint` at main's baseline (23 pre-existing errors, none added); `format:check`
  matches main's baseline (pre-existing failures on files this change does not touch).

## Audit

A fresh-context adversarial reviewer audited the ten load-bearing properties (read-only ceiling,
injection custody, host pin on the substituted URL, owner-only decide/drain, standing-grant
matching + uninstall revocation, parking-flip soundness incl. replay paths, purpose journaling,
install-grant validation, the gmail-send handler, executor loop-safety). Findings and their
resolutions are recorded in the PR description.
