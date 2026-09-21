# Glossary

Authoritative product vocabulary. Prefer these terms in code, docs, commits, and review. When a concept has a canonical type, table or file, the pointer is listed. Table names resolve in [`contracts/schema/vault-ddl.sql`](../contracts/schema/vault-ddl.sql), the baseline DDL every crate reads.

## Runtime model (never "chat" for the ledger) — retired

> **Superseded, 2026-09-21.** The conversation ledger band was dropped in rung five with the assistant and automation planes it recorded ([#1029](https://github.com/srikanth235/centraid/issues/1029) W19). No table below exists and nothing writes one. Kept as vocabulary for old receipts.

| Term | Meaning | Code |
| --- | --- | --- |
| **conversation** | Durable thread. Single-kind: `kind ∈ {chat, build, automation}`. | `conversations`; [`crates/vault/src/ledger/schema.rs`](../crates/vault/src/ledger/schema.rs) |
| **turn** | One execution under a conversation (`conversation_id` NOT NULL, FK, CASCADE). One reply round for chat; one compile/fire / `ctx.delegate` round for automation. | `turns`; same |
| **item** | Ordered trace element under a turn. `kind ∈ {message_in, step, tool, delegate}`. Inbound is `message_in` ordinal 0. | `items`; same |
| **run_summary** | Derived VIEW over the ledger band for Insights — not a separate write path. | `run_summary`; `RUN_SUMMARY_VIEW` in `crates/vault/src/ledger/schema.rs` |

There is **no `run` layer** and no `run_nodes` table (collapsed in #190). Automation is a conversation whose other side is a deterministic script; its transcript is the same ledger.

### Forbidden synonyms (runtime model)

| Avoid | Use instead | Why |
| --- | --- | --- |
| "chat" for the ledger / schema | **conversation** / **turn** / **item** | Chat is one `conversation.kind`, not the model name |
| "session" for durable agent history | **conversation** | Session means an opaque harness resume handle, never ledger identity |
| "message" as the unit of agent work | **item** (or `message_in` item) | Messages are one item kind |
| "run" / "run node" as a ledger layer | **turn** / **item** | Pre-#190 vocabulary |
| "thread" as a table name | **conversation** | Informal synonym only |
| runner / backend / provider / adapter for an installed agentic CLI | **harness** | One axis has one word; adapter is reserved for a first-party ACP shim and provider for the egress vendor |
| agent for a model-turn rail or ledger item | **delegate** / `ctx.delegate` | Agent is reserved exclusively for autonomous principals |

"Chat" remains fine in **UI copy** ("Ask your vault") and when `conversation.kind === 'chat'`.

Schema names follow the same one-axis rule: **a table never repeats its schema name**. The plane's central table is named for what one row represents (`access.agent` → `access_agent`, `media.asset` → `media_asset`), not by stuttering the plane (`agent.agent` → `agent_agent`, `media.media_asset` → `media_media_asset`).

## Core product nouns

| Term | Meaning | Code |
| --- | --- | --- |
| **superapp** | What Centraid is: a personal, local-first superapp — one shell wrapping many first-party apps whose content characters could not be more different. The container for every noun below. Not a builder, platform, or host for anyone else's apps ([#799](https://github.com/srikanth235/centraid/issues/799); [decisions.md](decisions.md#product-positioning)). | the shell in `mobile/`; the apps in `crates/apps/` |
| **system app** | One of the bundled first-party apps the superapp ships (Tasks, Agenda, Tally, People, Notes, Docs, Locker, Photos). Every app is a system app — there is no other kind. | `crates/apps/<app>/` |
| **app** | A manifest plus two sets of pure functions — queries that hold statements as data, and actions that invoke one typed vault command each. An app crate holds no SQL and no connection; the same crate runs wherever the vault is. | `crates/apps/<app>/manifest.json`, `src/queries.rs`, `src/commands.rs`; [`crates/apps/kit`](../crates/apps/kit/README.md) |
| **blueprint** | Older name for a system app, still used in [blueprint-seats.md](blueprint-seats.md) and in code comments. It names the same thing; there is no separate template or install step. | as **app** |
| **handler** | A declared query (read) or action (write) in an app's `manifest.json`. A query reads through the paged door; an action invokes one vault command. | `crates/apps/<app>/src/{queries,commands}.rs` |
| **vault** | Sovereign personal ontology for one owner. Unit of custody: `vault.db` — one SQLite file holding the model and its two append-only bands ([#916](https://github.com/srikanth235/centraid/issues/916)) — plus its blobs and keys. | [`crates/vault`](../crates/vault/README.md); on disk under `<data-dir>/vault/<vaultId>/vault.db` |

| **Needs you** | The owner-facing place that holds open **decisions**. Informational **notices** stand in Activity, not here ([decisions.md](decisions.md#mobile-ux-consistency-1015) R-NY-2, R-NY-4). | `BandPolicy.kt` in `mobile/shared` | | **decision** | An item that needs the owner to act — a parked high-risk act, a lapsed derivation. Only these count toward Needs you. | `crates/vault` | | **notice** | A durable, non-decision update. Repeats collapse by `(kind, source_ref)` and carry read/archive state. | `notifications_notice` | | **wake** | Content-free push signal that tells a device to fetch locally. A wake never carries a headline or vault content. Ruled in [R-1020-14](decisions.md#v1-platform--rust-core-kmp-shell-electron-seat-gateway-anywhere-1020); not built. | — | | **consent / grant** | A standing answer the owner gave a **principal** — a person, circle, harness or automation — about a subject and a verb; every one of them is a row of the one authority table ([#883](https://github.com/srikanth235/centraid/issues/883)). An app is not a principal and holds no grant: it declares a build-time entity manifest ([#928](https://github.com/srikanth235/centraid/issues/928)). | `share_authority`; `crates/vault/src/access.rs` | | **access plane** | The vault schema that answers "may this actor reach this data" — agents, devices, grants, receipts. Named `consent` until [#916](https://github.com/srikanth235/centraid/issues/916): the plane decides access, and consent is one of the answers it records. A deny is an outcome, not an exception. | `access_*` tables; `evaluate_access` in [`crates/vault/src/access.rs`](../crates/vault/src/access.rs) | | **execution clamp** | The narrowing an app or agent's declared scopes apply to whoever runs under them, owner included. | `crates/vault/src/access.rs` | | **audit band** | The append-only evidence tables inside `vault.db` — `access_provenance`, `access_receipt`, `agent_command_invocation / invocation_check / evidence / explanation`. Append-only by trigger, excluded from export and support bundle by band, retained 365 days. Do **not** call it "the journal". | [`crates/vault/src/audit.rs`](../crates/vault/src/audit.rs) | | **ledger band** | The conversation ledger inside `vault.db` — conversations, turns, items, attachments, automation state, archive and digest rows. Same file, same exclusions, 90-day retention window. | [`crates/vault/src/ledger`](../crates/vault/src/ledger) | | **self party** | The vault's own `core_party` row — the person as **data** (`core_vault.self_party_id`). It confers nothing: authority is enrollment plus `share_authority`. Never "owner party" ([#916](https://github.com/srikanth235/centraid/issues/916), ruling ONT-05). | `Vault::found` in `crates/vault/src/bootstrap.rs`; see [Owners](#owners-gateway-726) | | **entity / supertype** | Every ontology row is also a row of `core_entity(entity_type, entity_id)`, so an id is unique across the model and every `(type, id)` pointer is a composite foreign key the engine cascades. An entity is a thing the owner can name, share, trash and purge. | `core_entity`, `core_entity_kind` | | **projection** (vault) | A row that is a **part** of an entity rather than an entity — an expense split, a memory member, a phash — keyed by its parent and holding no supertype row of its own. Declared in the registry. Distinct from a _projection_ in the app sense (a read-only view over another app's rows). | `projection_of` in `crates/ontology/src/registries.rs` | | **replica** | **Retired.** There is one copy of a vault and it is on the phone ([#1029](https://github.com/srikanth235/centraid/issues/1029)). What the laptop holds is a sealed **backup**, which is not a replica: it cannot be read, queried or written. | — |

| **pairing** | The laptop prints its endpoint id and a one-shot invite as a QR; the phone scans it, admits itself and claims the lease, and the member compares a **safety number** on both screens. Only a hash of the invite secret is stored. | `crates/identity/src/ticket.rs`; [gateway.md](gateway.md#pairing) | | **pair ticket** | The **only** ticket kind (#603). Always means _pair this phone to that laptop_. Minted by `centraid-gateway invite`, one-time, burns on redeem. It was struck by #1029 §6 and returned by the [scope amendment of 2026-09-21](https://github.com/srikanth235/centraid/issues/1029#issuecomment-5755559795). | `crates/identity/src/ticket.rs` |

| **owner** | The one person a vault belongs to — exactly one, forever (#726, superseding #599's member/role model). Never granted by a `core_party` row: people-as-_data_ and people-as-_principals_ are separate concepts, and a party row never confers authority. See [Owners](#owners-gateway-726). | — | | **host** | The machine a **gateway** runs on. Hosting is a location and confers nothing: a gateway holds no key and no plaintext. See [Owners](#owners-gateway-726). | — | | **transport / relay** | The iroh QUIC path between a phone and its laptop, one ALPN (`centraid-gateway/1`), carrying the gateway API as HTTP/1.1 over one bidirectional stream. Hole-punching falls back to relays over outbound TCP 443. **The phone dials and accepts nothing.** | [`crates/gateway-client`](../crates/gateway-client); [gateway.md](gateway.md) | | **byte plane** | Content-addressed blob storage, keyed by BLAKE3, with custody accounting per blob. | `crates/blobs`; `blob_*` tables |

| **recognition automation** | A bundled deterministic derivation the phone runs on its own bytes: OCR, transcription, embeddings, faces. Each handler owns its ML implementation and stamps `enrich_derivation` with the pinned `model@version`. There is no separate inference service and no provider egress. | `crates/vault/src/commands/enrich.rs`; [recognition-automations.md](recognition-automations.md) | | **deterministic step** | The whole of a recognition capability now: same input + pinned local model gives the same canonical result, on the device, with no egress. The delegate branch went with the assistant plane ([#1029](https://github.com/srikanth235/centraid/issues/1029)). | `crates/vault/src/commands/enrich.rs` |

| **capability** | A typed enrichment contract — input kind to versioned output schema (`ocr@1`, `faces@1`, …) — that apps consume by contract only, never by implementation. | `enrich_policy`, `enrich_derivation` | | **engine profile** | A named bundle of capability + engine + parameters that policy points at: the immutable `built-in` deterministic engine, or a member-created delegate binding a harness, model, config pins and prompt revision. The unit derived results are keyed by. | `enrich_derivation` | | **egress class** | **Retired.** Every engine v0 ships is `on-device`; there is no provider to egress to. | — | | **policy cascade** | The scoped enrichment rules — vault, domain, collection, item — stating per capability whether it is enabled and its trigger. `NULL` inherits and most specific wins. | `enrich_policy_rule` | | **design tokens** | Shared colors, type, spacing and icons across desktop and mobile. The TypeScript source is lowered into Rust and the native shells by generators. | `packages/design`; [`crates/design`](../crates/design/README.md) | | **receipt** | (1) Vault write receipt from the access pipeline (`access_receipt`); (2) repo `receipts/issue-N-*.md` for issue work. | context-dependent |

## Hosts and clients

The platform nouns, ruled at wave 0 of [#1020](https://github.com/srikanth235/centraid/issues/1020) (see [decisions.md](decisions.md#v1-platform--rust-core-kmp-shell-electron-seat-gateway-anywhere-1020)).

| Term | Meaning |
| --- | --- |
| **gateway** | The member's own laptop running `centraid-gateway`: a **blind store** for one or more vaults' sealed backup objects. It holds no key, no plaintext and no schema, and it is the only thing in this product that listens ([gateway.md](gateway.md)). Not a role of the core and not a vault host — [#1029](https://github.com/srikanth235/centraid/issues/1029). |
| **seat** | **Retired.** A seat was a device replica of a gateway-held vault. The phone _is_ the vault ([#1029](https://github.com/srikanth235/centraid/issues/1029)); there is no replica, no applier, no outbox and no settlement. Say **the phone**, or **the core**. |

| **desktop** | **Retired in v0.** The Electron shell and its sidecar were struck by the [scope amendment of 2026-09-21](https://github.com/srikanth235/centraid/issues/1029#issuecomment-5755559795); what un-defers a big screen is [R-1029-1](decisions.md#the-phone-is-the-vault--v0-1029-ruled-2026-09-21). | | **mobile** | The Kotlin Multiplatform app (`mobile/shared`, `mobile/androidApp`, `mobile/iosApp`): shared screen state machines over the core's C ABI (`crates/core-ffi`), rendered by SwiftUI and Jetpack Compose. | | **Companion** | **Retired in v0**, with the seat socket it reached. |

| **`centraid` binary** | The operator's two verbs, `gateway install` and `doctor`. The laptop's gateway is a separate binary, `centraid-gateway` ([crates/centraid/README.md](../crates/centraid/README.md)). | | **drain** | One pass that uploads the phone's spool to its laptop and commits a manifest entry per batch. Bounded by a deadline the shell passes in; stops for exactly three reasons — everything acked, the deadline, or the laptop unreachable. | | **reference device** | One of the two phones the absolute targets in [`tests/journeys.json`](../tests/journeys.json) are stated on: `device-android-mid` is the **Samsung Galaxy A55** and `device-iphone-oldest` is the **iPhone XR on iOS 17** (Q-1020-2, ruled). Naming a model does not make a number measured — every one of the six targets is still parked `_intended`. | | **kit** | [`crates/apps/kit`](../crates/apps/kit/README.md) — everything an app crate may import, and deliberately not much: the paged-read grammar as data, `Money`, the door's statement builder, the year-3 fixture generators. An app is a manifest plus two sets of pure functions, and the kit is the vocabulary those functions are written in. | | **door** | A function, not an object: the one way a plane is reached from outside it. The **paged door** turns a `PageQuery` value into rows under an access decision; the **byte door** answers `centraid://` and staged-blob requests; the **FTS door** is [`crates/search`](../crates/search/README.md), the only place a `MATCH` statement exists. A door is where the check that makes the plane safe can run, which is why an app crate holds neither SQL nor a `Connection`. | | **band** | A region of the one vault file with its own rules: the **model** (the ontology's schemas), the **audit band** (receipts, provenance, invocations, checks, evidence — append-only by trigger), and the **ledger band** (conversations, turns, items, attachments, automation state). Bands are not databases; they are one ACID boundary and one migration ladder. | | **artifact key** | The content digest that names a prebuilt core: `crates/**` and `contracts/**`, plus the schema, target triple, feature set, toolchain and profile — never `Cargo.lock` alone. A key names everything that is in the artifact ([R-1020-23](decisions.md#v1-platform--rust-core-kmp-shell-electron-seat-gateway-anywhere-1020)). | | **identity stamp** | The `{gitSha, digest, schemaVersion}` triple embedded **in the binary**. A shell reads it at `open` and refuses a mismatch against its own expected digest, which turns a cache bug into a loud failure rather than a phantom one. The key and the stamp are two mechanisms: one decides what to build, the other proves what was built. | | **member key** | `K` — the key Locker secret cells are sealed under, **minted on the device and never leaving it**. The vault learns that a generation exists and when (`locker_key(key_id, created_at, retired_at)` carries no material). Not the vault DEK, which seals ordinary sealed columns. | | **drill** | A test that runs the real durability chain rather than calling a library in one breath. The restore drill founds a vault, commits, captures, takes a generation, commits more, **destroys the live vault, its WAL and its spool**, restores from the object store and the two derived keys, and proves the result is byte-identical. It refuses a census of zero rows, so an empty vault cannot pass by having nothing to lose. | | **gate profile** | One of `local`, `pr`, `nightly`, `release`, `mobile-jvm` — each of the first four a **concatenation of the one before** with a feedback-time budget in a down-only ledger. `cargo xtask gate --profile <name>` is the only entrypoint CI runs ([TESTING.md](../TESTING.md#the-v1-gate-profiles-1020)). | | **daemon** | A `centraid gateway` process under a `--data-dir`, usually installed as a launchd, systemd or Windows service. |

## Seats and byte custody ([blueprint-seats.md](blueprint-seats.md))

| Term | Meaning |
| --- | --- |
| **byte custody** | Where a member's bytes live: the phone owns its copy, with eviction, and the laptop holds sealed parts of it. There is no second device role. |
| **byte-bearing / record-only** | The two app classes. Record-only apps (tasks, agenda, people, tally) are rows the replica covers fully offline; byte-bearing apps (photos, docs; notes/locker via attachments) need custody, the upward pull, the downward plan and free-up-space. |
| **custody state** | Where a content item's bytes are, counted by the gateway's sweep: `pending-offsite`, `local-only`, `replicated`, `remote-only`, `missing`, plus the views `freeable` and `local-unproven`. `blob_custody_state`; read in `crates/apps/photos/src/storage.rs`. |
| **origin act** | A frame-owned capture capability apps register into — camera, scanner, share-sheet-in, notifications, autofill. One door per capability, never per-app re-implementations. |
| **north star** | The incumbent product an app deliberately mimics (Photos → Google Photos, Notes → Apple Notes, Docs → Google Drive, Tally → Splitwise, Tasks → Todoist, …) so switching costs an owner nothing. Table in [blueprint-seats.md](blueprint-seats.md). |

## App admission ([blueprint-seats.md](blueprint-seats.md#app-admission))

| Term | Meaning | Code |
| --- | --- | --- |
| **designed state** | One honest state an app's design calls for — the app's own `states.designed` manifest entry, not a state some other app happens to draw. Its opposite is an `excluded` state: one the design makes structurally unrepresentable, costing a reason and a citation. "Nobody has built it yet" is neither; that is a gap. | `crates/apps/<app>/manifest.json` |
| **canonical designed states** | The closed seven every app partitions into designed and excluded — `dayone`, `pending`, `offline`, `stale`, `conflict`, `parked`, `denied`. Closed by doctrine, so an eighth arrives by amending the list, never by one app inventing it; a manifest that forgets one fails to parse. | `CANONICAL_DESIGNED_STATES` in `crates/apps/kit/src/manifest.rs` |
| **engine registry** | The one roster of the shared engines, each row naming its source and whether it takes a column in the app × engine grid. | `tests/claims.json#engineRegistry` |
| **consent ledger** | The permission layers a member's answer can sit in, each naming where it is enforced, its refusal grammar, which seats it binds, and the proof that it refuses — or the open issue admitting it has none. | `tests/claims.json#consentLedger` |

## Gate and evidence (testing, [TESTING.md](../TESTING.md))

| Term | Meaning | Code |
| --- | --- | --- |
| **step** | One named check inside a gate profile (`fmt`, `clippy`, `sim`, `restore-drill`, …). Every step prints one line and a verdict — `ok`, `FAIL` or a loud `SKIP` naming the command that makes it real — and runs even when an earlier one failed. | [`crates/xtask/src/gate.rs`](../crates/xtask/src/gate.rs) |
| **lane** | A step, or a device cell of the `device-lanes` step, run alone with `cargo xtask gate --profile <p> --lane <name>`; a name that matches nothing is an error. Lanes with a claim are registered in `tests/claims.json#lanes`. | `crates/xtask/src/gate.rs`; `tests/claims.json#lanes` |
| **simulation** | **Retired** with `crates/sim` and the multi-writer plane it proved ([#1029](https://github.com/srikanth235/centraid/issues/1029)). There is one writer and it is the phone; what replaces the claim is the restore drill and `gateway-core`'s conformance suite. | — |
| **evidence** | `target/xtask/<profile>/evidence.json`: the profile, the hardware class and one row per step with its seconds, verdict and detail, written on success and failure alike so a step going quiet is visible ([TESTING.md](../TESTING.md#the-evidence-contract)). | `crates/xtask/src/gate.rs` |
| **candidate** | A `main` SHA that passed `candidate.yml`. `refs/candidates/latest` points at it and `artifacts/candidate.json` describes it, so a release is cut from a build somebody promoted rather than from the tip of `main`. | `.github/workflows/candidate.yml` |
| **claim** | A row in `tests/claims.json#claims`: what the product promises, the file that owns the proof, the lane that runs it, its severity `S1`–`S4`, and the date it was last demonstrated red. | `tests/claims.json` |
| **park** | A lane red long enough to stop being information, given an **expiry** and an issue. A parked lane still runs; it counts as red again once the expiry passes. | `tests/quarantine.json#lanes` |
| **pin** | A characterisation test asserting the current, **wrong** behaviour and naming the ruling or documented sentence it contradicts, so a fix goes red and is revisited deliberately. A defect a lane found but is not chartered to fix is pinned, never tolerated quietly and never deleted ([decisions.md](decisions.md#adversary-lanes-and-provisional-evidence-839)). | — |
| **ledger** | A tighten-only JSON file. The gate's own are under `contracts/ledgers/` (`gate-budgets`, `compile-time`, `library-size`, `call-budget`, `advisory`), compared against the merge base by the `ledgers` step and written only by `cargo xtask measure --write`. The repo-wide four are `tests/floors.json` (up-only), `tests/budgets.json`, `tests/inventory.json` and `tests/quarantine.json` (down-only). | [`contracts/ledgers`](../contracts/ledgers); `scripts/check-ledgers.mjs` |
| **section** (ledger) | A top-level key of a `tests/` ledger — the unit a direction, an `approvedDeviation` and a base-side fallback path all attach to. Cited as `tests/budgets.json#suiteWallClock`. A widen is waived only by a CHANGED note in the section being widened. | `scripts/check-ledgers.mjs` |

## Projection doctrine (apps, [#834](https://github.com/srikanth235/centraid/issues/834))

Store once, draw in the asking room's shape. These words are how the apps talk about each other's facts; using them loosely is how a second copy gets written.

| Term | Meaning | Code |
| --- | --- | --- |
| **projection** | A read-only re-shaping of rows another app or another table owns, drawn where it is useful and never copied. A birthday stays canonical on the person; Agenda projects it. An app that stores its own copy of another app's fact has left this doctrine, whatever the screen looks like. | `crates/apps/agenda/src/queries.rs` |
| **day context** | The costless layers a calendar day learns from elsewhere — birthdays (People), due tasks (Tasks), holidays — answered by read-only Agenda reads over a bounded date range. **A layer is not a calendar**: it carries no hue dot, nothing writes to it, and it never takes grid shape. | `crates/apps/agenda/src/queries.rs` |
| **re-entry** | How a room lets someone back in after they fall behind: one live occurrence for a repeating task with its elapsed periods collapsed beside it (`missed 4 · next is Friday`), a group that offers to catch up, and `won't do` as a respectable exit. The house alternative to a wall of shame. | `crates/apps/tasks/src/board.rs` |

## Owners (gateway, #726)

The current owner model supersedes the five-layer **member/role** vocabulary from [#599](https://github.com/srikanth235/centraid/issues/599); see the [current ownership decision](decisions.md#ownership-sharing-and-peer-transport). This section is the live model.

Authorization collapses to **two questions, neither a role**:

1. **Whose device is this?** Enrollment binds a proved iroh EndpointId to the vault: an `access_device` row (replicated — the member's device list) with its public key in `access_device_secret` (private to the gateway) — [`crates/vault/src/devices.rs`](../crates/vault/src/devices.rs). **Enrollment is full trust** ([#996](https://github.com/srikanth235/centraid/issues/996) R11).
2. **Does that owner own this vault?** A vault has **exactly one owner**. A gateway data dir holds one vault (`sole_vault_file` in `crates/centraid/src/cmd/mod.rs` refuses a directory with two), founded with its owner party in one step. There is no partial authority over a vault, because there is no such thing as being partly its owner.

The five layers still apply, corrected at L3:

- **L0 custody** — the gateway box, an exported backup recovery kit.
- **L1 authentication** — devices proving iroh EndpointIds — the only cryptographically provable layer.
- **L2 principals** — owners and agents.
- **L3 authorization** — was `(member, vault) → role`; now ownership, not a lattice.
- **L4 attribution** — the audit band records the acting owner (and the agent when one acted) whenever a principal is known; scheduler-fired automations carry none.

**D2 vocabulary (binding):**

- **owner** — the one person a vault belongs to. Exactly one, forever.
- **host** — the gateway whose disk and process a vault currently sits on. Hosting is a location, not an authority.
- **gateway owner** — the person whose machine it is.
- **mint** — to create a vault and assign its owner. Authority ends at creation; ownership is the new owner's from that moment and never returns. Auto-founding is simply the first mint, run automatically (#603).

**Minting is not owning, and neither is hosting.** A gateway host can see how many sealed objects there are, how big they are and when they arrived, and **nothing else**: no key, no plaintext, no schema ([#1029](https://github.com/srikanth235/centraid/issues/1029)). Hosting confers no authority over the vault, its relationships or its devices. Full posture is in [SECURITY.md](../SECURITY.md).

**Forbidden words: guest, tenant, hosted vault.** The first two smuggle back a hierarchy this model deleted — a vault minted on someone else's machine is a full sovereign vault, not a lesser one. "Hosted vault" collides with `Hosted`, which names the storage-provider custody copy.

Invariants:

- **No vault types.** Every vault has one owner; "personal" and "shared" are descriptions, never a `type` column or a conversion flow.
- **Narrower vaults over finer authority.** Finer-grained permission wants (per-item visibility, a role tier) are answered with another vault, not with row-level ACLs — the fence against Model B drift (#599), still standing.
- **Revoking a device deletes its key row.** Unknown and revoked are the same refusal, and the member's device list keeps the replicated row (`Vault::revoke_device`).
- **Sharing is residency, not filtering.** Data crosses only into another vault, under a standing **grant** (#825). No one queries another person's vault.

## Sharing: the grant plane, subscriptions and links (#726, #731, #825, #929) — retired

> **Superseded, 2026-09-21.** The [scope amendment of 2026-09-21](https://github.com/srikanth235/centraid/issues/1029#issuecomment-5755559795) struck **sharing in full** — share feeds, share capabilities, the link ceremony, the mailbox and every `share_*` table — **deleted, not parked**: rung five drops the tables and W16 deleted the readers. The vocabulary below is kept because it is in old receipts and old rulings, and a reader who meets one of these words needs to be told the plane is gone rather than to find nothing. **Nothing here describes current state.**

| Term | Meaning | Code |
| --- | --- | --- |
| **grant** | A standing member **answer**: this **principal** may VERB this **subject**, until revoked. `granted` and `declined` are both rows — a refusal is an answer, not an absent grant — and a grant on a container covers its contents now and later. One authority table holds every one of them ([#883](https://github.com/srikanth235/centraid/issues/883), succeeding [#825](https://github.com/srikanth235/centraid/issues/825)'s audience × capability shape). | `share_authority` |
| **principal** | The side of a grant that **holds** authority: a person, circle, harness or automation, with `app` reserved. Never the subject side, and never a role — a grant's enforcement locus is derived from the kind and is never stored ([#883](https://github.com/srikanth235/centraid/issues/883), [#928](https://github.com/srikanth235/centraid/issues/928), [#996](https://github.com/srikanth235/centraid/issues/996) R17). | `share_authority.principal_kind` |
| **automation** (principal kind) | The standing answer an owner gave one automation — one row per automation, not per pack. A refusal is a `declined` row, which is what keeps the next compile from silently re-asking. Distinct from **automation** the runtime noun above; this is the principal that runtime acts as ([#928](https://github.com/srikanth235/centraid/issues/928)). | `share_authority.principal_kind = 'automation'` |
| **app** (reserved principal kind) | A `principal_kind` value that is **reserved and unwritten**. A first-party app is the owner's own screen and is not a principal at all — it declares a build-time entity manifest and is granted nothing ([#928](https://github.com/srikanth235/centraid/issues/928)). | `share_authority.principal_kind` |
| **authority_id** | The one id space every receipt references: the id of the authority row whose exercise, reveal, denial or refusal the receipt records. NULL means owner-direct — the one act that needs no answer ([#928](https://github.com/srikanth235/centraid/issues/928)). | `share_authority.id`; `access_receipt` |
| **owner-direct read** | A read a handler performs for an **owner device** on the owner's own vault: it consults no grant and is not receipted, because nothing consumes an owner reading their own rows. A grantee, agent, reveal or denial path still writes its receipt ([#928](https://github.com/srikanth235/centraid/issues/928)). | `evaluate_access` in `crates/vault/src/access.rs` |
| **fulfillment** | Per-audience-vault delivery state under one grant — `awaiting_channel`, `syncing`, `delivered`, `remove_sent`, `removed`. Mechanism, never meaning: a member reads grants, never fulfillment rows. | `share_fulfillment` |
| **link / channel** | How to reach a party — a live `share_party_vault_binding` naming their vault, with two states: `live` and `severed`. The People link ceremony is the only thing that opens one, and a grant naming a party without a live one is refused (#903). | `share_party_vault_binding`; `crates/apps/people/src/dashboard.rs` |
| **subject** | The shared thing a grant names: an album, folder, document, or asset. Never `people.person` — a person is the audience side of a grant. A subject type with no fulfillment answer cannot be offered ([#750](https://github.com/srikanth235/centraid/issues/750)). | `share_authority.subject_type` / `subject_id` |
| **subscription** | **Retired.** `share_subscription` and its lineage were dropped in rung five with the rest of the sharing plane ([#1029](https://github.com/srikanth235/centraid/issues/1029)). |
| **circle** | The sharing audience and roster. Implicit circles belong to one container; only named circles such as Family or a Tally group are deliberately reusable. | `social_circle`, `social_circle_member` |
| **origin** | The vault that holds a shared container and is its **single writer**. A member's edit is a signed intent the origin executes; the receipt names the member. An availability role, never ownership over the member's copy. Retires **steward**. | `crates/apps/docs/src/origins.rs` |
| **re-origin** | Transfer of the origin role: the receiving vault BECOMES the origin of the container it already held, so a migrated group keeps every member and every ledger row. Retires **steward transfer** and **compile**. | — |
| **placement** | One crossing of a fixed item set between two vaults **one owner holds** — `add` keeps the origin item, `move` releases it. Placement, not sharing: a placement never reaches another person. | `crates/apps/docs/src/origins.rs` |

Retired vocabularies, historical only. **lend** — #726's live edges and borrowed stores were deleted in #731; a member holds their own full resident copy. **give** — the one-time receiver-owned snapshot is retired by [#825](https://github.com/srikanth235/centraid/issues/825), code and all; say **grant**. **closure**, **peer plane** and **route** named the v0 cross-gateway transport, removed with the v0 tree in [#1020](https://github.com/srikanth235/centraid/issues/1020). **seat**, **replica**, **outbox**, **intent**, **subscription**, **share feed**, **mailbox**, **account** and **plan lapse** all named planes [#1029](https://github.com/srikanth235/centraid/issues/1029) deleted rather than parked.

## The law (governance, [#1005](https://github.com/srikanth235/centraid/issues/1005))

The vocabulary of `.governance/` since the kit became a constitution. Detail in [`.governance/law/README.md`](../.governance/law/README.md); the rulings are in [decisions.md](decisions.md#governance-as-a-constitution-1005).

| Term | Meaning |
| --- | --- |
| **the law** | The rule catalog under [`.governance/law/`](../.governance/law/README.md) plus [CONSTITUTION.md](../CONSTITUTION.md). A directive is an ESLint rule; the constitution is its config. Never "the audit", which was the retired shell pack |
| **arrival** | One agent run, materialized as `arrival.json`: the commits, the changed files tagged by estate, the registry rows keyed by issue, the waivers spent, the gates touched, and the law digest at branch point and at HEAD. Generated once per run from git, and the only place the law talks to git — rules read the document, never the repo |
| **door** | Which rung a rule answers at. **hook** = answerable from the commit being written, fatal at pre-commit whatever its row says; **window** = the whole law at review time, at each rule's declared severity; **owner** = only a person can answer it. A check's rung is set by its door, never by its cost |
| **estate** | Which jurisdiction a path belongs to. **law** = the packs' declared `lawPaths` (CONSTITUTION.md, `.governance/**`, gate ledgers, the linter configs, CODEOWNERS); **territory** = product code, scripts, workflows; **registry** = evidence (`receipts/**`, `docs/**`, `CHANGELOG.md`, `QUALITY.md`, the docket). One commit edits law or territory, never both; registry may ride with either |
| **registry** | An append-only record the law checks for consistency rather than for presence — event-driven, so a routine arrival adds only its receipt and changelog row and nobody writes a blank N/A |
| **docket** | `.governance/law/docket.json`, the register of standing exceptions. A row carries id, rule, path, reason, authority, filer, issue and expiry; a suppression names it as `-- docket:D-n`. Anyone files, only the owner grants — by merging the row before it is spent |
| **front page** | The machine-written head of a PR body and of an umbrella receipt: the range, whether the law moved under the run, one line per enabled rule green or red, the registry lines, and the token cost read back from the receipt. Rendered by `node .governance/law/run.mjs --front-page <path>`; hand edits inside its markers are undone by the next run |
| **law digest** | The hash of the law as published, printed by `node .governance/law/brief.mjs` and stamped into a worker's brief. `run.mjs --brief-digest <hex>` reports whether the law moved under the work; the worker is held to HEAD, and the stamp names the gap |
| **amendment** | A change to the law: rule, cases, pack row and constitution section in one commit. `amendment-pairing` refuses any subset |

## Forbidden / discouraged synonyms (broader)

| Avoid | Prefer |
| --- | --- |
| "app builder" / "personal app builder" for the product | **superapp** — #799 retired the authoring and serving planes; the product is one shell wrapping the bundled first-party apps. "Builder" survives only for the **automation compiler** (the headless compile harness), never for the product |
| "platform" for Centraid | **superapp** — a platform hosts other people's software; Centraid ships its own and nothing else |
| "third-party app" / "user-built app" / "generated app" | **system app** — there is one kind of app and this repo ships all of them. `access_app.origin` declares `CHECK (origin IN ('installed'))` — the dead `'generated'` value left the vocabulary in [#916](https://github.com/srikanth235/centraid/issues/916) |
| "served app" / "inline app" | Retired vocabulary (#799, [#1020](https://github.com/srikanth235/centraid/issues/1020)). The gateway serves an app's **data**, never its bytes, and an app's screens ship in the mobile and desktop releases. Say **system app** |
| "code store" for where an app's UI lives | there isn't one — app code ships in the release (`crates/apps/*` and the shells) |
| "purpose" / `dpv:` prefixes for why an actor may read | Retired vocabulary ([#928](https://github.com/srikanth235/centraid/issues/928)). Say what actually bounds the reach: an app's **declared entity manifest**, or the **authority row** an automation or the assistant acts under. The word survives only in receipts and changelogs |
| "app grant" / "consent-scoped app handler" | there isn't one ([#928](https://github.com/srikanth235/centraid/issues/928)) — a first-party app is not a **principal**; it declares, and an owner-device read is an **owner-direct read**. Say **grant** only of a principal |
| "enrichment service" / "ML sidecar" | **recognition automation** — the handler itself owns model execution |
| "database" for the personal ontology | **vault** (`vault.db` is the file) |
| "server" for the product backend | **gateway** |
| "template app" | **app** (blueprint is an older name for the same thing) |
| "plugin" for declared handlers | **handler** / **query** / **action** |
| "identity.sqlite" / multi-user gateway identity | vault owner _is_ the user (#280) |
| "role" for what a device may do | **ownership** (does the acting owner own this vault) — #726 deleted the role lattice, and #996 R11 made enrollment full trust |
| "share target" / "default share target" for where a placement lands | **audience vault** — #726 P0 deleted the default share-target pointer; the destination is a picker over the caller's own writable vaults, never a remembered default |
| "lend", "borrow", "borrowed scope" for current sharing | **subscription** for co-owned resident data, under a **grant**. Lending is deleted historical vocabulary. |
| "commons", "steward", "compile", "edge-retire" for current sharing | **subscription**, **origin**, **re-origin** ([#929](https://github.com/srikanth235/centraid/issues/929)). The commons rail is deleted; the words are historical. |
| "copy-as-share" / "give a copy" / "give" as a member-facing act | **grant** — a share is standing, not a snapshot handed over (#825) |
| "invitation" for the act that makes a person shareable | **link** — the People ceremony that writes `share_party_vault_binding`. Nothing is sent on the member's behalf (#903) |
| "space" / "spaces" in user-facing copy | **vault** / **vaults** — one word, everywhere the owner can read it (#665) |
| **gateway** as an end-user _management_ noun | there isn't one (#665). **Every noun the owner manages is a vault**; a gateway is plumbing. Member-facing screens name no gateway host, transport or sync-engine state; those words belong to Settings, Devices and backup health ([R-1014-3](decisions.md#replication-offline-and-sharing-1014)) |
| "user" / "account" for a household principal | **owner** — there are no accounts, passwords, or sessions; an owner is a principal on the enrollment plane (#726, superseding #599's "member") |
| "member" for a vault's principal | **owner** — one owner per vault. "Member" remains correct only for a **circle roster**, never for vault ownership. |
| "token" for the pairing artifact | **ticket** — one-time, burns on redemption (#555 removed bearer redemption) |
| "founding ticket" / "founding ceremony" / "recovery-kit ceremony" / "uninitialized gateway" | **auto-found** — #603 deleted the founding plane entirely. A gateway is never zero-vault, and "ticket" means the **pair ticket**, unqualified |
| "found a vault" as something a **user** does | the user **creates** a vault; only the **gateway** founds — itself, once, on an empty data dir |
| "Approvals", "Inbox" or "Notifications" for the owner's decision queue | **Needs you** ([#1015](https://github.com/srikanth235/centraid/issues/1015) R-NY-4, R-NY-16), on every seat. Use **decision** for an item waiting on the owner and **notice** for a durable non-decision update; a notice stands in **Activity**, not in Needs you. |
| `com.centraid.*` identifiers | **`dev.centraid.*`** ([identifiers.md](identifiers.md)) |
| "confirm / reject" as the pair of things an owner does to a **proposal** | **answer** — one verb with three members: `confirm`, `reject`, `dismiss` ("reviewed, deliberately left unnamed"). A pair could not finish a review queue: a skipped proposal returns for ever. See `media.answer_face_proposal` (Photos' `answer-face` action in `crates/apps/photos/src/commands.rs`; #712, #725). |
| **deleting** a rejected proposal row | a rejection is a **state** (`review_state`), never a `DELETE` — a deleted row remembers nothing, so the enricher's next run proposes the same thing again. Suppression is a `review_state = 'proposed'` filter (`crates/vault/src/commands/enrich.rs`; #712). |

## Inconsistencies (known dual vocabulary)

These pairs appear in code and docs for historical reasons. Prefer the **canonical** term in new writing; the other is tolerated in existing APIs until renamed.

| Dual | Prefer | Tolerate | Notes |
| --- | --- | --- | --- |
| host / gateway | **gateway** for the laptop's process | "host" for the machine it runs on | The vault is not on it |
| blueprint / app | **app** (or **system app**) | "blueprint" in `blueprint-seats.md` and code comments | Same thing |
| server / gateway | **gateway** | "server" for a listener socket |  |
| Notifications / Needs you | **Needs you** in UI labels, docs and push bodies, on every seat | **notifications** as a storage name only: the `notifications_notice` table | Approvals → Inbox in #647, Inbox → Notifications in #665, Notifications → **Needs you** in #1015 (R-NY-4, R-NY-16) |
| space / vault | **vault** everywhere — copy, docs, and identifiers | none | Renamed in #665 |

**Which word, and how many:** this glossary governs which word. Length is ruled by [DESIGN.md § Copy](../DESIGN.md#copy) — per-surface sentence budgets, the positional reassurance rule, and the banned-filler list ([#805](https://github.com/srikanth235/centraid/issues/805), [decisions.md](decisions.md#copy-governance-805)).

## Related

- Runtime model detail: [ARCHITECTURE.md](../ARCHITECTURE.md)
- Identifier table: [identifiers.md](identifiers.md)
- Decisions: [decisions.md](decisions.md)
