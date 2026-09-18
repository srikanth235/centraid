# Architecture

Centraid is one Rust core that runs as either a **gateway** or a **seat**, a Kotlin Multiplatform mobile shell with native views, an Electron desktop seat over a sidecar, and an MV3 browser Companion — [#1020](https://github.com/srikanth235/centraid/issues/1020), [decisions.md](docs/decisions.md#v1-platform--rust-core-kmp-shell-electron-seat-gateway-anywhere-1020). The TypeScript implementation that preceded it was removed in [#1020](https://github.com/srikanth235/centraid/issues/1020); compatibility with its artifacts (seat files, pair tickets, npm gateway packages) is not a constraint, with one exception — the **recovery kit**, which is read because it is written once and opened years later ([D-1020-R3](docs/decisions.md#wave-2-lane-rulings-1020)).

## One program, two roles, one binary

`centraid` is one binary with subcommands, and the **CLI is a client rather than a privileged path**: `centraid devices revoke` and every other admin verb send the same command messages an owner seat sends, over the same local socket, and produce the same receipts. There is no admin UI on a gateway and no second authorization surface to audit. `centraid devices list` and `devices revoke` are declared and exit 3 (not yet available) in this build.

| Role | What it is |
| --- | --- |
| **gateway** | The vault's authority and its single writer. Holds `vault.db`, the commit log, the audit and ledger bands, the blob store and the iroh endpoint. Runs on a VPS, a NAS or the member's own laptop — the same binary installed as a service. |
| **seat** | A full replica: the applier, the outbox, settlement, and every app's queries and commands over its own copy of the file. Phones and the desktop are seats. A desktop seat also runs **thin** — no local copy, every call forwarded to the gateway under the caller's principal — with one API common to both modes and the mode visible to the renderer. |

`open` never blocks on the network: it opens the file, runs migrations and returns, and the iroh endpoint starts on a core thread afterwards. On a phone the endpoint idles when the app is backgrounded.

## The crates

| Crate | What it is |
| --- | --- |
| [`ontology`](crates/ontology/README.md) | The schema authority: open a vault file, know its shape, verify it. Holds the version window, the golden-corpus snapshot comparison, the commitments and the doctor. |
| [`vault`](crates/vault/README.md) | The authority's file. One writable connection behind `Vault::commit`, the typed command registry, per-command authorization, the replica log written with SQLite's session extension, the paged door's vault-side hook, custody, backup, restore and the drill. It also holds the tree's **one** civil-time and recurrence engine (`time::{zone,rrule,recurrence,occurrence,temporal}`) and the vault **operations** tier — task lifecycle and the recurrence rollover — because more than one app reaches them without going through any app. |
| [`seat`](crates/seat/README.md) | The replica: the applier (over the gateway's own statement renderers), `seat_state`/`seat_outbox`/`seat_outbox_settled`, watermark arithmetic, the intent grammar, the offline chain, `row_version` OCC and the online-only refusal. |
| [`core`](crates/core/README.md) | The message loop: `open`, `call`, `next_event`, `close`. One handle, three roles over one `Request` surface, a bounded coalescing event queue that drops nothing. |
| [`core-ffi`](crates/core-ffi/README.md) | Exactly five exported C symbols and [`CONTRACT.md`](crates/core-ffi/CONTRACT.md)'s ten clauses, one test per clause, `nm` over the built `cdylib` as a second question, and a committed cbindgen header. |
| [`api-proto`](crates/api-proto/README.md) | The schema workspace: `centraid.core.v1` (a gateway compatibility commitment) and `centraid.screen.v1` (shell-internal), with `buf breaking` per package. |
| [`protocol`](crates/protocol/src/lib.rs) | The wire: `u32BE(len) ‖ body` framing, the envelope, the relay path that moves bytes this build cannot decode, and the transport trait the simulation and `net` both implement. |
| [`net`](crates/net/README.md) | The only crate that names an iroh type: the endpoint, the three ALPNs, pairing and QR, iroh-blobs, relay fallback and the no-relay posture. |
| [`media`](crates/media/README.md) | The byte plane: CBSF v2 sealed frames and the format-normative crypto every backup and snapshot artefact is built from. |
| [`search`](crates/search/README.md) | The FTS door. Every `MATCH` statement in the workspace lives here, and a sealed column cannot be indexed or returned — checked at construction and again against each domain's live index columns. |
| [`assist`](crates/assist/README.md) | The assistant plane: the ledger band, the turn plane that asks consent first, harnesses as external processes, and `centraid mcp` as a stdio child with no listener. |
| [`automations`](crates/automations/README.md) | The fire spine: triggers, cron in the vault's zone, the enrichment gate, steering through one injected dispatch seam, and the recognition recipes behind a `Model` trait. |
| [`design`](crates/design/README.md) | One lowering of `packages/design` into Rust, generated from a corpus the real TypeScript emits — party hues, identity initials, figure tone, and the copy-leaf route check. |
| [`apps/kit`](crates/apps/kit/README.md) | What an app is allowed to do: the paged-read grammar as data, `Money`, the door's statement builder, the year-3 fixture generators. An app crate holds no SQL and no `Connection`. |
| [`apps/tally`](crates/apps/tally/README.md) · [`photos`](crates/apps/photos/README.md) · [`notes`](crates/apps/notes/README.md) · [`docs`](crates/apps/docs/README.md) · [`people`](crates/apps/people/README.md) · [`locker`](crates/apps/locker/README.md) · [`agenda`](crates/apps/agenda/README.md) · [`tasks`](crates/apps/tasks/README.md) | One crate per app: the read plane (queries as pure folds over `PageQuery` values) and the action table. The writes are `crates/vault`'s typed commands; the bytes ride a door the app crate does not hold. |
| [`sim`](crates/sim/README.md) | The deterministic simulation: one gateway, N seats, a scripted network under `turmoil`, seven invariants after every schedule. Test-only — nothing links it. |
| [`xtask`](crates/xtask/README.md) | The cross-cutting gate. `cargo xtask gate --profile <local\|pr\|nightly\|release\|mobile-jvm>` is the only entrypoint CI runs. |

**SQL appears only under `crates/{ontology,vault,seat,search}` and `crates/apps/kit`**, enforced structurally by the gate's `sql-confinement` rule. It has shaped real APIs rather than being routed around: the restore drill's vault-side work moved into `crates/vault` because `crates/centraid` may not hold SQL, and `crates/core` serialises calls through one mutex in wave 2 because a reader pool needs `PRAGMA` statements.

## The shells, and what crosses between them

- **Mobile** ([`mobile/`](mobile/README.md)) — one KMP shared module holding screen state machines, navigation, sync scheduling and platform services behind expect/actual, over the five-function ABI (JNA on JVM and Android, cinterop on iOS). What exists today is the navigation model, the screen machines, Home, the Tally list, the Photos grid and the Notes editor; the rest of the mobile screen surface is unbuilt and tracked in [docs/release/v1-handoffs.md](docs/release/v1-handoffs.md). SwiftUI and Jetpack Compose render finished state messages and own nothing. Screen states and events are `centraid.screen.v1` protobuf; `commonMain` has no platform import, enforced by Konsist. `call` is never invoked from a UI thread — a debug assertion in both actuals says so, and a `call` budget in the `pr` profile fails the gate on a request that exceeds it.
- **Desktop** ([`desktop/`](desktop/README.md)) — one Electron window, one `centraid seat` child, one Unix socket at mode 0600 in the user's runtime directory with a peer-credential check before the sidecar answers. The frame carries **two channels**: `0x00` is a `centraid.core.v1` envelope byte-identical to what crosses iroh, `0x01` is one UTF-8 JSON local message that names things which cannot exist on a remote wire. Reads are **named** statements from a catalogue the sidecar holds, never composed by the caller. Media rides a `centraid://` protocol handler registered in main, with range support, streaming from the sidecar; a range inside a declared total whose bytes have not landed answers a retryable `503`, never `416`.
- **Extension** ([`extension/`](extension/README.md)) — MV3 over native messaging to `centraid native-host`, which reaches the local seat over that same socket with a single-use capability token the shell mints. **No WASM, no iroh, no network of its own**, asserted over the built tree; origin matching is the seat's decision against one promoted spec, so the browser holds no copy of a security policy.
- **Deploy** ([`deploy/`](deploy/README.md)) — the container image, the OS service units, and the VPS installer. A gateway needs no domain, no certificate and no open TCP port; the off-by-default blob door is the only listener the product would ever have, and `no-listening-socket` is a structural gate rule rather than a convention.

## Contracts, fixtures and ledgers

[`contracts/`](contracts/README.md) is the layer every language reads: the frozen golden vault and its manifest, the DDL, the schema registries, the baseline migration, one parity bundle per app, the screen fixtures, the desktop socket catalogue, the origin-matching spec, and the down-only ledgers (`gate-budgets`, `compile-time`, `library-size`). The parity bundles were generated by executing the retired TypeScript implementation before it was removed in [#1020](https://github.com/srikanth235/centraid/issues/1020); they are frozen goldens now, compared whole by the Rust tests. A parity fixture is **canonicalised rows plus the committed DDL**, not a database file, because a founded vault mints ids off the clock and is not byte-reproducible.

Every prebuilt core artifact is keyed on the content digest of `crates/**` and `contracts/**` plus schema, target triple, feature set, toolchain and profile; the binary embeds `{git_sha, digest, schema_version}` and every shell reads it at `open` and refuses a mismatch.

## Release surfaces

One product version stamps the repository; a surface may skip a release but not diverge its stamp. [`release.yml`](.github/workflows/release.yml) plans a tag or a dispatch and calls one `lane-release-*.yml` per surface.

| Surface | How it ships |
| --- | --- |
| **Desktop** | Tag `v*` → `release.yml` → [`lane-release-desktop.yml`](.github/workflows/lane-release-desktop.yml) (macOS / Windows / Linux via `electron-builder`). |
| **Mobile** | A `release.yml` dispatch with `surfaces: mobile` only, never on `all` → [`lane-release-mobile.yml`](.github/workflows/lane-release-mobile.yml). |
| **Gateway** | The `centraid` binary: the container image ([`deploy/docker/Dockerfile`](deploy/docker/Dockerfile), [`lane-release-gateway-image.yml`](.github/workflows/lane-release-gateway-image.yml)), the OS service units `centraid gateway install` writes, and the VPS installer ([deploy/README.md](deploy/README.md)). |
| **Prebuilt core** | [`lane-prebuilt-core.yml`](.github/workflows/lane-prebuilt-core.yml), keyed by `cargo xtask artifact-key`. |
| **Companion extension** | [`lane-release-extension.yml`](.github/workflows/lane-release-extension.yml) (Chrome and Firefox builds). |

Signing residual: [docs/enrollment.md](docs/enrollment.md). Release ritual: [docs/release.md](docs/release.md). Versioning policy: [docs/decisions.md](docs/decisions.md) R1–R5.

## Runtime model: `conversation ⊃ turn ⊃ item`

Centraid's first principle is that **everything is agentic chat** — automation is a conversation whose other side is a deterministic script instead of a person, and whose transcript is durable. A chat window, an automation, and a workspace-capable assistant thread (`kind='build'` — the harness editing the Centraid workspace, not a retired app-authoring product) are each a single-kind conversation, recorded in one ledger (the **ledger band** of the per-vault `vault.db` — the old per-app `runtime.sqlite` and central `analytics.sqlite` became a per-vault `transcripts.db` in [#280](https://github.com/srikanth235/centraid/issues/280), then a band of `journal.db`, and [#916](https://github.com/srikanth235/centraid/issues/916) folded that second file into the vault beside the audit band). The vocabulary, per [`crates/vault/src/ledger/schema.rs`](crates/vault/src/ledger/schema.rs) (the DDL, also in [`contracts/schema/vault-ddl.sql`](contracts/schema/vault-ddl.sql)):

| Layer | What it is | Chat | Automation |
| --- | --- | --- | --- |
| **conversation** | the durable thread. `kind` ∈ `{chat, build, automation}` lives here. | the chat session | one long-lived conversation per automation ref |
| **turn** | one execution under it — `conversation_id` is a NOT-NULL, FK'd, CASCADE spine | one reply round | one headless compile or fire / `ctx.delegate` round |
| **item** | the ordered trace. `kind` ∈ `{message_in, step, tool, delegate}` | inbound message + steps + tool calls | inbound trigger + steps + tool/delegate calls |

`kind` lives on the **conversation**, not re-stamped per turn — a thread is single-kind. The inbound message (a person typing, a webhook firing, a cron tick) is a first-class `item` (`kind='message_in'`, ordinal 0); `step` is one primary model-inference call (per-call token + cost accounting); `tool`/`delegate` are per-call audit rows. Uploaded attachments ride the `message_in` item and are content-addressed on disk. Harness-created files may instead attach to a tool item as a workspace path + SHA-256 reference, with no duplicate CAS copy. `conversation_harness_sessions` holds one conversation's per-harness ACP resume handles, cumulative usage snapshots, hydration watermarks, and active/warm/cold/stale lifecycle; `conversations.harness_*` is the read-through active binding, so changing providers never changes the durable conversation id and A→B→A can resume A. `conversation_turn_locks` serializes the completed-turn/binding transaction, and `conversation_workspace_selection` persists the Centraid root plus explicitly shared realpaths. The tables are `conversations`, `conversation_harness_sessions`, `conversation_turn_locks`, `conversation_workspace_selection`, `conversation_provider_egress`, `harness_health`, `turns`, `items`, `attachments`, `automation_state`, and the `run_summary` view (see [`crates/vault/src/ledger`](crates/vault/src/ledger) — the vault crate owns the tables and their store code). There is no `run` layer and no `run_nodes` table — those were collapsed in issue #190.

Every caller reaches an installed CLI through `TurnPlane.runTurn`: chat and workspace (`build`) threads, interactive automation steering, headless compile, and `ctx.delegate`. Posture selects attended/unattended consent, failover boundary, permissions, and artifact capture; it does not select a second implementation. `HarnessSessions` owns bindings and 8,000-token / two-turn hydration plans per `(conversationRef, harnessKind)`, so two delegate calls in one fire resume and settle independently. The gateway injects its accounting-wrapped `runTurn` seam. Below that door, `HARNESSES` contains launch data only and the pinned stable `@agentclientprotocol/sdk` connection owns one session actor for its lifetime.

Automation instructions use `@[schema.table/id]` for stable entity references. The anchor-grade form is `@[core.link_anchor/<anchor_id>]`: the token carries no trusted row or field metadata. Before a compile turn reaches the model, the gateway resolves that id through a live `core_link_anchor` + `core_link`, re-matches its text selector against the source row, and derives the manifest's row filter and field mask from the vault-owned result. Missing, ended, or stale anchors fail the compile before the harness starts. Same-table anchors collapse into one bounded `in` filter only when they form a rectangular scope (the same referenced field set on every selected row); their rows are unioned and that shared field set is retained. Non-rectangular row/field combinations fail closed because the current conjunctive scope algebra cannot express them without granting a Cartesian-product widening. An unanchored type/row token retains the deliberately broader table-read behavior.

## Authorization and sharing

**Enrollment is full trust** ([#996](https://github.com/srikanth235/centraid/issues/996) R11). A device is an iroh EndpointId in the gateway's allowlist ([`crates/net/src/allowlist.rs`](crates/net/src/allowlist.rs) is the trait; [`crates/centraid/src/allowlist.rs`](crates/centraid/src/allowlist.rs) is the durable store in the vault file). Pairing redeems a one-shot ticket and enrolls the device in one call; only a hash of the ticket secret is stored. Revoking a device deletes its row, so unknown and revoked are the same refusal. The owner model and its vocabulary are in [docs/glossary.md](docs/glossary.md#owners-gateway-726) and [docs/decisions.md](docs/decisions.md#ownership-sharing-and-peer-transport).

**A deny is an outcome, not an exception.** [`crates/vault/src/access.rs`](crates/vault/src/access.rs) answers who is asking and what the answer narrows to, in a fixed order: a read-only device asking to act, an agent capped by its owner, the execution clamp (which narrows the owner too), owner-direct, the assistant riding an acting owner, and everything else through a `share_authority` row. A reveal of a sealed cell cannot be constructed for the `locker` schema at all: the Locker key `K` is minted by the seat that founds the vault and never enters the gateway's custody ([`crates/vault/src/custody`](crates/vault/src/custody/README.md)).

**The sharing plane is schema, not yet a delivery engine.** A share is a standing answer — `share_authority` (principal × subject × verb) — and whether it has reached its audience is `share_fulfillment`; a circle grant with `edit` is a subscription (`share_subscription`, `share_subscription_lineage`), and `share_party_vault_binding` proves which vault belongs to each party ([#883](https://github.com/srikanth235/centraid/issues/883), [#825](https://github.com/srikanth235/centraid/issues/825), [#929](https://github.com/srikanth235/centraid/issues/929)). All of these are in the baseline DDL ([`contracts/schema/vault-ddl.sql`](contracts/schema/vault-ddl.sql)) and are read by Docs' share fold ([`crates/apps/docs`](crates/apps/docs/README.md)) and People's sharing reading ([`crates/apps/people`](crates/apps/people/README.md)). No crate fulfils a grant, projects a closure into an audience vault, or runs a peer plane between gateways.

## Recognition automations (#731)

OCR, transcription, image/text embeddings, and faces are bundled deterministic automations on the same engine as every other background workflow. Each handler owns its ML implementation: it takes a bounded batch of 16, acquires vault content with `ctx.vault.content`, loads local model assets when its implementation needs them, invokes typed vault commands through `ctx.vault.invoke`, and stamps `enrich_derivation` with the pinned `model@version`. No separate inference process, HTTP service, `ctx.infer`, or `ctx.enrich` sits between the handler and the model. Cursor watermarks replace gateway-private backfill sweeps; a model/prompt revision re-arms only the affected template. Every bundled recipe ships **enabled** and runs an ambient cursor, `faces` included (ruled 2026-09-09 — see [docs/decisions.md](docs/decisions.md#recognition-automations-and-derived-data)); faces additionally serves its `enrich_request(capability='faces')` queue first inside the same batch, so an explicit ask outranks the library walk. Recognition is turned off per recipe or by the vault's `enrich_policy` tier, never asked for before the first scan.

**A unit of work that cannot be done is recorded and stepped over** ([#1014](https://github.com/srikanth235/centraid/issues/1014)). Two queues used to have exactly two answers for a piece of work — done, or nothing — and both meanings of "nothing" were wrong. A recognition walk is `asset_id`-ordered, so a target it could neither derive nor skip stopped every later photograph on every later tick while health reported `ok`; a trigger element whose handler came back not-ok was ACKNOWLEDGED, so a message that hit a transient error was consumed and never processed again. Both now count the failure where it happened — `enrich_target_failure` per `(capability, target)`, an attempts map inside the cursor's write-ahead batch per element — retry under a cap, and past it declare the unit dead: the enrichment target is `declined` and the walk advances, the trigger element is written to the cursor row's `dead_letter_json` with its error and reported to health and the member's notices BEFORE it is acknowledged. Neither queue may pass a unit it still owes, and neither may be stopped by one. See [docs/recognition-automations.md](docs/recognition-automations.md) and [docs/system-signals.md](docs/system-signals.md).

The synchronous capture and automation “Test run” surfaces use the same invoke-and-await fire path, so success, policy skips, missing local assets, model failures, and optional OCR delegate turns all produce ordinary automation ledger turns. OCR accepts both images and PDFs; PDFs use their text layer when present and render pages through the bundled image OCR path otherwise. Only OCR declares a delegate step. It is reached through `ctx.delegate`, requires a pinned harness model and provider-egress consent, preserves optional confidence rather than inventing it, and stamps only ACP-confirmed model identity.

## Tool surface: declared handlers + the vault register

An app declares **queries** (bounded reads) and **actions** (typed writes) in its `app.json`; the dispatcher (`packages/server/src/engine/handlers/dispatcher.ts`) validates input against the per-handler JSON Schema with Ajv, then runs the handler in a worker thread. The handler holds no database — every data touch goes through `ctx.vault`, crosses to the host, walks the consent pipeline, and comes back `executed` / `denied` / `parked` with a receipt id (issue #286 deleted the per-app `data.sqlite`, the `_sql` escape hatch, and the old `centraid_describe`/`centraid_read`/`centraid_write` tool trio). Agents see exactly one tool family — the **vault register**: `vault_sql` (one read-only statement over the whole vault), `vault_invoke` (one typed command, including every app's declared handlers), `vault_content` (the text of one document). UI buttons and `vault_invoke` land on the same handler — one calling convention. See the Apps § agents and Data § assistant docs at `https://centraid.dev/docs/apps/#agents` and `https://centraid.dev/docs/data/#assistant`.

Issue #630 makes that shared calling convention a release invariant for all eight bundled apps. `packages/blueprints/src/handler-reachability.test.ts` requires every manifested handler to have a web and native dispatch site or a named, rationale-bearing harness/extension/platform fallback. The same package owns behavioral handler CRUD, cold-read state honesty, untrusted rendering, and offline/convergence contracts. The harness parity integration test starts a real ACP subprocess, crosses the loopback MCP transport, and invokes one representative command per blueprint through `vault_invoke`; it asserts executed and parked consent outcomes plus their receipts.

The compound home surfaces remain gateway/vault projections rather than a new application database. Vault FTS fans one search across the eight entity families; household sharing projects a complete domain closure into an independent audience vault; and `GET /centraid/_brief/today` computes a bounded events/tasks/photos/Tally summary from the current vault. Clients render these projections from the same replica/HTTP contracts, while morning notifications contain only an opaque route back to Home.

The same journalled command path backs **Vault Atlas** (#441), the Operations screen that renders the model as **Kinds / Relations / Browse** (`packages/client/src/react/screens/AtlasScreen.tsx`): the Browse table editor dispatches `atlas.insert_row|update_row|delete_row` — never raw SQL, sealed columns refuse writes — and its dependent-aware deletes read the **entity-pointer declaration** (`packages/vault/src/schema/entity-refs.ts`), which names every `(type, id)` pair and the reasoned exclusions. Since [#916](https://github.com/srikanth235/centraid/issues/916) those pairs are composite foreign keys onto the `core.entity` supertype, so orphan cleanup is an engine cascade rather than a registry sweep; the declaration exists to describe dependents to Browse and to fail a test when a new pointer arrives undeclared.

## Connector pull runtime

Bundled pull connectors export a declarative `centraid.pull/v1` spec, not an imperative automation handler. A spec contains only a principal probe and a pull function that returns rows plus cursor updates. Its context exposes `now`, `input`, `abortSignal`, and broker-mediated `fetch`; it deliberately does not expose `vault`, `state`, `runs`, or `delegate`.

The automation engine resolves the manifest's durable `connectionId` before the worker runs, opens the sync run after the observed-principal probe, and owns pause/refusal gates, row staging, cursor persistence, and success/failure finalization. Pull-spec code therefore cannot supply or override `kind`, `label`, or `connection_id`, and two accounts of the same provider cannot collapse into a label-derived shadow connection.

Cursor semantics are explicit:

- `cursor.highWater(key)` retains the greatest observed provider value.
- `cursor.provider(key)` stores, replaces, or clears an opaque provider token.
- Offset paging is not a supported persisted strategy because mutable provider lists make offsets lossy.

The bundled blueprint guardrail in `packages/blueprints/src/app-manifests.test.ts` requires every `*-pull` template to use this protocol and pins its intended vault entity type.

## App render path

An app is a crate under [`crates/apps`](crates/apps): a read plane (queries as pure folds over `PageQuery` values, run against the seat's own copy of the vault) and an action table whose writes are `crates/vault`'s typed commands. Every app UI is first-party code shipped in the release ([docs/decisions.md](docs/decisions.md#product-positioning)); nothing serves app bytes.

- **Desktop** — the renderer ([`desktop/renderer`](desktop/renderer)) asks the `centraid seat` sidecar for **named** statements from the catalogue the sidecar holds, over the local socket described above.
- **Mobile** — the KMP shared module ([`mobile/shared`](mobile/shared)) drives screen machines over the core ABI; SwiftUI ([`mobile/iosApp`](mobile/iosApp)) and Compose ([`mobile/androidApp`](mobile/androidApp)) render the `centraid.screen.v1` state they are handed. There is no WebView in the app path.

## Responsiveness and the byte plane

A `call` has a budget: the `pr` profile's `call-budget` step (`cargo test -p centraid-core --test call_budget`) fails the gate on a bounded read over its ceiling, and the down-only ledgers in [`contracts/ledgers`](contracts/ledgers) hold the compile-time and library-size ceilings. Bytes never ride the row log: [`crates/blobs`](crates/blobs) moves BLAKE3-addressed blobs over a gated iroh lane, verified per chunk group and resumable at any interruption, and [`crates/media`](crates/media/README.md) owns the sealed frame format.

## Repository layout

```
.
├── crates/            # the Rust workspace — see the crate table above
├── contracts/         # fixtures, schema, migrations, screen fixtures, ledgers — read by every language
├── mobile/            # the KMP shared module, the Compose shell, the SwiftUI shell, Maestro flows
├── desktop/           # the Electron seat: electron/ (main), renderer/, e2e/
├── extension/         # the MV3 Companion over native messaging
├── packages/design/   # the design tokens (TypeScript), lowered into every surface
├── packages/test-kit/ # shared TypeScript test helpers
├── design/            # the emitted native theme, one artifact per surface
├── copy/              # one emitted copy leaf per app, read as text by the shells
├── deploy/            # the container image, the OS service units, the VPS installer
├── centraid-city/     # the static 3D explainer site
├── Cargo.toml         # the workspace: crates/* and crates/apps/*
└── rust-toolchain.toml
```

**SQL is confined** to `crates/{ontology,vault,seat,search}` and `crates/apps/kit` (the gate's `sql-confinement` rule); `crates/net` is the only crate that names an iroh type; `crates/protocol` names none.

## On-disk layout

A gateway's data dir (`centraid gateway --data-dir`; `centraid gateway install` defaults it to `~/Library/Application Support/Centraid` on macOS and `$XDG_DATA_HOME/centraid` or `~/.local/share/centraid` on Linux — [`crates/centraid/src/cmd/gateway_install.rs`](crates/centraid/src/cmd/gateway_install.rs)) holds `vault/<vaultId>/vault.db`, `keys/`, `blobs/` and a `snapshots/` scratch directory ([`crates/centraid/src/cmd/mod.rs`](crates/centraid/src/cmd/mod.rs)). Without `--data-dir` the gateway runs in memory and says so.

`vault.db` is one file: the model, the append-only audit band, the conversation-ledger band and the device allowlist, in one ACID boundary and one migration ladder ([`crates/vault/src/migrations.rs`](crates/vault/src/migrations.rs), [`contracts/migrations`](contracts/migrations)). [`Vault::commit`](crates/vault/src/file.rs) is the only writable connection the crate hands out; `Vault::read` sets `query_only`.

### At-rest formats

| Slot | Format | Protected by | A copy without custody yields |
| --- | --- | --- | --- |
| `keys/<name>` | `KeyStore` envelope: `CENTRAID-KEY-V1` then `{scheme, payload}`, mode `0600` | `aes-256-gcm-v1` under a host wrapping key, or `file-0600-v1` (permissions only, adoption) | Ciphertext under `aes-256-gcm-v1`; **the raw secret** under `file-0600-v1` |
| `vault/<id>/vault.db` | SQLite; declared sealed columns are `sealed:v1:` AES-256-GCM under the vault DEK with a per-cell AAD | The DEK in `keys/` | Everything except the sealed columns. Locker secret values are `lk1:` ciphertext under `K`, which no gateway holds |
| `blobs/` | BLAKE3-addressed content | Filesystem permissions | Plaintext bytes |
| Backup generation | A complete base copy, sealed WAL segments and a `centraid-snapshot/2` manifest ([`crates/vault/src/backup`](crates/vault/src/backup)) | The backup keyring | Ciphertext |
| Recovery kit | `centraid-recovery-kit-wrap-v1`: scrypt (N = 2¹⁷, r = 8, p = 1) + AES-256-GCM ([`crates/vault/src/backup/kit.rs`](crates/vault/src/backup/kit.rs)) | Its **password**, held only by the owner | Ciphertext. The kit carries the keyring and the DEKs, so its password is load-bearing custody |

The layers and their AADs are in [`crates/vault/src/custody/README.md`](crates/vault/src/custody/README.md). At-rest wrapping does not bound a **local** attacker at the owner's uid; the OS user boundary is the primary local boundary ([SECURITY.md](SECURITY.md)).

## Backup and recovery

`BackupPolicy` ([`crates/vault/src/backup/policy.rs`](crates/vault/src/backup/policy.rs)) sets the snapshot interval and the WAL RPO: a generation is a complete base copy plus the sealed WAL segments after it, and a restore replays the base and then the segments, with `--at` stopping the replay early. The verbs are `centraid backup`, `centraid export` (a snapshot generation plus a password-wrapped recovery kit), `centraid recover` (rebuild from a kit, reading its password from a file, never a flag) and `centraid doctor` (read-only and lock-free, so it is safe against a serving gateway). The `release` profile's `restore-drill` step proves a restore end to end. Runbooks: [docs/recovery/](docs/recovery/).

## Device replicas

The gateway is the single canonical writer; every seat holds **the vault**, not a shape of it ([#996](https://github.com/srikanth235/centraid/issues/996) R1, R2). A table replicates only if the ontology's registries classify it ([`crates/ontology/src/registries.rs`](crates/ontology/src/registries.rs)); private tables — credentials, key material, job machinery — stay on the gateway.

A seat needs two things from the gateway: **the file, once** — a sanitised snapshot at a named log position ([`crates/vault/src/snapshot.rs`](crates/vault/src/snapshot.rs)) — and **the log, forever after** ([`crates/vault/src/log`](crates/vault/src/log)), captured inside the originating transaction by `Vault::commit` and carried in `centraid.core.v1` messages. The seat's applier ([`crates/seat`](crates/seat/README.md)) applies one transaction per commit with its cursor in it, upserts rather than replaces, checks the schema epoch per row, and drops a row at or below its applied sequence before binding it.

Offline writes are **intents** kept in `seat_outbox` inside the seat's own `vault.db`, so an executed answer clears its overlay in the transaction that carries its commit, and the queue survives restart and re-bootstrap. Replaying an intent returns the same durable outcome rather than re-running it; consent still applies, so an intent can settle `parked`. `row_version` is the optimistic-concurrency check ([`crates/seat/src/occ.rs`](crates/seat/src/occ.rs)). This is how the single-writer star supports fully offline devices with no CRDTs and no multi-master. The deterministic simulation in [`crates/sim`](crates/sim/README.md) checks the plane's invariants over scripted networks.

## Cron catch-up policy

The gateway's cron scheduler is in-process and intentionally does not backfill after sleep, restart, or downtime. Missed fire times are skipped rather than burst-executed; one bounded missed-window ledger entry per affected automation records the earliest missed fire for operator visibility. The next ordinary minute resumes normal scheduling. `packages/server/src/automation/fire/scheduler-ledger.contract.test.ts` is the executable contract for this policy.

## Build orchestration

Rust builds with cargo from the root workspace; `cargo xtask gate --profile <local|pr|nightly|release|mobile-jvm>` is the gate ([`crates/xtask`](crates/xtask/README.md), [TESTING.md](TESTING.md)). Mobile builds with Gradle (`./gradlew -p mobile …`) and the iOS project is generated by XcodeGen from [`mobile/iosApp/project.yml`](mobile/iosApp/project.yml); both link the core through `crates/core-ffi` ([mobile/README.md](mobile/README.md)). Bun runs the TypeScript that remains — `packages/design`, `packages/test-kit`, `desktop/`, `extension/` and the repository's tooling scripts — with oxlint/oxfmt and vitest.

## Cross-surface design tokens

[`packages/design`](packages/design) is the single source of truth for visual and identity decisions. The desktop renderer consumes its CSS lowering; `contracts/tools/export-native-theme.ts` emits the native theme under [`design/`](design) for the mobile shells, and [`crates/design`](crates/design/README.md) is its Rust lowering, generated from a corpus the TypeScript emits. The pipeline and its gates are [docs/design-machinery.md](docs/design-machinery.md).
