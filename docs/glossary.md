# Glossary

Authoritative product vocabulary. Prefer these terms in code, docs, commits, and review. When a concept has a canonical type, the pointer is listed.

## Runtime model (never "chat" for the ledger)

| Term | Meaning | Code |
| --- | --- | --- |
| **conversation** | Durable thread. Single-kind: `kind ∈ {chat, build, automation}`. | `packages/server/src/engine/conversation/schema.ts`; tables in `gateway-db.ts` |
| **turn** | One execution under a conversation (`conversation_id` NOT NULL, FK, CASCADE). One reply round for chat; one compile/fire / `ctx.delegate` round for automation. | same |
| **item** | Ordered trace element under a turn. `kind ∈ {message_in, step, tool, delegate}`. Inbound is `message_in` ordinal 0. | same |
| **run_summary** | Derived VIEW over the ledger for Insights — not a separate write path. | `packages/server/src/engine/stores/gateway-db.ts` |

There is **no `run` layer** and no `run_nodes` table (collapsed in #190). Automation is a conversation whose other side is a deterministic script; its transcript is the same ledger.

### Forbidden synonyms (runtime model)

| Avoid | Use instead | Why |
| --- | --- | --- |
| "chat" for the ledger / schema | **conversation** / **turn** / **item** | Chat is one `conversation.kind`, not the model name |
| "session" for durable agent history | **conversation** | Session means an opaque harness resume handle or an HTTP session, never ledger identity |
| "message" as the unit of agent work | **item** (or `message_in` item) | Messages are one item kind |
| "run" / "run node" as a ledger layer | **turn** / **item** | Pre-#190 vocabulary |
| "thread" as a table name | **conversation** | Informal synonym only |
| runner / backend / provider / adapter for an installed agentic CLI | **harness** | One axis has one word; adapter is reserved for a first-party ACP shim and provider for the egress vendor |
| agent for a model-turn rail or ledger item | **delegate** / `ctx.delegate` | Agent is reserved exclusively for autonomous principals |

"Chat" remains fine in **UI copy** ("Ask your vault") and when `conversation.kind === 'chat'`.

Schema names follow the same one-axis rule: **a table never repeats its schema name**. The plane's central table is named for what one row represents (`consent.agent` → `consent_agent`, `media.asset` → `media_asset`), not by stuttering the plane (`agent.agent` → `agent_agent`, `media.media_asset` → `media_media_asset`).

## Core product nouns

| Term | Meaning | Code |
| --- | --- | --- |
| **superapp** | What Centraid is: a personal, local-first superapp — one shell wrapping many first-party apps whose content characters could not be more different. The container for every noun below. Not a builder, platform, or host for anyone else's apps ([#799](https://github.com/srikanth235/centraid/issues/799); [decisions.md](decisions.md#product-positioning)). | the shell in `packages/client/src/react/shell/`; the catalogue in `packages/blueprints/apps/` |
| **system app** | One of the bundled first-party apps the superapp ships (Tasks, Agenda, Tally, People, Notes, Docs, Locker, Photos). Every app is a system app — there is no other kind. | `packages/blueprints/apps/<app>/`; registry `inlineApps.ts` |
| **vault** | Sovereign personal ontology for one owner. Unit of custody: `vault.db` + `journal.db` (+ apps/, code/, …). | `packages/vault`; on-disk under `vault/<vaultId>/` |
| **gateway** | Host-agnostic backend that mounts vaults, serves HTTP, runs automations and harness turns. The same core runs under the desktop-controlled local daemon or as the standalone `centraid-gateway` daemon. | `packages/server` — `buildGateway()`, `serve()` |
| **app** | Installed projection over the vault. Code serves from the release (UI blueprints) or cloned automation sources. Declared handlers in `app.json`. | `packages/server/src/engine`, `packages/blueprints` |
| **inline app** | An app rendered as a React route **inside the shell** — no iframe, no bridge, replica-backed, offline-capable. Since #799 this is the _only_ DOM render path, so "inline" is a description of the mechanism rather than a contrast with a second one; the qualifier survives because the code identifiers do (`inlineApps.ts`, `app-inline.tsx`, `InlineAppRoute.tsx`). | `packages/client/src/react/shell/routes/InlineAppRoute.tsx`; registry `inlineApps.ts`; `packages/blueprints/apps/<app>/app-inline.tsx` |
| **blueprint** | Shipped template: UI app under `packages/blueprints/apps/` (install-in-place) or automation under `automations/` (clone). | `packages/blueprints` |
| **automation** | Headless conversation + manifest + handler that fires on schedule, webhook, condition, or vault data change. | `packages/server/src/automation` |
| **harness** | An installed model-capable CLI Centraid can drive for a turn, such as `codex`, `claude-code`, or `opencode`. Code and wire identifiers use `Harness*`; Settings keeps the market-facing label **Agents**. | `packages/server/src/acp/registry.ts`; `docs/harnesses.md` |
| **delegate** | A bounded judgment step requested by a handler through `ctx.delegate`; recorded as an item with `kind='delegate'`. It is an act, not a principal. | `packages/server/src/automation/handler/ctx.ts`; `packages/server/src/acp/automation/run-automation-live-dispatch.ts` |
| **agent** | An autonomous L2 principal with an enrolled credential. Never a harness, model call, handler rail, or ledger item kind. | `consent_agent`; `packages/vault/src/schema/consent.ts` |
| **adapter** | A first-party npm shim that makes a CLI without a native ACP mode speak ACP. No other integration or persistence field uses this word. | `AcpAdapterSpec`; `packages/server/src/acp/backends/acp/adapter-bin.ts` |
| **provider** | The external vendor that receives egress. Use only in egress/consent/model-vendor language, never as the installed CLI's name. | `ProviderEgressConsentController` |
| **Notifications** | The owner-facing projection that unifies open **decisions** with informational **notices**. It owns no second copy of decision state. | `GET /centraid/_vault/notifications`; `VaultPlane.notificationsSummary()` |
| **decision** | An item that needs the owner to act. Outbox, needs-auth, parked invocation, and scope-request tables remain canonical; Notifications projects them and only these count in its badge. | `VaultPlane.blocking()` |
| **notice** | A durable, non-decision Notifications update. Repeats collapse by `(kind, source_ref)` and carry read/archive state. | `notifications_notice`; `NoticeStore` |
| **reminder** | A due task/event/tally/invite notification with its own schedule and action model. Reminders are not Notifications notices. | `/_reminders/due`; reminder monitors |
| **gateway health** | Live gateway/component **status** — never a Notifications notice (#665). Status is not something the owner can resolve by acting on a card; it lives on the Gateway page (status card, Components tab, durable Alerts history) plus the desktop's threshold-gated OS notification. | `apps/desktop/src/main/gateway-monitor.ts`; `gateway-outage-log-core.ts`; `AlertHistoryPanel` |
| **wake** | Content-free APNs/FCM/Web Push signal that tells a client to fetch locally. A wake never carries a Notifications headline or vault content. | `PushWakeRelay` |
| **handler** | Declared query (read) or action (write) in `app.json`, validated by Ajv, run in a worker with `ctx.vault`. | `packages/server/src/engine/handlers/` |
| **consent / grant** | Owner-signed permission for an app or device to touch vault scopes. App and device scope grants are **strategy machinery beneath manifests**; a member's standing authority answers live in the one authority table ([#883](https://github.com/srikanth235/centraid/issues/883)). | `packages/vault` consent gateway |
| **journal** | `journal.db` — audit/receipt stream **and** conversation ledger bands. | vault package + app-engine `gateway-db.ts` |
| **replica** | Consent-scoped, read-mostly device copy; intents for offline writes; gateway is sole canonical writer. | `packages/vault` replica schema; `packages/client/src/replica/` |
| **pending-write overlay** | The durable local read law `replica ⊕ outbox`. A stable projected row survives reload/restart and carries queued/sending/parked/denied/conflict/failed status until canonical execution or explicit discard. Never “optimistic state” owned by an app component. | `packages/blueprints/apps/_shared/pending-overlay.ts`; per-app `pending-projection.ts` |
| **pairing** | One-time ticket ceremony that enrolls a device key to one or more vaults over the tunnel; each vault remains an independent binding. | `packages/server` pairing/enrollment stores; `packages/tunnel` |
| **pair ticket** | The **only** ticket kind (#603). Always means _join an existing gateway_. Minted by an owner, one-time, burns on redeem. | `pairing-ticket-codec.ts`; `centraid-gateway pair` |
| **auto-found** | What a gateway does to **itself** when constructed over a **fresh data dir**: creates one marked-default `Personal` vault, enrolls the host device's owner, and records that owner in `vault_owners` — silently, with no ceremony, ticket, kit, or screen. Shared vaults are explicit later owner actions. Founding is simply the first **mint** (#726 D2). An existing data dir is never modified. | `buildGateway()` in `serve/build-gateway.ts`; `VaultRegistry.isFresh()` |
| **Personal / Shared** | Names, not types. `Personal` is the auto-founded owner's default vault. `Shared` is an ordinary vault an owner may create later; it is not created by founding and nothing on its record means "sharing". Profile names and colors are optional Settings choices, not a first-run gate. | `build-gateway.ts`; profile in `packages/client/src/react/shell/routes/profileData.ts` |
| **owner** | The one person a vault belongs to — exactly one, forever, across migrations (#726, superseding #599's member/role model). Stable `owner_id` + editable label in `gateway.db`; devices bind to an owner, never to a role. Never a `core_party` row: people-as-_data_ and people-as-_principals_ are separate concepts, and a party row never confers authority. See [Owners](#owners-gateway-726). | `owners` / `vault_owners` in `gateway-db.ts` |
| **host** | The gateway whose disk and process a vault currently sits on. Hosting is a location, not an authority: the host can read a hosted vault's plaintext and signs unattended on its behalf, but cannot erase it, form or revoke its links, enroll a device to it, or back it up — those require being its **owner** (#726 D2). See [Owners](#owners-gateway-726). | `owner_id` on `vault_owners`; no schema column names a host |
| **tunnel / relay** | Iroh QUIC device path; browsers are relay-only (no UDP). | `packages/tunnel`, `packages/tunnel/data-plane` |
| **CAS / custody** | Content-addressed blob store; local-only vs remote-primary lifecycle. | `packages/vault` blob; backup package |
| **skill** | Harness grounding unit (`SKILL.md`) loaded by the harness runtime. | `packages/server/src/skills` |
| **recognition automation** | Bundled handler that owns its ML implementation, reads bytes/text with `ctx.vault.content`, and writes model-versioned derivatives with `ctx.vault.invoke`. Model assets may live in the local automation runtime; there is no separate enrichment service or generic inference context. | `packages/blueprints/automations/{photo-ocr,transcript,embed-image,embed-text,faces}` |
| **deterministic step** | The self-contained, non-delegate branch of a recognition automation: same input + pinned local specialist model gives the same canonical result without provider egress. | `packages/model-runtime/automation-handlers`; generated handlers under `packages/blueprints/automations` |
| **delegate step** | An optional alternate step in the same recognition template using `ctx.delegate`, a harness/model pin, and provider-egress consent. `photo-ocr` and `doc-text-extractor` declare one; it is not a provider kind or second engine. Which engine runs it is answered by policy, so `delegateStep.selected` is the recipe's own answer, never the run's. | `packages/server/src/automation/manifest/manifest.ts`; `packages/server/src/automation/fire/fire.ts` |
| **capability** | A typed enrichment contract — input kind to versioned output schema (`ocr@1`, `faces@1`, …) — that apps consume by contract only, never by implementation. Nine ship today across the two domains. | `packages/server/src/enrich/capability-registry.ts` |
| **engine profile** | A named bundle of capability + engine + parameters that policy points at: the immutable `built-in` deterministic engine, or a member-created delegate binding a harness, model, config pins and prompt revision. The unit derived results are keyed by. | `packages/server/src/enrich/engine-profiles.ts`; prefs `enrich.profile.*` |
| **egress class** | Where an engine's work happens — `on-device`, `gateway` (the member's own infrastructure, not egress), or `provider`. Computed from the engine, never user-set, and the axis egress consent is keyed on. | `packages/vault/src/enrich/egress-consent.ts`; `packages/server/src/enrich/engine-profiles.ts` |
| **policy cascade** | The scoped enrichment rules — vault, domain, collection, item — stating per capability whether it is enabled, which engine profile runs it, and its trigger. `NULL` inherits, most specific wins, and one resolver folds it inside the gate. | `packages/vault/src/enrich/policy-rules.ts`; `packages/server/src/automation/fire/enrich-resolve.ts` |
| **design tokens** | Shared colors, type, spacing, icons across desktop/web/mobile. | `packages/design` |
| **receipt** | (1) Vault write receipt id from consent pipeline; (2) repo `receipts/issue-N-*.md` for issue work. | context-dependent |
| **prefs** | Device-level gateway preferences in `gateway.db` — harness, theme, etc. Not the vault owner identity. | `GatewayDatabase.prefRows()` / `setPref()` |

## Hosts and clients

| Term | Meaning |
| --- | --- |
| **desktop** | Electron host; controls the detached local gateway by default and exposes an in-process test path; thin React renderer. `apps/desktop` |
| **web / PWA** | Installable Vite client; it does not host a gateway, and connects through a gateway-served origin or ticket-only Iroh/WASM. `apps/web` |
| **mobile** | Expo client; HTTP/tunnel to a gateway; native Photos/Agenda/Docs/People over replica (Docs and People rebuilt to the v12 handoff, #821). `apps/mobile` |
| **client package** | Shared React shell + browser-safe HTTP. `packages/client` |
| **daemon** | Standalone `centraid-gateway` process under a `dataDir`. |

## Seats and byte custody (blueprints, [blueprint-seats.md](blueprint-seats.md))

| Term | Meaning |
| --- | --- |
| **seat** | A client's role in byte custody — `origin` (mobile: content born + cached here), `custodian` (desktop: gateway is local), `viewer` (web/PWA: meaning replicated, bytes on request). Orthogonal to `compact`: never branch custody on form factor or layout on seat. |
| **byte-bearing / record-only** | The two blueprint classes. Record-only apps (tasks, agenda, people, tally) are rows the replica covers fully offline; byte-bearing apps (photos, docs; notes/locker via attachments) need the custody triple, backup engine, and pin/download engine. |
| **custody triple** | `local-only` (device only — the danger state, tile line `on this device only`), `backed-up` (device + gateway), `remote-only` (gateway only, tile line `on the gateway`). Canonical shape: `apps/mobile/src/apps/photos/timeline-model.ts`. Web's `TileMediaState` is the paint pipeline, not a custody model. |
| **origin act** | A frame-owned capture capability apps register into — camera, scanner, share-sheet-in, notifications, autofill. One door per capability, never per-app re-implementations. |
| **north star** | The incumbent product a blueprint deliberately mimics (Photos → Google Photos, Notes → Apple Notes, Docs → Google Drive, Tally → Splitwise, Tasks → Todoist, …) so switching costs an owner nothing. Table in [blueprint-seats.md](blueprint-seats.md). |

## App admission (blueprints, [blueprint-seats.md](blueprint-seats.md#app-admission-contract))

| Term | Meaning | Code |
| --- | --- | --- |
| **designed state** | One honest state an app's design calls for — the app's own `app.json#states.designed` entry, not a state some other app happens to draw. Its opposite is an `excluded` state: one the design makes structurally unrepresentable, costing a reason and a citation. "Nobody has built it yet" is neither; that is a gap. | `packages/blueprints/apps/<app>/app.json`; `packages/blueprints/src/app-states.test.ts` |
| **canonical designed states** | The closed seven every UI blueprint partitions into designed and excluded — `dayone`, `pending`, `offline`, `stale`, `conflict`, `parked`, `denied`. Closed by doctrine, so an eighth arrives by amending the list, never by one app inventing it. | `CANONICAL_DESIGNED_STATES` in `packages/server/src/engine/registry/manifest.ts` |
| **admission contract** | The six named claims an app satisfies to sit in the shell — valid manifest, engine conformance, designed states owned or tracked, seats owned or tracked, pending projection registered, placement declared or structurally absent. The shell half of admission; TESTING.md's contract of the same name is the evidence half (which tier falsifies which claim). | [blueprint-seats.md](blueprint-seats.md#app-admission-contract); `tests/matrix.json`; `scripts/test-report/validate-app-axes.mjs` |
| **engine registry** | The one roster of the shared engines, each row naming its source, its property flow, its mutation seed, and whether it takes a column in the app × engine grid. The registry and that grid's columns are one fact seen twice, held equal by the validator. | `tests/matrix.json#engineRegistry`; `packages/blueprints/apps/_shared/` |
| **consent ledger** | The eight permission layers a member's answer can sit in, each naming where it is enforced, its refusal grammar, which seats it binds, and the adversary proof that it refuses — or the open issue admitting it has none. | `tests/matrix.json#consentLedger` |

## Adversary lanes (testing, [TESTING.md](../TESTING.md))

The suites whose job is to produce evidence the author did not choose. Each word names one lane, so "the fuzz lane found it" and "the join lane owns it" are precise claims about which rig ran.

| Term | Meaning | Code |
| --- | --- | --- |
| **fuzz lane** | Seeded, iteration-counted mutation fuzzing over the parsers that eat bytes somebody else chose, with no fuzzing dependency in the repo. Findings partition into a register of recorded, unfixed defects and everything else, which fails the run. | `scripts/fuzz/`; register `scripts/fuzz/known-findings.json`; nightly `fuzz-parsers` |
| **join lane** | The rig that puts N seats on **one** gateway and makes them speak the real tunnel wire — grant delivery, revocation severance, parked lifecycle, version skew. Three seats on the PR path, five nightly; the laws are the same at every N. | `packages/server/src/serve/protocol-join-lane.test.ts`; nightly `protocol-join` |
| **time zoo** | The suites re-stating the civil-time laws over the calendars that are not ordinary — negative and half-hour DST, the leap day, the 53-week ISO year, a recurrence read from a zone other than the one it was defined in — across adversarial zones rather than one representative one. | `packages/server/src/automation/fire/time-zoo-*.test.ts`; `packages/core/src/time/time-zoo-*.test.ts` |
| **device-only claim** | A fact about the **operating system's** behaviour rather than the product's logic, so no unit, component, or Playwright layer can falsify it. Each is written to be adoptable verbatim as a matrix cell owner, and only the `origin` seat can hold one. | roster in `tests/agent-e2e-mobile/README.md`; the flow each row names |
| **provisional-local floor** | A mutation floor seeded from a local Stryker run rather than CI, set at (local measured − 11) and re-seeded to (CI measured − 3) by the first green nightly that measures it. The exception the file declares at the number, never a silent one ([decisions.md](decisions.md#adversary-lanes-and-provisional-evidence-839)). | `tests/mutation-floors.json` |
| **pin** | A characterisation test asserting the current, **wrong** behaviour and naming the ruling or documented sentence it contradicts, so a fix goes red and is revisited deliberately. A defect a lane found but is not chartered to fix is pinned, never tolerated quietly and never deleted. | `scripts/fuzz/replay.test.mjs`; the `test.fails` case in `packages/vault/src/share/commons-sim.test.ts` |

## Projection doctrine (apps, [#834](https://github.com/srikanth235/centraid/issues/834))

Store once, draw in the asking room's shape. These four words are how the apps talk about each other's facts; using them loosely is how a second copy gets written.

| Term | Meaning | Code |
| --- | --- | --- |
| **projection** | A read-only re-shaping of rows another app or another table owns, drawn where it is useful and never copied. A birthday stays canonical on the person; Agenda projects it. An app that stores its own copy of another app's fact has left this doctrine, whatever the screen looks like. | `packages/blueprints/apps/agenda/queries/day-context.ts`; `pending-projection.ts` per app |
| **day context** | The three costless layers a calendar day learns from elsewhere — birthdays (People), due tasks (Tasks), holidays (subscribed) — answered by one read-only Agenda query over a bounded date range. **A layer is not a calendar**: it carries no hue dot, nothing writes to it, and it never takes grid shape. | `apps/agenda/queries/day-context.ts`, `apps/agenda/day-context.ts` |
| **ribbon / shelf** | The two shapes day context is allowed to take. A **ribbon** is a day-header annotation for a fact with no time cost (`🎂 Dana`, collapsed to `2 birthdays`); a **shelf** is one collapsed line above the day's first hour (`3 due`) that opens to names and hands off to the owning app. Never an event row, never a grid chip, never a badge. | `apps/agenda/components/DayContext.tsx` |
| **re-entry** | How a room lets someone back in after they fall behind: one live occurrence for a repeating task with its elapsed periods collapsed beside it (`missed 4 · next is Friday`), a group that offers to catch up, and `won't do` as a respectable exit. The house alternative to a wall of shame. | `packages/core/src/time/recurrence-collapse.ts`; `apps/tasks/components/Board.tsx` |

## Owners (gateway, #726)

The current owner model supersedes the five-layer **member/role** vocabulary from [#599](https://github.com/srikanth235/centraid/issues/599); see the [current ownership decision](decisions.md#ownership-sharing-and-peer-transport). This section is the live model.

Authorization collapses to **two questions, neither a role**:

1. **Whose device is this?** Enrollment binds a proved iroh EndpointId to an **owner** — the human. Devices are pure bindings `(endpoint_id, owner_id)`.
2. **Does that owner own this vault?** A vault has **exactly one owner**, recorded in `vault_owners(vault_id PRIMARY KEY, owner_id)` — the primary key IS the invariant, not check code. There is no partial authority over a vault, because there is no such thing as being partly its owner.

The five layers still apply, corrected at L3:

- **L0 custody** — the gateway box, landlord bearer, an exported backup recovery kit.
- **L1 authentication** — devices proving iroh EndpointIds — the only cryptographically provable layer.
- **L2 principals** — owners and agents.
- **L3 authorization** — was `(member, vault) → role`; now `vault_owners(vault_id, owner_id)`. Ownership, not a lattice.
- **L4 attribution** — the journal records the acting owner (and the agent when one acted) whenever a principal is known; scheduler-fired automations carry none.

**D2 vocabulary (binding):**

- **owner** — the one person a vault belongs to. Exactly one, forever, across migrations.
- **host** — the gateway whose disk and process a vault currently sits on. Hosting is a location, not an authority.
- **gateway owner** — the person whose machine it is. One per gateway — the only asymmetry in this model.
- **mint** — to create a vault and assign its owner. Authority ends at creation, like a mint's authority over a spent coin; ownership is the new owner's from that moment and never returns. Auto-founding is simply the first mint, run automatically (#603); the _Add someone_ mint ceremony for further owners ships in #726 P1.

**Minting is not owning, and neither is hosting** — what the gateway owner can and cannot do to a vault minted on their machine:

| Can | Cannot |
| --- | --- |
| Stop hosting it | Erase it |
| See that it exists and what it costs in disk | Form, accept, or revoke its links |
| Run the process that serves it, and sign unattended on its behalf | Enroll a device to it, or act as its owner to any app, agent, or peer |
| Back up _their own_ vaults | Include a vault they don't own in their backup |

Enforced structurally by the `owner_id` relation — no role to escalate, no "minted by" column granting anything. Full posture, including the half that is easy to soften — hosting confers no authority over the relationship, but it does confer the ability to act — is in [SECURITY.md](../SECURITY.md).

**Forbidden words: guest, tenant, hosted vault.** The first two smuggle back a hierarchy this model deleted — a vault minted on someone else's machine is a full sovereign vault, not a lesser one. "Hosted vault" collides with `Hosted`, which already names the storage-provider custody copy.

Two things people expect to be roles are not:

- **Device attenuation** — `grant_profile_json` on the device row, a capability mask, orthogonal to ownership, untouched by #726.
- **Writability, as blueprints see it** — `scope.canWrite` keeps its exact shape; an owned vault is writable, while a commons membership's `read` / `read+write` capability governs commands to its shared container.

Invariants:

- **No vault types.** Every vault has one owner; "personal" and "shared" are descriptions, never a `type` column or a conversion flow.
- **Narrower vaults over finer authority.** Finer-grained permission wants (per-item visibility, a role tier) are answered with another vault, not with row-level ACLs — the fence against Model B drift (#599), still standing.
- **Minting splits by target.** Any owner may **self-pair** a new device into the vaults they already own from an already-enrolled device. Inviting _another person_ into your own vaults is **deleted**, not weakened: `resolveInvitation` refuses with `owner_vaults_only` — a person gets a vault of their own, and that mint flow ships in #726 P1.
- **Two removal verbs, at different layers.** _Revoke a device_ (`EnrollmentStore.revoke`) tombstones one binding and leaves the owner and their other devices intact. _Remove an owner_ (`OwnerStore.remove`) is refused while they still own any vault — the ownership analogue of the old last-admin guard, structural instead of counted.
- **Auto-founding** enrolls the founding owner with no prompt (#603): a fresh data dir gets **Personal**, recorded in `vault_owners` for that owner in one transaction. `Shared` is created later only when an owner explicitly asks for another vault; nothing on its record says "sharing".
- **Sharing is residency, not filtering.** Data crosses only by projection into another vault, under a standing **grant** (#825): a `view` grant re-projects the origin's rows on change, and commons reconciles a circle's container into every joined member's vault as the `edit` strategy. No one queries another person's vault.

One deliberate mapping, simplified by #726: a device's trust (`full`/`readonly`) is a **capability mirror**, not ownership. Ownership is binary — an owner owns a vault or does not, no partial grade — so every enrolled device lands `full`; device attenuation is the separate `grant_profile_json` mask, orthogonal to trust. Since [#883](https://github.com/srikanth235/centraid/issues/883) that trust is a `device`-principal row of the one authority table rather than a `consent_device.trust` column — `consent_device` is identity, the plane carries the answer.

## Sharing: the grant plane, commons, links, and the peer plane (#726, #731, #825)

The vocabulary for what a member shares with whom, how those bytes reach an audience vault, and how two owners' gateways reach each other when the vaults are not co-hosted.

| Term | Meaning | Code |
| --- | --- | --- |
| **grant plane** | The one app-agnostic infrastructure every app shares over: the grant table stating the member's sentence, the fulfillment table carrying per-audience-vault delivery, and the engine that resolves an audience vault through the host's own registry. A plane, not a feature — an app gains sharing by naming a subject type, never by growing its own transport. | `packages/server/src/serve/grant-fulfillment.ts`, `share-coordinator.ts` |
| **grant** | A standing member **answer**: this **principal** may VERB this **subject**, until revoked. `granted` and `declined` are both rows — a refusal is an answer, not an absent grant — and a grant on a container covers its contents now and later. One authority table holds every one of them ([#883](https://github.com/srikanth235/centraid/issues/883), succeeding [#825](https://github.com/srikanth235/centraid/issues/825)'s audience × capability shape); it is the unit every share surface reads and writes, and the device and enrichment-egress answers are rows of it too. | `share_authority` |
| **principal** | The side of a grant that **holds** authority: `person \| circle \| harness \| device`, a closed union with `app` reserved. Never the subject side, and never a role — a grant's enforcement locus is derived from the kind (local for a harness, the boundary for a device, remote for a person or circle) and is never stored ([#883](https://github.com/srikanth235/centraid/issues/883)). | `share_authority.principal_kind` |
| **fulfillment** | Per-audience-vault delivery state under one grant — `awaiting_channel`, `syncing`, `delivered`, `remove_sent`, `removed`. Mechanism, never meaning: a member reads grants, never fulfillment rows. | `share_fulfillment` |
| **channel** | How to reach a party — the reframed vault link, a property of the party with states `invited`, `live`, `severed`. A grant to an unlinked person mints the invitation as its first fulfillment step, so a channel is never a ceremony the member completes first. | `share_party_vault_binding` + `vault_links` |
| **subject** | The shared thing a grant names: an album, folder, document, or asset. Never `people.person` — a person is the audience side of a grant. A subject type with no fulfillment answer cannot be offered ([#750](https://github.com/srikanth235/centraid/issues/750)). | `share_authority.subject_type` / `subject_id` |
| **commons** | A circle-backed container whose domain rows and blobs reside in every joined member's vault. Consent lasts with membership, not a clock; derivatives remain seat-local. | `packages/vault/src/share/commons.ts`; `share_circle_grant` |
| **circle** | The sharing audience and roster (`social_circle` + `social_circle_member`). Implicit circles belong to one container; only named circles such as Family or a Tally group are deliberately reusable. | `packages/vault/src/schema/domains-social-knowledge-media.ts`; `share-commons.ts` |
| **steward** | The member gateway that serializes one commons' signed intents into its monotonic operation log. An ordering/availability role, never ownership. | `share_commons_op`; `executeCommonsCommand` |
| **compile** | Reconcile vault-resident grant/roster truth into projection, blob custody, roster, lineage, checkpoint, and cursor mechanics. Restore recompiles; it does not reconstruct consent from gateway caches. | `compileCommons` |
| **edge** | A row in `share_edges`: one snapshot crossing of a fixed item set between two vaults **one owner holds** — `kind='add'` keeps the origin item, `kind='move'` removes it after target receipt. Placement, not sharing: a cross-owner pair is refused (`cross_owner_give_retired`, #825), so an edge never reaches another person. Live lending was shipped in #726 and deleted in #731. | `packages/server/src/serve/gateway-schema.ts`; `routes/edges-routes.ts` |
| **closure** | The origin-side, read-only serialization of everything one item set depends on — pooled content items, derivatives, and a blob manifest, deduped once across the set — packaged as a `WireClosure`. **Internal fulfillment transport only** since #825: a closure is what a grant's engine re-projects and what a same-owner placement carries, never a frame a peer may ask for. Cross-vault foreign keys are absent from the read, never merely nulled at the far end. | `packages/vault/src/share/closure.ts`, `read-closure.ts` |
| **projection** | The audience-side half: writing a closure into the audience vault inside one `BEGIN IMMEDIATE`, sha-deduping through `core_content_item.sha256 UNIQUE` and recording `core_share_origin` lineage. Under a live `view` grant it is re-run origin-authoritatively on every fulfillment pass (scrub, then project the current closure), which is how an origin edit follows (#825). **Projection is ingest** (D11): a projected row runs through the identical post-arrival door an authored row takes (place re-linking, enrichment enqueue), keyed by vault entity type and never by app id, so vault core cannot branch on which app owns the row. | `packages/vault/src/share/project-closure.ts`, `projection-ingest.ts` |
| **link** | A mutual, approved relationship between two vaults. Since #825 it is the **channel** a grant is delivered over, not an edge's permission slip: `judgeEdgeCrossing` still consults it, but a linked (cross-owner) pair is now REFUSED at `POST /centraid/_gateway/edges` rather than allowed. One table, `vault_links`, covers both localities: two vaults on one machine (each owner's device approves its own side) and two vaults on different gateways (minting the link ticket is one side's act, redeeming it is the other's, so a redeemed link lands approved on both sides at once). Same-owner edges need no link row at all — owning both vaults IS the authorization. A settled link also reconciles a `share_party_vault_binding` row into each mounted side's vault (#821), which is how an app reads "this person is linked" without touching the gateway plane. | `packages/server/src/serve/vault-links-store.ts`, `vault-link-row.ts`, `link-crossing.ts`, `link-party-bindings.ts` |
| **route** | The cached `{endpointId, relayHints, assertedAt, signature}` for a peer vault — how to dial that vault's _current_ gateway. **ONE row per vault** in `vault_routes` (#750): its mere presence means the vault lives elsewhere, and every link to that vault resolves through it, so one signed assertion re-routes them all. Replaceable cache, never identity: every durable reference (grants, edges, receipts, the link itself) binds `vault_id`, never an EndpointId; identity (public key, label) lives in `vault_directory`. A route is re-asserted, signed by the vault's own P1 identity key, whenever the endpoint keypair rotates or the vault moves hosts — pushed in production by `serve/peer-route-announce.ts` at endpoint start and on the peer-plane sweep tick. | `vault_routes`/`vault_directory` in `serve/gateway-schema.ts`; `serve/peer-route-assertion.ts`, `serve/peer-route-announce.ts` |
| **peer** | The gateway on the other end of a cross-machine link, reached over its own `/centraid/_peer/*` control-plane tier — authenticated by the proved link (endpoint + vault signature), never by device pairing. Since #825 a peer reaches only the **link ceremony**, the **route assertion**, and the **commons rail** (its own bootstrap/command/blob/invite frames); edge negotiation, closure fetch and the ranged blob pull retired with copy-as-share and answer `not_found`. No owner-tier surface is reachable from this lane. See [SECURITY.md](../SECURITY.md#the-peer-plane-726-p3). | `packages/server/src/routes/peer-plane.ts`; ALPN `centraid/gw-link/1` in `packages/tunnel/src/protocol.ts` |

`share_edges` succeeds `placement_intents` outright (dropped, not migrated — both were pre-1.0), and `vault_links` merges local and remote locality into one relationship. **Edge, closure and projection are mechanism, not product**: an edge is same-owner placement, and closure/projection are the transport beneath a grant's fulfillment — never acts a member performs or words a surface says. Commons command routing is the `edit` fulfillment strategy under a grant, not a separate product concept ([decisions.md](decisions.md#sharing-v1--the-grant-plane-825)).

Two retired vocabularies, historical only. **lend** — #726's live edges, borrowed stores, leases, budgets, and write-back machinery were deleted in #731; do not use “lend” or “borrowed scope” for commons, since a commons member holds their own full resident copy. **give** — the one-time receiver-owned snapshot is retired by [#825](https://github.com/srikanth235/centraid/issues/825), code and all. Its verbs answer `not_found` (the peer `edge/give`, `edge/closure/:id`, `edge/deny` and `blob/chunk` frames; the gateway `edges/pending` and `edges/:id/answer` verbs), a cross-owner pair on `POST /centraid/_gateway/edges` is refused with `cross_owner_give_retired`, and the transport that carried it — the give client, the remote reconciler, the audience-side blob pull, the `await-answer`/`deliver-refusal`/`pull-blob` outbox kinds, and the per-link "receive gives" preference — is deleted. A gateway upgraded across the retirement has its leftover queued obligations drained once at open, each ending its edge terminally rather than retrying a withdrawn verb. The word survives only in receipts and changelogs and nothing replaces it. Say **grant**.

## Forbidden / discouraged synonyms (broader)

| Avoid | Prefer |
| --- | --- |
| "app builder" / "personal app builder" for the product | **superapp** — #799 retired the authoring and serving planes; the product is one shell wrapping the bundled first-party apps. "Builder" survives only for the **automation compiler** (the headless compile harness in [blueprints](../packages/blueprints/README.md)), never for the product |
| "platform" for Centraid | **superapp** — a platform hosts other people's software; Centraid ships its own and nothing else |
| "third-party app" / "user-built app" / "generated app" | **system app** — there is one kind of app and this repo ships all of them. `consent.app.origin` still declares `CHECK (origin IN ('installed','generated'))`, but nothing writes `'generated'` since #799 — it is a dead schema value awaiting a migration, not a product noun |
| "served app" | Retired vocabulary (#799). An app used to be renderable as an **opaque, same-origin iframe document** the gateway baked and served under the blueprint CSP. The mobile WebView cover, the desktop/PWA iframe host, the builder that authored for it, and the gateway's UI-byte serving are all gone; the gateway serves an app's **data**, never its bytes. Say **system app** (or **inline app** for the render mechanism) |
| "code store" for where an app's UI lives | there isn't one — bundled app UI compiles from `packages/blueprints/apps/` into the client release. `vault/<id>/code/` holds **cloned automation sources** only |
| "enrichment service" / "ML sidecar" | **recognition automation** — the handler itself owns model execution |
| "database" for the personal ontology | **vault** (`vault.db` is the file) |
| "server" for the product backend | **gateway** |
| "template app" after install | **app** (blueprint is the shipped source) |
| "plugin" for declared handlers | **handler** / **query** / **action** |
| "identity.sqlite" / multi-user gateway identity | vault owner _is_ the user (#280) |
| "role" for what a device may do | **ownership** (does the acting owner own this vault) plus **device attenuation** (`grant_profile_json`) — #726 deleted the role lattice; trust remains proved identity only |
| "share target" / "default share target" for where a placement lands | **audience vault** — #726 P0 deleted the default share-target pointer (`share-target.ts`, `defaultShareTargetVaultId`, mobile `frame.shareTarget`) outright; the destination is a picker over the caller's own mounted, writable scopes, never a remembered default |
| "placement_intents" for the sharing table | **`share_edges`** for same-owner add/move placements; `share_authority` for every standing answer the member has given, shares included (#825, unified by #883), `share_circle_grant` for the commons control record |
| “lend”, “borrow”, “borrowed scope” for current sharing | **commons** for co-owned resident data, which is the `edit` fulfillment strategy under a **grant**. Lending is deleted historical vocabulary. |
| "copy-as-share" / "give a copy" / "give" as a member-facing act | **grant** — a share is standing, not a snapshot handed over (#825). Closure read and projection remain internal **fulfillment** transport and are never named on a surface |
| "link ceremony" as something the member does before sharing | **channel** — minted by fulfillment. A grant to an unlinked person parks at `awaiting_channel` and sends the invitation itself (#825) |
| "space" / "spaces" in user-facing copy | **vault** / **vaults** — one word, everywhere the owner can read it. The sidebar switcher ([`gatewaySwitcher.ts`](../packages/client/src/react/shell/gatewaySwitcher.ts), eyebrow "Vaults", aria-label "Vaults") lists **vaults only** — flattened across every registered gateway (#665) — changes the active/default vault pointer (switching gateway too when the vault is hosted elsewhere), and is always present so Add vault remains reachable. The stem's identity head is the switcher's only anchor and reads "&lt;vault&gt; on &lt;gateway&gt;. Switch vault." ([`Stem.tsx`](../packages/client/src/react/shell/Stem.tsx), ⌘⇧G in [`App.tsx`](../packages/client/src/react/shell/App.tsx); the standalone `IdentityHead.tsx` was folded into the stem in #708); Settings → **Vault** ([`SettingsVaultScreen.tsx`](../packages/client/src/react/screens/SettingsVaultScreen.tsx)); Household → **Vaults** ([`HouseholdScreen.tsx`](../packages/client/src/react/screens/HouseholdScreen.tsx)); mobile switcher → **Vaults** ([`VaultsSwitcher.tsx`](../apps/mobile/src/screens/home/VaultsSwitcher.tsx)). Code identifiers were renamed to match on 2026-07-31 (#665): `Vault*` components, `vault`/`vaults` props, the `vault` settings-page id, `data-vault-id`, and the mobile `vaults.*` storage keys. |
| **gateway** as an end-user _management_ noun | there isn't one (#665). **Every noun the owner manages is a vault**; a gateway is plumbing. Each surface has exactly one job: the switcher **switches** vaults (no overflow menus, no management affordances); a vault's own Settings → **Vault** page manages that vault, including **Disconnect** under "On this device" — offered only when the active vault sits on a _remote_ connection, since the primordial `local` gateway is this machine; and host plumbing (Test connection / Rename / Remove) lives in the **Connections** section of Gateway → Components ([`SettingsDiagnosticsScreen.tsx`](../packages/client/src/react/screens/SettingsDiagnosticsScreen.tsx)), the one surface where a machine is legitimately the subject and the word "gateway" may appear. There is deliberately **no** Settings → Gateways page. |
| "remove the gateway" in _disconnect_ copy | **disconnect the vault** — the primitive (`removeGateway`) is connection-wide, so the confirm NAMES every sibling vault that goes with it and promises the vaults survive on their host ([`disconnectConfirmCopy`](../packages/client/src/react/shell/gatewayRegistry.ts)). Per-vault forget does not exist; it would be a server-side grant revocation. |
| "user" / "account" for a household principal | **owner** — there are no accounts, passwords, or sessions; an owner is a principal on the enrollment plane (#726, superseding #599's "member") |
| "member" for a vault's principal | **owner** — one owner per vault. “Member” remains correct only for a **circle/commons roster**, never for vault ownership. |
| "token" for the pairing artifact | **ticket** — one-time, burns on redemption (#555 removed bearer redemption) |
| "founding ticket" / "founding ceremony" / "recovery-kit ceremony" / "uninitialized gateway" | **auto-found** — #603 deleted the founding plane entirely. A gateway is never zero-vault, and "ticket" now means the **pair ticket**, unqualified |
| "found a vault" as something a **user** does | the user **creates** a vault (an admin act on a running gateway); only the **gateway** founds — itself, once, on a fresh data dir |
| "Approvals" or "Inbox" for the unified owner surface | **Notifications** (#665) — "Inbox" reads as mail, and this stream is news plus things needing action. Use **decision** when referring specifically to an item waiting on the owner, and **notice** for a durable non-decision update. |
| `com.centraid.*` identifiers | **`dev.centraid.*`** ([identifiers.md](identifiers.md)) |
| "confirm / reject" as the pair of things an owner does to a **proposal** | **answer** — one verb with three members: `confirm`, `reject`, `dismiss` ("reviewed, deliberately left unnamed"). A pair could not finish a review queue: an owner with no way to say "I looked and I am not naming this" only ever has Skip, and a skipped proposal returns for ever. See [`media.answer_face_proposal`](../packages/vault/src/commands/enrich.ts) and the shared queue model [`triage-session.ts`](../packages/blueprints/apps/_shared/triage-session.ts) (#712, #725). |
| **deleting** a rejected proposal row | a rejection is a **state** (`review_state`), never a `DELETE` — a deleted row remembers nothing, so the enricher's next run proposes the same thing again and the owner answers it for ever. Suppression is one `WHERE review_state = 'proposed'` in [`enrich-publishers.ts`](../packages/vault/src/ingest/enrich-publishers.ts) (#712). |

## Inconsistencies (known dual vocabulary)

These pairs appear in code and docs for historical reasons. Prefer the **canonical** term in new writing; the other is tolerated in existing APIs until renamed with a migration.

| Dual | Prefer | Tolerate | Notes |
| --- | --- | --- | --- |
| host / gateway | **gateway** for the product process | "host" in host-agnostic package comments | Desktop "hosts" the embed; the product backend is the gateway |
| profile / gateway id | **gateway id** in multi-gateway switcher | "profile" in older settings paths | Same durable folder under `gateways/<id>/` |
| chat / conversation | **conversation ⊃ turn ⊃ item** | "chat" only in UI copy | Ledger model forbids "chat" as the technical term |
| template / blueprint | **blueprint** for shipped source | "template" in gallery UI | After install it is an **app** |
| server / gateway | **gateway** | HTTP "server" for the listener socket |  |
| Approvals / Inbox / Notifications | **Notifications** in UI labels, docs, wire names, and identifiers | `Approvals*` file/component names, the `approvals` route kind, and mobile nav routes | Approvals → Inbox in #647, Inbox → **Notifications** in #665 (copy, identifiers, `/_vault/notifications` routes, `notifications_notice` table). The remaining `Approvals*` identifiers await a mechanical rename |
| space / vault | **vault** everywhere — copy, docs, and identifiers | none | Copy swept, then identifiers mechanically renamed on 2026-07-31 (#665): `Space*` → `Vault*`, `space`/`spaces` props → `vault`/`vaults`, settings-page id `"space"` → `"vault"`, `data-space-id` → `data-vault-id`, mobile `spaces.*` storage keys → `vaults.*`, and the mobile device-local registry (`lib/spaces.ts`) → `lib/vault-links.ts` with `VaultLink` symbols (distinct from `lib/gateway.ts`'s server-side `listVaults`/`VaultRow`) |

**Mechanical vs judgment:** v1 is mechanical for exact known-bad literals in user-facing TSX under `packages/client` and bundled blueprints (`bun run test:qualities`). Ordinary-word exceptions such as the Tasks app's workflow “Inbox” live in the A4-governed `tests/quality/copy-allowlist.json`; broader prose and dynamic copy remain judgment on **word choice**, but not on **length** — concision is ruled by [DESIGN.md § Copy](../DESIGN.md#copy) (per-surface sentence budgets, the positional reassurance rule, and the banned-filler list) and enforced by the same U-series ratchet and allowlist ([#805](https://github.com/srikanth235/centraid/issues/805), [decisions.md](decisions.md#copy-governance-805)). This glossary governs which word; DESIGN.md governs how many.

## Related

- Runtime model detail: [ARCHITECTURE.md](../ARCHITECTURE.md)
- Identifier table: [identifiers.md](identifiers.md)
- Decisions: [decisions.md](decisions.md)
