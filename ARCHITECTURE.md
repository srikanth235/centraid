# Architecture

**The phone is the vault.** Centraid v0 is one Rust core running on a phone as the vault's sole
authority and sole writer, a Kotlin Multiplatform shell with native SwiftUI and Compose views, and
a laptop the member owns running `centraid-gateway` as a **blind store** for the phone's sealed
backup. Recovery is 24 words. There is no hosted tier, no account, no sharing, and no client but
the phone — [#1029](https://github.com/srikanth235/centraid/issues/1029) and the [scope amendment of
2026-09-21](https://github.com/srikanth235/centraid/issues/1029#issuecomment-5755559795), recorded in
[decisions.md](docs/decisions.md#the-phone-is-the-vault--v0-1029-ruled-2026-09-21).

The TypeScript implementation that preceded all of this was removed in
[#1020](https://github.com/srikanth235/centraid/issues/1020); compatibility with its artifacts is
not a constraint, and v0's own artifacts are pre-release regression vectors rather than a format
commitment ([D-1020-R1, dropped](docs/decisions.md#supersessions-closed-by-1029)).

## The shape, in one paragraph

The phone opens `vault.db` locally and writes to it with no network in the path. `crates/vault`'s
commit hook captures the WAL frames each commit produced, seals them as `centraid-object/1` objects
of at most 16 MiB, and spools them. A **drain** uploads that spool to the laptop and commits a
manifest entry under a `prev_head` compare-and-set; the laptop verifies that every object's name is
the BLAKE3 of its bytes and stores it, and can decrypt none of it. A **restore** on a fresh phone
takes the 24 words, derives the vault's keys, finds the laptop, opens the newest manifest and lays
down the base and its segments. Pairing is the laptop showing its endpoint id as a QR and the phone
scanning it.

## Two programs

| Program | What it is |
| --- | --- |
| **the core, on the phone** (`crates/core` through `crates/core-ffi`) | The vault's authority and its single writer. Holds `vault.db`, the spool, the blob store and the gateway client. It **dials** and accepts nothing. |
| **`centraid-gateway`, on the laptop** (`crates/gateway-server`) | A blind store. Holds sealed objects, the manifest head, the lease, quotas and retention. It never holds a key, a plaintext byte or a schema. |

`centraid` is a third, small binary: `centraid gateway install` writes an OS service unit for a
gateway and prints the command that enables it, and `centraid doctor` checks a vault file read-only
and lock-free. Neither is on a serving path.

`open` never blocks on the network: it opens the file, runs migrations and returns. Every transport
call is a request the shell makes afterwards.

## The crates

| Crate | What it is |
| --- | --- |
| [`identity`](crates/identity) | The whole identity model: one 24-word phrase, a SLIP-0010 hardened tree under it, device certificates with monotonic epochs, HPKE to a box key, safety numbers, the pkarr record and the pair ticket. |
| [`ontology`](crates/ontology/README.md) | The schema authority: open a vault file, know its shape, verify it. The version window, the golden-corpus comparison, the commitments and the doctor. |
| [`vault`](crates/vault/README.md) | The vault file. One writable connection behind `Vault::commit`, the typed command registry, per-command authorization, the running census, custody, and the whole backup plane — capture, base, segment, manifest, spool, restore and the drill. It also holds the tree's one civil-time and recurrence engine and the vault operations tier. |
| [`core`](crates/core/README.md) | The message loop: `open`, `call`, `next_event`, `close`. One handle, one role, a bounded coalescing event queue that drops nothing. |
| [`core-ffi`](crates/core-ffi/README.md) | Exactly five exported C symbols and [`CONTRACT.md`](crates/core-ffi/CONTRACT.md)'s ten clauses, one test per clause, `nm` over the built `cdylib` as a second question, and a committed cbindgen header. |
| [`gateway-core`](crates/gateway-core/README.md) | The protocol's **rules**, with no I/O, no clock and no ambient randomness: request signing, the lease, declare and commit, the compare-and-set, retention, purge, scrub and the conformance suite. The deployment is not the reference implementation; this crate and its suite are. |
| [`gateway-server`](crates/gateway-server/README.md) | The one deployment: axum over two carriers, the filesystem byte store, tenancy, the sweeps and the service install. The workspace's **only** listener, confined to `serve.rs` and checked there by `no-listening-socket`. |
| [`gateway-client`](crates/gateway-client) | The phone's half: request signing, the spool's upload batching, publish and directory resolution, and the iroh transport that dials and offers no ALPN. |
| [`api-proto`](crates/api-proto/README.md) | The schema workspace: `centraid.core.v1` and `centraid.screen.v1`, with `buf breaking` per package. Bodies on the wire are JSON; these files stay the schema of record for the shapes ([R-1029-3](docs/decisions.md#the-phone-is-the-vault--v0-1029-ruled-2026-09-21)). |
| [`protocol`](crates/protocol/src/lib.rs) | What is left of the wire protocol: request-id multiplexing and the version window, both read by the core's **call door** rather than by a network. |
| [`media`](crates/media/README.md) | The byte plane: sealed frames and the format-normative crypto every backup and snapshot artefact is built from. |
| [`blobs`](crates/blobs) | One content store per vault: BLAKE3-addressed, chunked, resumable, and able to express a blob this device holds only part of. Nothing is inlined. |
| [`search`](crates/search/README.md) | The FTS door. Every `MATCH` statement in the workspace lives here, and a sealed column cannot be indexed or returned. |
| [`design`](crates/design/README.md) | One lowering of `packages/design` into Rust, generated from a corpus the TypeScript emits. |
| [`apps/kit`](crates/apps/kit/README.md) | What an app is allowed to do: the paged-read grammar as data, `Money`, the door's statement builder, the fixture generators. An app crate holds no SQL and no `Connection`. |
| [`apps/tally`](crates/apps/tally/README.md) · [`photos`](crates/apps/photos/README.md) · [`notes`](crates/apps/notes/README.md) · [`docs`](crates/apps/docs/README.md) · [`people`](crates/apps/people/README.md) · [`locker`](crates/apps/locker/README.md) · [`agenda`](crates/apps/agenda/README.md) · [`tasks`](crates/apps/tasks/README.md) | One crate per app: the read plane (queries as pure folds over `PageQuery` values) and the action table. The writes are `crates/vault`'s typed commands. |
| [`centraid`](crates/centraid/README.md) | The operator's two verbs: `gateway install` and `doctor`. |
| [`xtask`](crates/xtask/README.md) | The cross-cutting gate. `cargo xtask gate --profile <local\|pr\|nightly\|release\|mobile-jvm>` is the only entrypoint CI runs. |

**SQL appears only under `crates/{ontology,vault,search}` and `crates/apps/kit`**, enforced
structurally by the gate's `sql-confinement` rule. It has shaped real APIs rather than being routed
around: the restore drill's vault-side work lives in `crates/vault` because nothing else may hold
SQL, and `crates/core` serialises calls through one mutex because a reader pool would need `PRAGMA`
statements.

**`crates/gateway-server` and `crates/gateway-client` are the only crates that name an iroh type**,
and `crates/protocol` names none.

## The shell

**Mobile** ([`mobile/`](mobile/README.md)) is the only shell. One KMP shared module holds screen
state machines, navigation, the drain and pair flows, and platform services behind expect/actual,
over the five-function ABI (JNA on JVM and Android, cinterop on iOS). SwiftUI
([`mobile/iosApp`](mobile/iosApp)) and Jetpack Compose ([`mobile/androidApp`](mobile/androidApp))
render finished state messages and own nothing. Screen states and events are `centraid.screen.v1`
protobuf; `commonMain` has no platform import, enforced by Konsist. `call` is never invoked from a
UI thread — a debug assertion in both actuals says so, and a `call` budget in the `pr` profile fails
the gate on a request that exceeds it.

What exists today is the navigation model, the screen machines, Home, the Tally list, the Photos
grid, the Notes editor, and the `Pair` and `Restore` flows; the rest of the mobile screen surface is
unbuilt and tracked in [docs/release/v1-handoffs.md](docs/release/v1-handoffs.md).

There is **no desktop shell and no browser extension in v0** — see
[R-1029-1](docs/decisions.md#the-phone-is-the-vault--v0-1029-ruled-2026-09-21) for what the deferral
buys and the one prerequisite that un-defers it.

## The gateway, and what crosses to it

The protocol, the laptop's setup, self-hosting and the versioning policy are one page:
[docs/gateway.md](docs/gateway.md). In summary: seven HTTP routes under `/v1`, every request signed
by the phone's device key over a length-prefixed preimage and carrying the device certificate that
chains to the vault identity key; JSON bodies; every refusal a code rather than a sentence. The
default carrier is **iroh** — the same HTTP/1.1 over one bidirectional stream under ALPN
`centraid-gateway/1` — so a laptop behind NAT needs no port forwarding and no certificate. A
self-hoster with a domain may run the TCP carrier instead, behind a proxy or with ACME.

## Contracts, fixtures and ledgers

[`contracts/`](contracts/README.md) is the layer every language reads: the frozen golden vault and
its manifest, the DDL, the schema registries, the migration ladder, one parity bundle per app, the
screen fixtures, the crypto vectors, the origin-matching spec, and the down-only ledgers
(`gate-budgets`, `compile-time`, `library-size`). The parity bundles were generated by executing
the retired TypeScript implementation before it was removed in
[#1020](https://github.com/srikanth235/centraid/issues/1020); they are frozen goldens now, compared
whole by the Rust tests. A parity fixture is **canonicalised rows plus the committed DDL**, not a
database file, because a founded vault mints ids off the clock and is not byte-reproducible.

The corpus and the ladder head are **two fixtures with two generators and two drift checks**
([R-1029-4](docs/decisions.md#the-phone-is-the-vault--v0-1029-ruled-2026-09-21)):
`contracts/golden/issue-1020/` is the frozen historical record, and `contracts/schema/vault-ddl.sql`
is regenerated from a founded vault. The migration ladder is **appended to, never edited** — a
rung's comment text trains the backup dictionary
([docs/traps/migration-header-is-a-format.md](docs/traps/migration-header-is-a-format.md)).

Every prebuilt core artifact is keyed on the content digest of `crates/**` and `contracts/**` plus
schema, target triple, feature set, toolchain and profile; the binary embeds
`{git_sha, digest, schema_version}` and the shell reads it at `open` and refuses a mismatch.

## Release surfaces

One product version stamps the repository; a surface may skip a release but not diverge its stamp.
[`release.yml`](.github/workflows/release.yml) plans a tag or a dispatch and calls one
`lane-release-*.yml` per surface.

| Surface | How it ships |
| --- | --- |
| **Mobile** | A `release.yml` dispatch with `surfaces: mobile` only, never on `all` → [`lane-release-mobile.yml`](.github/workflows/lane-release-mobile.yml). |
| **Gateway** | The `centraid-gateway` binary: the container image ([`deploy/gateway-server/Dockerfile`](deploy/gateway-server/Dockerfile), [`lane-release-gateway-image.yml`](.github/workflows/lane-release-gateway-image.yml)), the OS service units `centraid-gateway install` writes, and the installer ([deploy/README.md](deploy/README.md)). |
| **Prebuilt core** | [`lane-prebuilt-core.yml`](.github/workflows/lane-prebuilt-core.yml), keyed by `cargo xtask artifact-key`. |

Signing residual: [docs/enrollment.md](docs/enrollment.md). Release ritual:
[docs/release.md](docs/release.md). Versioning policy: [docs/decisions.md](docs/decisions.md) R1–R5.

## Authorization

**One owner per vault, and the device is the boundary.** There is no second principal on the phone:
`api::invoke` takes its principal from the handle. A gateway request is authorized by a **device** —
a key the shell mints and keeps in the platform secure store marked this-device-only and never
synced, certified by the vault's identity key at an epoch
([W15-D3](docs/decisions.md#w15--the-phones-request-contract-1029)). The lease accepts only an epoch
above the one it holds, so a restored phone at `epoch + 1` freezes the old one with
`ERROR_CODE_VAULT_MOVED`.

A reveal of a sealed cell cannot be constructed for the `locker` schema at all: the Locker key `K`
is minted on the device and never leaves it ([`crates/vault/src/custody`](crates/vault/src/custody/README.md));
the unlock boundary is `crates/core/src/locker`, where `K` becomes plaintext only for
`REVEAL_WINDOW_MS` after the owner has proved they are present.

**There is no sharing plane.** Share feeds, share capabilities, the link ceremony, the mailbox and
every `share_*` table were deleted rather than parked — see the amendment, executed in W16 and W19.

## Recognition automations

OCR, transcription, image and text embeddings, and faces are bundled deterministic derivations the
phone runs on its own bytes. Each handler owns its ML implementation: it takes a bounded batch,
acquires vault content, invokes typed vault commands and stamps `enrich_derivation` with the pinned
`model@version`. No separate inference process and no HTTP service sits between the handler and the
model. Recognition is turned off per recipe or by the vault's `enrich_policy` tier, never asked for
before the first scan.

**A unit of work that cannot be done is recorded and stepped over**
([#1014](https://github.com/srikanth235/centraid/issues/1014)). A recognition walk is
`asset_id`-ordered, so a target it could neither derive nor skip would stop every later photograph
while health reported `ok`. Failures are counted where they happen — `enrich_target_failure` per
`(capability, target)` — retried under a cap, and past it the target is `declined` and the walk
advances. See [docs/recognition-automations.md](docs/recognition-automations.md) and
[docs/system-signals.md](docs/system-signals.md).

## The app surface

An app is a crate under [`crates/apps`](crates/apps): a read plane (queries as pure folds over
`PageQuery` values, run against the vault on the device) and an action table whose writes are
`crates/vault`'s typed commands. Every app UI is first-party code shipped in the release
([docs/decisions.md](docs/decisions.md#product-positioning)); nothing serves app bytes, and there is
no third-party app plane. The KMP shared module drives screen machines over the core ABI and the
native views render the `centraid.screen.v1` state they are handed. **There is no WebView in the app
path.**

## Responsiveness and the byte plane

A `call` has a budget: the `pr` profile's `call-budget` step fails the gate on a bounded read over
its ceiling, and the down-only ledgers in [`contracts/ledgers`](contracts/ledgers) hold the
compile-time and library-size ceilings. Bytes never ride inside a row: [`crates/blobs`](crates/blobs)
moves BLAKE3-addressed blobs in chunks, resumable at any interruption, and
[`crates/media`](crates/media/README.md) owns the sealed frame format.

## Repository layout

```
.
├── crates/            # the Rust workspace — see the crate table above
├── contracts/         # fixtures, schema, migrations, screen fixtures, ledgers — read by every language
├── mobile/            # the KMP shared module, the Compose shell, the SwiftUI shell, Maestro flows
├── packages/design/   # the design tokens (TypeScript), lowered into every surface
├── packages/test-kit/ # shared TypeScript test helpers
├── design/            # the emitted native theme, one artifact per surface
├── copy/              # one emitted copy leaf per app, read as text by the shells
├── deploy/            # the container images, the OS service units, the installer
├── scripts/           # repo tooling, the docs site, the release surface register
├── centraid-city/     # the static 3D explainer site
├── Cargo.toml         # the workspace: crates/* and crates/apps/*
└── rust-toolchain.toml
```

## On-disk layout

**On the phone**, the shell hands the core a directory. Under it sit `vault.db` with its `-wal` and
`-shm`, the spool, the blob store, the thumbnail cache and `backup/laptop.json` — the paired
laptop's `EndpointId`, which is device-local derived state and deliberately **not** in the vault
([W15-D1](docs/decisions.md#w15--the-phones-request-contract-1029)). Every one of those paths is
excluded from the OS backup on iOS
([R-1029-8](docs/decisions.md#the-phone-is-the-vault--v0-1029-ruled-2026-09-21)); exclusion does not
inherit, so each is named. The 64-byte seed lives in the Keychain or the Keystore and crosses the C
ABI at `centraid_open`, borrowed for the length of the call
([W15-D2](docs/decisions.md#w15--the-phones-request-contract-1029)); `crates/core` writes no key to
disk.

**On the laptop**, `centraid-gateway --data-dir` holds `node.key` (minted once, mode 0600 — the
identity every paired phone dials), the state file, and the object store. There is no vault there
and no key that opens one.

`vault.db` is one file: the model, the append-only audit band and the device register, in one ACID
boundary and one migration ladder ([`crates/vault/src/migrations.rs`](crates/vault/src/migrations.rs),
[`contracts/migrations`](contracts/migrations)). [`Vault::commit`](crates/vault/src/file.rs) is the
only writable connection the crate hands out; `Vault::read` sets `query_only`. The whole pragma set
is stated on every connection — see
[docs/traps/wal-checkpoint.md](docs/traps/wal-checkpoint.md).

### At-rest formats

| Slot | Format | Protected by | A copy without custody yields |
| --- | --- | --- | --- |
| The phone's `vault.db` | SQLite; declared sealed columns are `sealed:v1:` AES-256-GCM under the vault DEK with a per-cell AAD | The device, and the OS backup exclusion | Everything except the sealed columns. Locker secret values are `lk1:` ciphertext under `K` |
| The 24 words | BIP39, 256 bits of entropy, no passphrase | The member, and the synced keychain | Every vault the member has ever had |
| A backup object | `centraid-object/1`: a sealed frame under a per-object key derived from the vault's root key, with kind and role bound into the AAD, padded by Padmé, named by the BLAKE3 of its bytes | The vault's root key, derived from the 24 words | Ciphertext, and a size class |
| A generation manifest | The same, plus the zstd dictionary the generation was sealed against, uncompressed and inside the seal | The same | Ciphertext |
| `node.key` on the laptop | Raw iroh secret key, mode 0600 | Filesystem permissions | The laptop's network identity, and nothing about any vault |

The layers and their AADs are in [`crates/vault/src/custody/README.md`](crates/vault/src/custody/README.md).
At-rest wrapping does not bound a **local** attacker at the owner's uid; the OS user boundary is the
primary local boundary ([SECURITY.md](SECURITY.md)).

## Backup and recovery

A generation is a **base** — page-aligned 4 MiB ranges of the live file, sealed — plus the sealed WAL
**segments** above it, chained by a manifest whose head moves under a compare-and-set. Capture is
commit-driven and debounced, not on a timer. A drain uploads the spool and commits **one manifest
entry per batch**, so a background window that ends mid-pass still advances the acked txid
([W15-D4](docs/decisions.md#w15--the-phones-request-contract-1029)).

Restore is the 24 words on a fresh install: derive the vault keys, resolve or scan the laptop, open
the newest manifest, lay the base down and replay the segments. The `release` profile's
`restore-drill` step proves it end to end. Runbooks: [docs/recovery/](docs/recovery/).

**A laptop-only backup is a local backup.** Fire or theft takes phone and laptop together; v0
accepts this and an off-site copy is a later proposal
([Q-1029-6](docs/decisions.md#open-questions-for-the-owner-1029)).

## Build orchestration

Rust builds with cargo from the root workspace;
`cargo xtask gate --profile <local|pr|nightly|release|mobile-jvm>` is the gate
([`crates/xtask`](crates/xtask/README.md), [TESTING.md](TESTING.md)). Mobile builds with Gradle
(`./gradlew -p mobile …`) and the iOS project is generated by XcodeGen from
[`mobile/iosApp/project.yml`](mobile/iosApp/project.yml) — a generated-and-committed pair, with the
trap that comes with it ([docs/traps/generated-and-committed.md](docs/traps/generated-and-committed.md)).
Both link the core through `crates/core-ffi` ([mobile/README.md](mobile/README.md)). Bun runs the
TypeScript that remains — `packages/design`, `packages/test-kit` and the repository's tooling
scripts — with oxlint/oxfmt and vitest.

## Cross-surface design tokens

[`packages/design`](packages/design) is the single source of truth for visual and identity
decisions. `contracts/tools/export-native-theme.ts` emits the native theme under [`design/`](design)
for the mobile shells, and [`crates/design`](crates/design/README.md) is its Rust lowering, generated
from a corpus the TypeScript emits. The pipeline and its gates are
[docs/design-machinery.md](docs/design-machinery.md).
