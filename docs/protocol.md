# Protocol and feature contracts (C1–C4)

Policy for gateway ↔ clients (desktop, web, mobile, and the browser extension in [#462](https://github.com/srikanth235/centraid/issues/462)). Settled with issue [#468](https://github.com/srikanth235/centraid/issues/468). **C1–C3 must land before #462** creates the first real old-client / new-gateway skew (C4).

## C1 — Two contracts

### (a) Protocol contract — always

Wire schema changes **never break parsing** in either direction:

| Rule | Detail |
| --- | --- |
| New fields | Optional with defaults on the reader |
| Optional → required | Forbidden without a coordinated floor bump |
| Removed fields | Stay accepted (ignore) until the floor drops them |
| Types | Never narrow (string ↛ enum of fewer values; number ↛ int-only) without a floor |
| Discriminants | Add new union members only as unknown-tolerant or behind a capability |

The handshake and parsers stay green across versions even when a **feature** is unavailable.

### (b) Feature contract — per feature

New product capability requires a **gateway capability flag** (or equivalent version/capability surface).

- Old gateways / clients show a clear **"update the gateway"** / **"update the app"** wall.
- **No fallback paths.** No degraded modes. No defensive branches scattered through feature code that pretend an old host can half-run the new flow.
- Capability detection happens in **exactly one place** (central map / handshake), not re-derived in every screen and route.

**Decided:** no-fallback is confirmed policy, not a proposal. Both ends are under one maintainer pre-1.0; every fallback branch is permanent review tax.

### How the two halves interact

```
parse always succeeds  →  capability check  →  feature runs OR single update wall
```

Never: parse succeeds → feature code branches into three historical shapes.

### Replica-specific correctness fields

The offline replica extends the additive wire contract with fields that are safe for older readers to ignore and required by newer readers when present:

- `commitId` groups all change rows from one canonical write transaction; servers page through complete groups and expose `hasMore` for bounded catch-up.
- `rowVersion` is the current-epoch change sequence for a row. Clients apply upserts and deletes monotonically, ignoring stale replay data.
- `baseVersions` on an intent is an optimistic concurrency precondition. A stale precondition produces a structured `conflict` outcome, not a generic transport failure, and does not dispatch the action.
- `coverage` distinguishes a readable partial preview from a complete replica; `durability` distinguishes persistent storage from an in-memory fallback. These values are status/result metadata, not permission signals.
- `truncated` and `appliedLimit` on a read result say that the read's own window cut the answer short, and name the window that produced the rows. They answer a different question from `coverage`, which is about how much of the library this device holds: a fully bootstrapped replica still truncates a 5,000-row roster at the 1,000-row default. Both are absent when nothing was cut off, and `acceptTruncation` on a read request is the caller declaring it will take the default window (#922). All three are optional additive fields — an older reader ignores them and behaves exactly as it did — so they do not bump the protocol version.

The browser outbox migration is additive: it never drops the pending-intent store. Settling an intent atomically records its sanitized outcome and removes the queued input, so conflict details survive a reload without retaining the original payload.

### Commons stream and cursor contract (#731)

Commons does not add a second device replica dialect. A device still holds one ordinary physical replica cursor for each vault, and that cursor covers all rows in the vault even when they came from several circle grants. The commons plane additionally persists a logical applied offset keyed by `(grant_id, member_vault_id)`. That offset is not a transport credential and does not authorize a row; it only says which monotonic operation sequence that member vault has applied.

Each grant has its own steward-serialized sequence. Commands and control changes (`member_added`, `member_removed`, `capability_changed`, `grant_revoked`, `delete`, and `steward_transferred`) share the same ordering. Therefore one vault participating in several groups has one physical replica cursor plus one logical offset per grant; there is no vault-global order between unrelated groups and no cursor that coordinates their writes. Writers coordinate only through the relevant grant's steward.

Deterministic apply rules:

- apply only the next sequence after the member's current logical offset; duplicates at or below the offset are no-ops;
- a gap does not skip forward — fetch the missing tail or re-bootstrap;
- bootstrap is the latest complete closure checkpoint at sequence N followed by operations greater than N, never a from-zero replay;
- an operation outcome and its signature/attribution fields are immutable for that `(grant, sequence)`;
- the domain mutation and cursor advance settle atomically at the member vault;
- derivative rows are absent from the closure and stream, so each member's local recognition pipeline remains authoritative.

Catch-up is proportional to what changed (#750 invariant 7), because it ships COMMANDS, not rows. A member whose offset sits contiguously on the retained op chain receives an **increment** frame — the chained ops since its offset, the new receipts/replay rows, the roster-sized control refresh, and a manifest of the content-addressed bytes those commands claim by sha. The member RE-EXECUTES that operation tail against its own vault. Two properties make re-execution converge: the steward invokes every Commons write under the seed `commons-replica:<grantId>:<sequence>` and the replica re-invokes under the same seed, so `ctx.newId()` mints identical row ids on both sides; and a tail must be contiguous from the member's own cursor to the steward's head. Because the tail is the payload, the steward never walks or projects the closure to answer a sync-with-changes.

Increments verify through the same hash-chain machinery, anchored at the member's own proven head (which chains back to the last signed checkpoint); they carry no state digest of their own — the next full re-baseline re-proves the whole state. Replay, the control projection, the op insert and the cursor advance are ONE transaction, and the cursor is the idempotency boundary: a redelivered frame whose head the seat already holds re-executes nothing. Any tail a replica cannot re-execute — an unknown command, a refused handler, a missing payload, app version skew — and any frame that does not fit it (wrong anchor, no prior projection, no replica executor) is _unusable_, not fatal: the caller falls back to the full frame. A chain that does not verify parks, exactly like a bad full frame. The full-closure frame is the ONLY destructive path and the one that repairs arbitrary state, so no operation can wedge a grant. It is paginated: a frame past the member's page budget travels as bounded slices of one serialized frame under a short-lived steward-side session. Blob chunks are authorized once per transfer session (a membership + closure proof at open), never per chunk. Checkpoints (the stored full closure on the grant row) are cut on the 32-op cadence or on an explicit forced checkpoint event, never on every compile, and a seat may stand at most one checkpoint interval of replayed operations on top of the state it last proved before it must re-baseline.

### One intent grammar (#750)

A member command that cannot execute at the moment it is composed becomes a durable intent. Three lifecycles could have named those states — the browser/native replica pending-write outbox, the commons intent row, and the edge/effect plane — and two of them are rendered to the same person in the same list (Tally shows a queued expense beside a parked one). They therefore speak ONE grammar: `share_commons_intent.status` uses the pending-write outbox's own words. The commons vocabulary is `queued | parked | denied | executed | expired | cancelled`; `queued`, `parked`, `denied` and `executed` mean exactly what the outbox means by them, and `expired`/`cancelled` are the outbox overlay's terminal presentation states. There is no commons-only `pending`. Two outbox states are deliberately absent rather than renamed: `sending` (the commons rail has no in-flight-on-the-wire state a seat can observe — a signed command is either settled by the steward or still queued) and `conflict`/`failed` (a commons refusal is always the steward's answer, carried as `denied` with a reason, including the stale-context classification). v0 renamed the column values in place; there is no compatibility branch for the old spelling.

An intent has exactly two answers and they belong to different people. The MEMBER withdraws their own with `POST /centraid/_gateway/commons/intents/<intentId>/cancel`, whose `WHERE status IN ('queued','parked')` guard is what keeps it from stomping an answer that already landed. The STEWARD answers someone else's with `POST /centraid/_gateway/commons/intents/<intentId>/decide` (`{actorVaultId, decision: "approve" | "decline", reason?}`, [#872](https://github.com/srikanth235/centraid/issues/872)); `actorVaultId` names the seat the answer is given FROM, and the gateway locates the intent's own seat — a durable intent lives only in the vault that composed it. Approving RE-ENTERS `executeCommonsCommand` with the member's own vault signature and its recorded `basedOnSequence`, so authorization, stale-context judgement, the ordered op and the fan-out are the one rail, never an "approved, therefore skip authorization" path. Declining settles `denied` with the steward's words and appends NO operation: a steward's refusal never reached the rail, so advancing the grant's sequence for it would log a command nothing executed. Both leave an `access_receipt` in the steward's audit band under `share.commons`. A member deciding their own request is refused by name — cancel is that verb — and an answer that arrives after the request already settled reports `decided: false` with the status that stands, because a late answer is not an error. The steward's settle is deliberately unconditional over a member's `cancelled`: the person who owns the commons gets the last word on what was in their queue.

The named identity fault rides the same refusal channel. When a member's presented vault identity key differs from the key its `share_party_vault_binding` pinned at join time, the steward refuses with a reason prefixed `commons_member_identity_changed` instead of "invalid vault signature": the seat is not malformed, it is a different vault wearing a known id, and the cure is re-invitation (rotation is deferred — see docs/decisions.md). The peer command door answers `403 refused` with that reason rather than a silent 404, and the member's sweep turns it into a notice that names re-invitation.

### Command→container routing is declared, not inferred (#750)

Which commands may write into a shared container, and which input key carries the container id, are DATA (`packages/vault/src/share/commons-routing.ts`), not string heuristics over the command name. Each row declares `(command, ownerSchema, inputKey, containerType, resolution, actable)`; `commonsGrantForCommand` consults only that table, and `commons-routing.test.ts` walks the real registered command schemas so a renamed input key or a phantom command fails the build instead of silently bypassing the rail. Routing and actability are separate facts: a routed-but-not-declared command reaches the rail and is refused by name, which is what keeps a write into a shared album or asset from landing privately and being reverted by the next compile.

Commons is pre-release (v0) and carries **no** wire compatibility surface: there is exactly one frame and command shape, every chain, digest, signature, and offset field is required, and a peer presenting anything else is a hard fault that parks the grant's sync with a named state. No optional-when-absent parsing, no version negotiation, no legacy-generation migration — a replica in an older shape is re-bootstrapped, not migrated. An implementation that cannot enforce the commons command/signature contract must present the single update wall; it must not fall back to snapshot sharing or an unsigned write path.

### Pair-ticket multi-vault redemption

A pair ticket is one-time onboarding envelope, not a gateway-wide grant. Its server-side invitation contains an ordered list of vault ids the owner already owns — no `role` field; access is ownership, not a grant per vault (#726 P0). Redemption creates the corresponding vault-scoped enrollments in one transaction and returns the first vault as the initial active vault. Newer responses additionally carry `vaultIds` and `vaults[]` with per-vault enrollment metadata; readers must default an absent list to the primary vault.

Clients may present one scan/paste flow, but they must retain the resulting vault bindings independently. Revoking or forgetting one vault must not remove the other bindings, replicas, cursors, or outboxes. The gateway remains only the transport/control front door; authorization is evaluated per vault.

## C2 — `COMPAT(name)` tagging

Every back-compat shim carries a machine-grepable comment:

```ts
// COMPAT(replica-epoch-v1): added 2026-07-01, drop when floor >= 0.4.0
```

| Required               | Meaning                       |
| ---------------------- | ----------------------------- |
| `name`                 | Stable id for the shim family |
| `added`                | Version or date introduced    |
| `drop when floor >= …` | When cleanup is allowed       |

**Ban:** untagged `??` / dual-path code that exists only for older peers. One `rg 'COMPAT\('` must produce the complete cleanup backlog.

## C3 — Wire-schema purity

Schemas are **structural declarations only**:

- No transforms, preprocess, or coercion inside the schema definition.
- Normalization is an **explicit post-validation pass** with a named function.
- Tagged unions use **discriminated unions** (one clear discriminant field), not ad-hoc optional field combinations.

Keeps generated clients, docs, and human readers aligned; prevents "schema that is really a parser."

## C4 — Order of work

Land C1–C3 (this doc + code that honors it on the handshake and any new cross-client fields) **before** extension pairing (#462). The extension is the first long-lived client that will lag the gateway in the wild.

## Three numbers on the wire (issue #512)

| Field | Role |
| --- | --- |
| `version` | **Product** semver — display / about only. Clients **must not** refuse connect because product strings differ. |
| `protocolVersion` | Wire protocol integer (CapVer-style). Mutual support window with `minSupportedProtocol`. |
| `minSupportedProtocol` | Oldest protocol this peer still speaks. |
| `capabilities` | Required feature flags (C1) — not product version. The experimental-gate keys `automations` / `connectors` ([#774](https://github.com/srikanth235/centraid/issues/774)) are the one optional, absent-tolerant pair: absent reads as off, and clients wall or hide the surface rather than probing routes. |

Handshake (`judgeGatewayInfo`):

```
ok iff peer.protocolVersion >= local.minSupported
     && local.protocolVersion >= peer.minSupported
```

Product skew (desktop 0.6 talking to gateway labeled 0.4) is **allowed** when protocol matches. Surfaces may skip shipping a product version without breaking connect.

Constants live in `@centraid/core/protocol` (`GATEWAY_VERSION`, `GATEWAY_PROTOCOL_VERSION`, `GATEWAY_MIN_PROTOCOL_VERSION`).

`GATEWAY_PROTOCOL_VERSION` and `GATEWAY_MIN_PROTOCOL_VERSION` both moved to `3` for the member→owner wire rename (#726 P0 — ownership replaces roles) — a hard floor bump, no COMPAT window; an old client sees the update wall. See [decisions.md](decisions.md).

`COMPAT(name)` cleanup floors should cite **protocol** (or capability name), not product semver, when possible.

### A second, independent handshake: the peer plane (issue #726 P3)

Two owners' gateways speaking directly over a link (see [ARCHITECTURE.md](../ARCHITECTURE.md#vault-ownership-and-sharing-726) and [SECURITY.md](../SECURITY.md#the-peer-plane-726-p3)) are not the gateway↔client relationship the numbers above govern, so they get their own version pair rather than reusing `GATEWAY_PROTOCOL_VERSION`: `PEER_PROTOCOL_VERSION` / `PEER_MIN_PROTOCOL_VERSION` in `packages/core/src/protocol/version.ts`, currently `1` / `1`. The two pairs are deliberately uncoupled — two linked gateways upgrade their peer protocol on their own owners' schedules, independent of whatever protocol version each speaks to its own clients.

`judgePeerHandshake` (`packages/core/src/protocol/peer.ts`) implements the same C1 two-contract shape as the client handshake, applied to a peer instead: parse always succeeds, then the mutual version window is judged, then either the link forms or the peer sees exactly one typed refusal (`protocol_refused`) — never a parse error, never a silent downgrade. It is a hard floor with no COMPAT shim, consistent with the rest of #726's no-fallback posture. One detail worth naming because it is easy to get backwards: the peer-plane link **ceremony** judges this version window _before_ a presented link ticket is looked up or touched at all, so a peer running an incompatible protocol cannot burn a real ticket by attempting redemption and failing the handshake.

Everything on `/centraid/_peer/*` is gateway↔GATEWAY. No client, phone, or browser ever speaks it, and `packages/tunnel/fixtures/wire-golden.json` — the Swift/Kotlin client conformance fixture — was deliberately left unchanged when the peer plane landed: a phone has no links, so adding the peer ALPN there would falsely tell mobile it owes an implementation.

## Pre-1.0 schema stance (F1)

Until 1.0:

- Prefer optional additive fields for forward compatibility; the handshake's protocol and capability fields are required on every reachable gateway.
- **Protocol** floor bumps refuse incompatible peers (update wall), not product string equality.
- Vault DDL / storage **schemaEpoch** in replica code is a storage cursor concept; it may later diverge from wire protocol.
- **1.0** = first release after which every schema change ships a migration ([decisions.md](decisions.md)).

## RPC / API naming (`/centraid/_*` planes)

Issue #504 batch 1. **Mechanical:** route constants live in `@centraid/core/protocol`; `scripts/lint-protocol-routes.mjs` (via `check:pr`) flags hard-coded known paths in extension + product CLI.

### Plane scheme (de-facto, freeze carefully)

| Prefix | Plane | Role |
| --- | --- | --- |
| `/centraid/_gateway/*` | Shell / control | Info, health, devices, pair, logs, … |
| `/centraid/_vault/*` | Vault | Status, blobs, replica, consent, … |
| `/centraid/_apps/*` | Apps store | List, publish, web-session mint, … |
| `/centraid/_web/*` | Browser sessions | Control cookie proxy, redeem |
| `/centraid/_brief/*` | Daily brief feature | Content-minimized current-vault summary |
| `/centraid/_harnesses/*`, `/centraid/_automations/*`, … | Feature planes | Same underscore-plane pattern |

The underscore planes above are gateway-wide surfaces. A running **app** owns its own surface under `/centraid/<appId>/*` (static assets, `_changes`, `_query`, `_turn`, and the app RPC routes below); the reserved `_`-prefixed segments inside an app prefix are the app's control sub-routes.

### App RPC (per-app, issue #505)

Handler invocation is **not** a plane — it is addressed under the invoking app's own prefix. The app id and handler name ride in the path; the JSON body carries only the arguments.

| Method + path | Replaces | Body | Notes |
| --- | --- | --- | --- |
| `POST /centraid/<appId>/actions/<action>` | `centraid_write` | `{ input?, intentId? }` | Runs a declared action; a write. |
| `POST /centraid/<appId>/queries/<query>` | `centraid_read` | `{ input? }` | Runs a declared query; a read (allowed for read-only devices). |
| `GET /centraid/<appId>/_describe` | `centraid_describe` | — | Returns the app's manifest; `?action=<name>`/`?query=<name>` narrows to one handler. |
| `POST /centraid/<appId>/_turn` | — | conversation turn | Opens the app's SSE conversation stream; `appTurnPath`. |

The `/centraid/_tool/centraid_*` shim these replaced was deleted outright — v0 ships no dual-route compat window ([decisions.md](decisions.md)). Path builders `appActionPath` / `appQueryPath` / `appDescribePath` / `appTurnPath` live in `@centraid/core/protocol`, alongside the vault-plane `assistantTurnPath` / `assistantResolvePath`. The persisted-conversation family (`/_centraid-conversations/apps/<appId>/…`) is a flat top-level name that rule 1 below forbids for new protocol entries, so its builders stay in `packages/client/src/conversation-routes.ts`. Auth, consent, vault scoping (`x-centraid-vault`), Companion grants, and browser-session scoping are unchanged — the reshape moved routing keys from the body into the path but kept every gate.

### Rules

1. **No new flat names** under `/centraid/<word>` without a plane underscore segment and a migration plan. (`<appId>` is a path parameter, not a reserved word — it addresses the app's own surface.)
2. Request/response pairs stay under one plane; do not invent parallel `/v2` trees without epoch bump.
3. Clients import `ROUTES` (and the app-path builders) from `@centraid/core/protocol` rather than string-copying paths.
4. Wire schemas stay structural (C3); normalization is a named post-pass.

### Blueprint-readiness feature contracts (#630)

Mobile judges the normal gateway handshake before mounting a replica. The mutual protocol window and the required `multiVaultReplica` / `crossVaultPlacements` capabilities are evaluated once in `mobile-gateway-compatibility-core.ts`; incompatibility produces exactly one “update gateway” or “update app” wall. Feature code does not retry older route shapes or silently fall back to an online-only client.

Household placement uses the gateway control plane because one request names an origin and an audience vault. It is **same-owner only** since #825: `POST /centraid/_gateway/edges` refuses a cross-owner pair with `cross_owner_give_retired` and names the grant plane in its message, because giving another person a copy is no longer a verb this product has (ruling G-copy). `gatewayPlacements` is the durable, link-token-idempotent client outbox ingress — the only route left on this plane since #726 P0 deleted the dead `/share` routes (`gatewayShare`, `gatewayShareRemove`, `gatewayShareReceipts` had no client caller; placement's own `share_access_receipts` recording stays). The gateway resolves both vault handles and confirms ownership — not a role — before entering either single-vault context.

`briefToday` is a read-only feature-plane projection. The caller supplies an explicit local-day `[from,to)` range, date, and IANA time zone; the response is bounded events, due tasks, the day's photo count, and the owner's Tally net position. Notification schedulers may wake Home but must not copy those titles or balances into a push payload.

### The grant plane (`/centraid/_vault/grants`, issue #825)

A share is a **standing grant**, not a copy handed over: who may see or edit which subject, from when, until it is revoked. Owner tier, active-vault scope (`ROUTE_SECURITY_REGISTRY`), constants `ROUTES.vaultGrants` / `ROUTES.vaultGrantSubjects` with the `vaultGrantPath` / `vaultGrantRevokePath` builders in `@centraid/core/protocol`.

| Method + path | Body / query | Answers |
| --- | --- | --- |
| `GET /centraid/_vault/grants/subjects` | — | `{subjects: [{subjectType, capabilities, fulfillment}]}` — the declared registry a surface consults BEFORE drawing Share. |
| `POST /centraid/_vault/grants` | `{audienceKind: party\|circle, audienceId, subjectType, subjectId, capability: view\|edit, subjectLabel?, maxSizeBytes?}` | `201 {outcome: "created", grant, fulfillmentPass}` — or `200 {outcome: "exists", …}` for the grant already standing. Fulfillment runs on the gesture. |
| `GET /centraid/_vault/grants?partyId=` | — | `{partyId, channel, grants}` — everything that person can reach, party grants unioned with the circle grants they are on the roster of (ruling G-audience). |
| `GET /centraid/_vault/grants?audienceKind=&audienceId=[&includeRevoked=1]` | — | `{audience, grants}` — the literal rows for that audience; a party grant and a circle grant containing that party are never merged here. |
| `GET /centraid/_vault/grants?subjectType=&subjectId=[&includeRevoked=1]` | — | `{subject, grants}` — the object side: who is this album/document shared with. |
| `GET /centraid/_vault/grants/<grantId>` | — | `{grant}`, delivery state included; `404` for one this caller cannot see. |
| `POST /centraid/_vault/grants/<grantId>/revoke` | — | `{outcome, grant, removal, message}` — one verb, uniform, honestly best-effort (ruling G-revoke). |

Every grant on the wire carries `fulfillment: [{peerVaultId, state, updatedAt, detail}]`, the per-audience-vault delivery state (`awaiting_channel | syncing | delivered | remove_sent | removed`).

**Absent is never empty.** `channel: null` is "this vault has never reached that person" and is a different fact from a `severed` channel; `fulfillment: []` is "no audience vault addressed yet"; a grant this caller cannot see is `404`, never an empty answer; an audience this vault has never heard of is `404 audience_not_found` (checked against `core_party` / `social_circle`) rather than the `grants: []` that means "nothing is shared with them". The one question this cannot be asked of is the SUBJECT read: subject ids are app-polymorphic, so no table at this layer can say whether one exists and `[]` there covers both facts. The seam behind the routes keeps the same distinction — a pass over a vault this host has not mounted answers `{origin: "unmounted", reason}`, never an empty report list.

Refusals are actionable rather than silent: a subject type with no fulfillment strategy is `400 subject_not_offerable`, and an `edit` grant on a container the commons rail cannot carry writes to is `400 capability_not_offerable`, both naming what the vault CAN do instead. Three answers are shared by every route in the table, since the plane is owner-tier and active-vault-scoped: `403 device_identity_required` for a caller with no proved device, `409 vault_unavailable` when no vault is mounted for the request, and `404` — bare, nothing else said — for a mounted vault this caller's owner does not hold, the same topology hiding the edge plane uses. Clients read grants themselves through the **ordinary replica plane** — `share.authority` and `share.fulfillment` are consent-shaped entities like any other, so an app with the scope gets them in its shape and an app without it gets no entity at all.

**What #825 took off the wire.** Copy-as-share retired (ruling G-copy), and these answer `not_found` exactly as an unknown path does:

| Retired verb | Was |
| --- | --- |
| `POST /centraid/_peer/edge/give` | pushing a closure to another owner's vault |
| `GET /centraid/_peer/edge/closure/:id` | the audience pulling that closure back after answering an ask |
| `POST /centraid/_peer/edge/deny` | relaying the audience's refusal to the origin |
| `GET /centraid/_peer/blob/chunk` | the audience's ranged, resumable pull of a given item's ORIGINAL bytes |
| `GET /centraid/_gateway/edges/pending` | the owner's list of asks awaiting a decision |
| `POST /centraid/_gateway/edges/:edgeId/answer` | accept/refuse on one of those asks |
| `GET\|PUT /centraid/_gateway/links/<linkId>/receive-setting` | the per-link accept/ask/refuse preference for gives ARRIVING — nothing arrives to govern |

Their handlers are deleted, not gated. What a proved peer may still reach on `/centraid/_peer/*` is the link ceremony, the route assertion, and the commons rail (which carries its own blob doors and never used the retired one). Closure reading and projection survive BENEATH a grant as internal fulfillment transport — machinery, never a member-facing act.

**Cross-host grant delivery is an open gap.** Fulfillment resolves an audience vault through the host gateway's own registry, so a grant to a party whose vault lives on another gateway parks at `syncing` with that vault named and stays there. It is not an error state and no route reports it as one; v1's tested reach is co-hosted vaults, and carrying a grant across the peer plane is a follow-up under [#825](https://github.com/srikanth235/centraid/issues/825).

## Stream authority

| Channel | Authority | Use |
| --- | --- | --- |
| **Live stream** (SSE / turn stream) | Immediacy | Show tokens and run progress as they happen |
| **Paged / authoritative fetch** | Correctness + catch-up | Conversation history, missed events after reconnect |

Do not treat the live stream as the sole source of truth after a gap — re-fetch authoritative pages. Product CLI streaming is deferred (#504 batch 3 follow-up).

## Related

- [decisions.md](decisions.md) — C1, F1
- [SECURITY.md](../SECURITY.md) — transport trust boundaries
- [ARCHITECTURE.md](../ARCHITECTURE.md) — gateway HTTP surface
- `@centraid/core/protocol` — version, capabilities, route constants
