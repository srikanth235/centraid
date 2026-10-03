# Architecture

**The phone is the vault.** Centraid v0 is one Rust core running on a phone as the vault's sole authority and sole writer, a Kotlin Multiplatform shell with native SwiftUI and Compose views, and one or more **gateways** the member controls — the laptop at home, a VPS, a NAS — each running `centraid-gateway` as a **blind store** for the phone's sealed backup, reached over direct HTTPS with a certificate the phone pinned at pairing. Recovery is 24 words. There is no hosted tier, no account, no sharing, and no client but the phone — [#1029](https://github.com/srikanth235/centraid/issues/1029) and the [scope amendment of 2026-09-21](https://github.com/srikanth235/centraid/issues/1029#issuecomment-5755559795), with the backup rebuilt from first principles by [#1080](https://github.com/srikanth235/centraid/issues/1080); the rulings are in [decisions.md](docs/decisions.md#the-phone-is-the-vault--v0-1029-ruled-2026-09-21) and [decisions.md](docs/decisions.md#backups-from-first-principles-1080).

The TypeScript implementation that preceded all of this was removed in [#1020](https://github.com/srikanth235/centraid/issues/1020); compatibility with its artifacts is not a constraint, and v0's own artifacts are pre-release regression vectors rather than a format commitment ([D-1020-R1, dropped](docs/decisions.md#supersessions-closed-by-1029)).

## The shape, in one paragraph

The phone opens `vault.db` locally and writes to it with no network in the path. A **snapshot** copies the live file page for page with SQLite's online backup API, cuts it into 64 KiB ranges named from their own bytes, and seals each — as it seals every original and derivative the vault knows by hash — in `centraid-sealed/2`, under names and keys derived from the 24 words. A **pass** asks a gateway which of those names it lacks, uploads only those, records each acknowledgement in a device-local ledger, and moves the gateway's head to the newest snapshot's manifest under a compare-and-set; on iOS the operating system uploads the sealed files while the app is suspended. The gateway stores ciphertext under names it cannot invert, and can decrypt none of it. A **restore** on a fresh phone takes the 24 words and a gateway's pairing payload, rebuilds the file from the head's ranges, checks it, claims the vault at the next writer epoch, and then fetches every derivative so the grid is whole. Pairing is a gateway printing a QR and the phone scanning it.

## Two programs

| Program | What it is |
| --- | --- |
| **the core, on the phone** (`crates/core` through `crates/core-ffi`) | The vault's authority and its single writer. Holds `vault.db`, the content store, the backup ledger and spool, and the gateway client. It **dials** and accepts nothing. |
| **`centraid-gateway`, on a machine the member controls** (`crates/gateway`) | A blind store. Holds sealed objects, each vault's head, snapshot list and writer epoch, the tombstones and the sweeps. It never holds a key, a plaintext byte, a plaintext hash or a schema. |

`centraid` is a third, small binary for the operator: `centraid doctor` checks a vault file read-only and lock-free, and its verbs are in [`crates/centraid/README.md`](crates/centraid/README.md#subcommands). Nothing it does is on a serving path.

`open` never blocks on the network: it opens the file, runs migrations and returns. Every transport call is a request the shell makes afterwards.

## The crates

| Crate | What it is |
| --- | --- |
| [`identity`](crates/identity) | The whole identity model: one 24-word phrase, a SLIP-0010 hardened tree under it, each vault's identity key — which signs a gateway claim — and root key, HPKE to a box key, and safety numbers. |
| [`ontology`](crates/ontology/README.md) | The schema authority: open a vault file, know its shape, verify it. The version window, the golden-corpus comparison, the commitments and the doctor. |
| [`vault`](crates/vault/README.md) | The vault file. One writable connection behind `Vault::commit`, the typed command registry, per-command authorization, custody, and the whole backup plane — snapshot, ranges and manifest, ledger, spool, mover, retention, restore and the drill. It also holds the tree's one civil-time and recurrence engine and the vault operations tier. |
| [`core`](crates/core/README.md) | The message loop: `open`, `call`, `next_event`, `close`. One handle, one role, a bounded coalescing event queue that drops nothing. |
| [`core-ffi`](crates/core-ffi/README.md) | Exactly five exported C symbols and [`CONTRACT.md`](crates/core-ffi/CONTRACT.md)'s ten clauses, one test per clause, `nm` over the built `cdylib` as a second question, and a committed cbindgen header. |
| [`gateway`](crates/gateway) | The gateway protocol v2 and its one deployment. `rules` is every route's decision with no I/O, no clock and no randomness, plus the conformance suite; `server` is axum over rustls with the minted certificate, the SQLite state, the filesystem store, the sweeps, the Bonjour advertisement and the CLI; `client` is the phone's half, trusting exactly one pinned certificate. The workspace's **only** listener, confined to `server/serve.rs` and checked there by `no-listening-socket`. |
| [`api-proto`](crates/api-proto/README.md) | The schema workspace: `centraid.core.v1` and `centraid.screen.v1`, with `buf breaking` per package. Bodies on the wire are JSON; these files stay the schema of record for the shapes ([R-1029-3](docs/decisions.md#the-phone-is-the-vault--v0-1029-ruled-2026-09-21)). |
| [`protocol`](crates/protocol/src/lib.rs) | What is left of the wire protocol: request-id multiplexing and the version window, both read by the core's **call door** rather than by a network. |
| [`media`](crates/media/README.md) | The byte formats: `centraid-sealed/2` (`media::sealed`), the one format every object a gateway stores wears, and the derivative renditions. |
| [`blobs`](crates/blobs) | One content store per vault: a plain directory of files named by their BLAKE3, written through a staged file, verified on read. |
| [`search`](crates/search/README.md) | The FTS door. Every `MATCH` statement in the workspace lives here, and a sealed column cannot be indexed or returned. |
| [`design`](crates/design/README.md) | One lowering of `packages/design` into Rust, generated from a corpus the TypeScript emits. |
| [`apps/kit`](crates/apps/kit/README.md) | What an app is allowed to do: the paged-read grammar as data, `Money`, the door's statement builder, the fixture generators. An app crate holds no SQL and no `Connection`. |
| [`apps/tally`](crates/apps/tally/README.md) · [`photos`](crates/apps/photos/README.md) · [`notes`](crates/apps/notes/README.md) · [`docs`](crates/apps/docs/README.md) · [`people`](crates/apps/people/README.md) · [`locker`](crates/apps/locker/README.md) · [`agenda`](crates/apps/agenda/README.md) · [`tasks`](crates/apps/tasks/README.md) | One crate per app: the read plane (queries as pure folds over `PageQuery` values) and the action table. The writes are `crates/vault`'s typed commands. |
| [`centraid`](crates/centraid/README.md) | The operator's binary. |
| [`xtask`](crates/xtask/README.md) | The cross-cutting gate. `cargo xtask gate --profile <local\|pr\|nightly\|release\|mobile-jvm>` is the only entrypoint CI runs. |

**SQL appears only under `crates/{ontology,vault,search}` and `crates/apps/kit`**, enforced structurally by the gate's `sql-confinement` rule — the gateway's own `state.db` statements are files `crates/gateway` includes, never string literals. It has shaped real APIs rather than being routed around: the restore drill's vault-side work lives in `crates/vault` because nothing else may hold SQL, and `crates/core` serialises calls through one mutex because a reader pool would need `PRAGMA` statements.

**No crate depends on iroh.** `iroh`, `iroh-blobs` and `iroh-dns-server` left `Cargo.lock` with the carrier they served ([#1080](https://github.com/srikanth235/centraid/issues/1080), [R-1080-1](docs/decisions.md#backups-from-first-principles-1080)).

## The shell

**Mobile** ([`mobile/`](mobile/README.md)) is the only shell. One KMP shared module holds screen state machines, navigation, the pass, pairing and platform services behind expect/actual, over the five-function ABI (JNA on JVM and Android, cinterop on iOS). SwiftUI ([`mobile/iosApp`](mobile/iosApp)) and Jetpack Compose ([`mobile/androidApp`](mobile/androidApp)) render finished state messages and own nothing, except what only a platform can do: the background `URLSession` that moves sealed files on iOS while the app is suspended, the scheduled windows on both, and the walkers that read the camera roll where it lives. Screen states and events are `centraid.screen.v1` protobuf; `commonMain` has no platform import, enforced by Konsist. `call` is never invoked from a UI thread — a debug assertion in both actuals says so, and a `call` budget in the `pr` profile fails the gate on a request that exceeds it.

What exists today is Home and every first-party app: Photos (library, shelves, viewer, editor, places, people and face review, duplicates, memories, collections, search and the album picker — [docs/photos/](docs/photos/README.md#the-apps-screens-and-where-v0s-fourteen-routes-went)); Agenda — home, event and editor ([#1046](https://github.com/srikanth235/centraid/issues/1046)); Tasks, People, Docs, Notes and Tally in full; and Locker, behind the phone's own biometric or passcode ([#1047](https://github.com/srikanth235/centraid/issues/1047), [D-5](docs/decisions.md#the-owners-rulings-of-2026-09-25-1047)). The custody screens are the 24 words — `words.make` (mint, show once, check three, found keyed), `words.enter` (restore, and re-key from Locker's wall) and `words.show` (behind the owner check) — and `pair.laptop`, which takes the payload `centraid-gateway pair` prints, pasted or scanned ([R-1047-E1…E14](docs/decisions.md#the-24-words-on-the-phone-1047-e1)); the band's More sheet opens the last two. Home carries one backup line and the Backup screen lists the paired gateways with the rule and **Back up now**, both read from the core's backup status ([#1080](https://github.com/srikanth235/centraid/issues/1080)). The device hand-offs are tracked in [docs/release/v1-handoffs.md](docs/release/v1-handoffs.md).

**A screen reads one of two ways, and neither joins tables in the shell.** A **page read** (`Request::Page`) is one table through the page door. An **app query** (`Request::AppQuery`, [`app_query.proto`](crates/api-proto/proto/centraid/core/v1/app_query.proto)) names a registered query from an app crate; `crates/core/src/app_query.rs` runs it over the same page door and answers a typed message from the app's own `<app>.proto`. Every read that joins, expands a repeating series or folds a ledger is an app query, so there is **one query engine and one recurrence engine**, both in Rust ([R-1046-1](docs/decisions.md#agenda-on-the-phone-1046)). Civil time is the core's: a query states the device's zone (`DeviceClock`, read at every request) and the core answers `today`, `now_local` and every local reading in it.

**The screens are built from one kit on three layers** ([#1047](https://github.com/srikanth235/centraid/issues/1047)): the KMP laws in `mobile/shared/.../kit` (paging, band, search, autosave, writes, trash, the bridge), the `// --- Kit ---` messages in `screen.proto`, and a native kit on each shell (`iosApp/Sources/Kit`, `androidApp/.../kit`) that draws the rooms of [DESIGN.md](DESIGN.md). An app is registered with one file and one line per shell (`AppRegistry.apps`, `MainActivity.routes`). The recipe is [mobile/README.md](mobile/README.md#the-kit-the-app-queries-and-adding-an-app-screen).

There is **no desktop shell and no browser extension in v0** — see [R-1029-1](docs/decisions.md#the-phone-is-the-vault--v0-1029-ruled-2026-09-21) for what the deferral buys and the one prerequisite that un-defers it.

## The gateway, and what crosses to it

The protocol, a gateway's commands, its data directory, self-hosting and the versioning policy are one page: [docs/gateway.md](docs/gateway.md). In summary: twelve routes under `/v2`, over HTTPS straight to the machine — no relay, no certificate authority, no domain and no DNS service in the path ([R-1080-1](docs/decisions.md#backups-from-first-principles-1080)) — with a self-signed certificate the gateway minted at its first `serve`, whose BLAKE3 fingerprint the pairing QR carries and the phone pins. A bearer token minted at pairing authorises each request for one vault at one writer epoch; JSON bodies for small things and raw bytes for objects; every refusal a code rather than a sentence. HTTPS rather than anything else because the only transfer iOS continues while an app is suspended is a file upload to a URL ([R-1080-2](docs/decisions.md#backups-from-first-principles-1080)).

**What crosses to a gateway** is ciphertext, names, sizes and times — never a plaintext byte, a plaintext hash or a key. A name is a keyed hash only the vault's keys reach, so a gateway cannot tell which file an object is, nor that two vaults hold the same photograph; a part's key derives from the vault's backup key and a random salt in the part's own header. A conformance test in `crates/gateway` scans a gateway's store and state for every plaintext, plaintext hash and key the test put through it.

**The phone writes to every gateway it can reach.** The pairing record is a list, the LAN gateway is preferred when home, and v1 reaches a gateway on the LAN or at any address the phone can dial directly ([R-1080-8](docs/decisions.md#backups-from-first-principles-1080), [R-1080-9](docs/decisions.md#backups-from-first-principles-1080)). Gateway-to-gateway mirroring is designed and not built.

## Contracts, fixtures and ledgers

[`contracts/`](contracts/README.md) is the layer every language reads: the frozen golden vault and its manifest, the DDL, the schema registries, the migration ladder, one parity bundle per app, the screen fixtures, the crypto vectors, and the down-only ledgers (`gate-budgets`, `compile-time`, `library-size`). The parity bundles were generated by executing the retired TypeScript implementation before it was removed in [#1020](https://github.com/srikanth235/centraid/issues/1020); they are frozen goldens now, compared whole by the Rust tests. A parity fixture is **canonicalised rows plus the committed DDL**, not a database file, because a founded vault mints ids off the clock and is not byte-reproducible.

The corpus and the ladder head are **two fixtures with two generators and two drift checks** ([R-1029-4](docs/decisions.md#the-phone-is-the-vault--v0-1029-ruled-2026-09-21)): `contracts/golden/issue-1020/` is the frozen historical record, and `contracts/schema/vault-ddl.sql` is regenerated from a founded vault. The migration ladder is **appended to, never edited**: a vault's `user_version` names the rung it reached, and two builds that disagree about a rung's bytes disagree about what a vault at that version holds ([R-1029-5](docs/decisions.md#the-phone-is-the-vault--v0-1029-ruled-2026-09-21)).

Every prebuilt core artifact is keyed on the content digest of `crates/**` and `contracts/**` plus schema, target triple, feature set, toolchain and profile; the binary embeds `{git_sha, digest, schema_version}` and the shell reads it at `open` and refuses a mismatch.

## Release surfaces

One product version stamps the repository; a surface may skip a release but not diverge its stamp. [`release.yml`](.github/workflows/release.yml) plans a tag or a dispatch and calls one `lane-release-*.yml` per surface.

| Surface | How it ships |
| --- | --- |
| **Mobile** | A `release.yml` dispatch with `surfaces: mobile` only, never on `all` → [`lane-release-mobile.yml`](.github/workflows/lane-release-mobile.yml). |
| **Gateway** | The `centraid-gateway` binary: the container image ([`lane-release-gateway-image.yml`](.github/workflows/lane-release-gateway-image.yml)), the OS service units `centraid-gateway install` writes, and the installer ([deploy/README.md](deploy/README.md)). |
| **Prebuilt core** | [`lane-prebuilt-core.yml`](.github/workflows/lane-prebuilt-core.yml), keyed by `cargo xtask artifact-key`. |

Signing residual: [docs/enrollment.md](docs/enrollment.md). Release ritual: [docs/release.md](docs/release.md). Versioning policy: [docs/decisions.md](docs/decisions.md) R1–R5.

## Authorization

**One owner per vault, and the phone is the boundary.** There is no second principal on the phone: `api::invoke` takes its principal from the handle. A gateway request is authorised by a **bearer token** the gateway minted at pairing and keeps only as a hash: it names one vault and one writer epoch, and it opens nothing — it lets the phone read that vault's ciphertext and, at the current epoch, write more. A restore or a takeover claims the next epoch with a signature by the vault's identity key, after the snapshot it fetched passed its checks; from then on the old phone's writes are refused `MOVED` and it freezes read-only (`ERROR_CODE_VAULT_MOVED`).

The vault's access plane has no reveal judgement at all — `Verb` is `read` and `act` ([R-1047-D2](docs/decisions.md#the-sealedv1-cell-layer-and-the-retired-locker-generation-deleted-1047)) — so no access path can open a Locker cell: the Locker key `K` is derived from the 24 words at `seed / vault'(i) / locker'` (`crates/identity/src/derive.rs`), held only in the core's memory and never written down, so a restore from the words reopens sealed secrets ([Q-1047-11](docs/decisions.md#locker-on-the-phone-1047-d-5)). The unlock boundary is `crates/core/src/locker/phone.rs`: `K` enters the Locker session only after the shell reports that the phone's biometric or passcode prompt succeeded (D-5), a member's typed secret is sealed there before the vault sees the command, and a reveal writes its receipt before the value exists and lives `REVEAL_WINDOW_MS`.

**There is no sharing plane.** Share feeds, share capabilities, the link ceremony, the mailbox and every `share_*` table were deleted rather than parked — see the amendment, executed in W16 and W19.

## Recognition

**There is no recognition plane in v0.** The enrichment worker (`crates/automations` over `crates/assist`) and every `enrich.*` command it wrote through were deleted with the assistant and automation planes in [#1029](https://github.com/srikanth235/centraid/issues/1029) — `crates/vault/tests/commands.rs` asserts the registry holds no `enrich.*`. The derivation tables (`enrich_derivation`, `media_face_region` and their siblings) are still in the schema and no production path inserts into them — only the fixture generators do — so Photos' face surfaces read tables that stay empty on a real vault; whether to delete those surfaces or propose on-device detection is an open owner question ([docs/decisions.md](docs/decisions.md#the-app-ports-and-the-shell-kit-1047)). [docs/recognition-automations.md](docs/recognition-automations.md) is kept as the record of the v0 design and is marked superseded.

## The app surface

An app is a crate under [`crates/apps`](crates/apps): a read plane (queries as pure folds over `PageQuery` values, run against the vault on the device — the phone reaches them as app-query arms) and an action table whose writes are `crates/vault`'s typed commands. Every app UI is first-party code shipped in the release ([docs/decisions.md](docs/decisions.md#product-positioning)); nothing serves app bytes, and there is no third-party app plane. The KMP shared module drives screen machines over the core ABI and the native views render the `centraid.screen.v1` state they are handed. **There is no WebView in the app path.**

## Responsiveness and the byte plane

A `call` has a budget: the `pr` profile's `call-budget` step fails the gate on a bounded read over its ceiling, and the down-only ledgers in [`contracts/ledgers`](contracts/ledgers) hold the compile-time and library-size ceilings. Bytes never ride inside a row: [`crates/blobs`](crates/blobs) is the content store, files named by their BLAKE3, and [`crates/media`](crates/media/README.md) owns the sealed part format. A file is hashed and sealed in the same stream, so the phone reads a camera-roll original once, and a snapshot costs hashing the file plus sealing the ranges that changed — off the request path, never under a commit.

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
├── deploy/            # the container image, the OS service units, the installer
├── scripts/           # repo tooling, the docs site, the release surface register
├── centraid-city/     # the static 3D explainer site
├── Cargo.toml         # the workspace: crates/* and crates/apps/*
└── rust-toolchain.toml
```

## On-disk layout

**On the phone**, the shell hands the core a directory per vault. Under it sit `vault.db` with its `-wal` and `-shm`; the content store `<stem>.bytes/`, a directory of files named by their hash, holding derivatives and the originals that have no home in the operating system's library; the backup ledger `<stem>.backup.db`; the spool `<stem>.spool/` of sealed parts waiting to move; and `<stem>.keep-originals.json`, the albums kept out of **Free up space**. The ledger, the spool and the keep list are **device-local state, deliberately not in the vault**: a snapshot of the vault never carries the state of its own upload, and a restored phone must not inherit a dead phone's facts about its own disk ([W15-D1](docs/decisions.md#w15--the-phones-request-contract-1029)'s argument). Every one of those paths is excluded from the OS backup ([R-1029-8](docs/decisions.md#the-phone-is-the-vault--v0-1029-ruled-2026-09-21)); exclusion does not inherit, so each is named. A photograph or a video in the operating system's library is **not copied in**: the core streams it once through hash and seal, and the ledger records where its bytes live ([R-1080-6](docs/decisions.md#backups-from-first-principles-1080)). The 64-byte seed lives in the Keychain or the Keystore and crosses the C ABI at `centraid_open`, borrowed for the length of the call ([W15-D2](docs/decisions.md#w15--the-phones-request-contract-1029)); `crates/core` writes no key to disk.

**On a gateway**, `centraid-gateway --data-dir` holds `tls.key`, `tls.crt` and `gateway.id` (minted once at the first `serve`, mode 0600 — the identity every paired phone pins), `state.db` (the vaults and their epochs, the token and secret hashes, heads and snapshots, the object index) and `objects/`. There is no vault there and no key that opens one, and the directory copied anywhere is the same gateway.

`vault.db` is one file: the model, the append-only audit band and the device register, in one ACID boundary and one migration ladder ([`crates/vault/src/migrations.rs`](crates/vault/src/migrations.rs), [`contracts/migrations`](contracts/migrations)). [`Vault::commit`](crates/vault/src/file.rs) is the only writable connection the crate hands out; `Vault::read` sets `query_only`. The whole pragma set is stated on every connection — see [docs/traps/wal-checkpoint.md](docs/traps/wal-checkpoint.md).

### At-rest formats

| Slot | Format | Protected by | A copy without custody yields |
| --- | --- | --- | --- |
| The phone's `vault.db` | SQLite. The only encrypted cells are Locker's secret values, `lk1:` AES-256-GCM under `K` with a `<rowId>‖<keyId>` AAD; there is no other cell key ([R-1047-D2](docs/decisions.md#the-sealedv1-cell-layer-and-the-retired-locker-generation-deleted-1047)) | The device, and the OS backup exclusion | Everything except Locker's secret values, which stay `lk1:` ciphertext under `K` |
| The 24 words | BIP39, 256 bits of entropy, no passphrase | The member, written down; the seed in the synced keychain (this phone only where the platform will not sync it) and the words in this phone's device-only store ([R-1047-E6, E10](docs/decisions.md#the-24-words-on-the-phone-1047-e1)) | Every vault the member has ever had |
| A part on a gateway | `centraid-sealed/2`: a 30-byte clear header (magic, version, flags, part index, part length, a random 16-byte salt), then 4 MiB chunks of XChaCha20-Poly1305 with the header in every chunk's AAD; the key is `derive_key("centraid backup v2 object", K_backup ‖ salt)`, and the part is stored under `hex(keyed_hash(K_name, h ‖ u32be(i)))` ([R-1080-B1](docs/decisions.md#the-sealed-format-and-the-snapshot-plane-1080-wave-1-lane-b)). Ranges and manifests are zstd-compressed before sealing; media is not | The vault's backup key, derived from the 24 words | Ciphertext, its size, a part index and a salt — nothing that names the file, its hash or its length |
| A snapshot manifest | A part like any other: sealed JSON naming the snapshot's ranges, its page size and length, its `db_hash` and its census | The same | Ciphertext |
| The ledger on the phone | SQLite (`application_id` `CBL1`): the paired gateways — addresses, pinned certificate, token, epoch — the queue, the confirmations, the snapshots, and where each content hash's bytes are | The device, and the OS backup exclusion | The tokens that read and write those vaults' ciphertext on those gateways, and the list of names |
| A gateway's `tls.key` | ECDSA P-256 private key, PKCS#8 PEM, mode 0600 | Filesystem permissions | The ability to impersonate that gateway to its paired phones — which gains an attacker ciphertext and the ability to refuse or lose, and nothing about any vault |

The Locker cell format and its AAD are in [`crates/vault/src/custody/README.md`](crates/vault/src/custody/README.md); the sealed part format is [`crates/media/src/sealed.rs`](crates/media/src/sealed.rs), pinned by `contracts/crypto/sealed-vectors.json`. At-rest wrapping does not bound a **local** attacker at the owner's uid; the OS user boundary is the primary local boundary ([SECURITY.md](SECURITY.md)).

## Backup and recovery

**"Backed up" means the gateway acknowledged that object and the phone recorded the acknowledgement durably** ([R-1080-7](docs/decisions.md#backups-from-first-principles-1080)). The vault's database plus the 24 words is the whole index: every object's name and key derive from the vault's backup key and the plaintext hash of its file, which the vault already stores for every content item and derivative — there is no custody table and no placement row ([R-1080-4](docs/decisions.md#backups-from-first-principles-1080)).

- **The vault's records** are backed up as **snapshots**, not as a log ([R-1080-5](docs/decisions.md#backups-from-first-principles-1080)): taken hourly while a gateway is reachable on an unmetered link, on **Back up now**, when the app leaves the screen, and after a restore. An unchanged 64 KiB range keeps its name, so a snapshot uploads only what changed; the phone keeps 7 daily, 4 weekly and 6 monthly snapshots and collects every name nothing it keeps refers to.
- **Media is backed up from where it lives** ([R-1080-6](docs/decisions.md#backups-from-first-principles-1080)): each original in the operating system's library is streamed once through hash and seal into a bounded spool and never copied into the app's sandbox; the app's own store holds derivatives and the originals with no library home. An owned original may be evicted once acknowledged and not in a kept album.
- **A pass** prepares (seals what no gateway has confirmed, under the member's transfer rule), moves (to the preferred reachable gateway; on iOS the system's background `URLSession` carries handed-off files while the app is suspended) and settles (records acknowledgements, moves the head). The ledger is reconciled against each gateway's `exists` answer on every launch, so it is a cache of the gateway's truth and cannot drift.

Restore is the 24 words and a gateway's pairing payload on a fresh install: rows first — the head's snapshot rebuilt and checked before anything is claimed — then the grid, every derivative fetched in bundles, then originals. The `restore-drill` step of every gate profile proves the chain end to end. Runbooks: [docs/recovery/](docs/recovery/).

**The backup is as off-site as the member's gateways are.** A laptop-only backup is a local one — fire or theft takes phone and laptop together. A second gateway elsewhere, paired from the phone, is the off-site copy ([Q-1029-6](docs/decisions.md#open-questions-for-the-owner-1029), answered by [R-1080-8](docs/decisions.md#backups-from-first-principles-1080)).

## Build orchestration

Rust builds with cargo from the root workspace; `cargo xtask gate --profile <local|pr|nightly|release|mobile-jvm>` is the gate ([`crates/xtask`](crates/xtask/README.md), [TESTING.md](TESTING.md)). Mobile builds with Gradle (`./gradlew -p mobile …`) and the iOS project is generated by XcodeGen from [`mobile/iosApp/project.yml`](mobile/iosApp/project.yml) — a generated-and-committed pair, with the trap that comes with it ([docs/traps/generated-and-committed.md](docs/traps/generated-and-committed.md)). Both link the core through `crates/core-ffi` ([mobile/README.md](mobile/README.md)). Bun runs the TypeScript that remains — `packages/design`, `packages/test-kit` and the repository's tooling scripts — with oxlint/oxfmt and vitest.

## Cross-surface design tokens

[`packages/design`](packages/design) is the single source of truth for visual and identity decisions. `contracts/tools/export-native-theme.ts` emits the native theme under [`design/`](design) for the mobile shells, and [`crates/design`](crates/design/README.md) is its Rust lowering, generated from a corpus the TypeScript emits. The pipeline and its gates are [docs/design-machinery.md](docs/design-machinery.md).
