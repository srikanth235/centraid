# Current decisions

This file is the adjudication layer over the repository's append-only evidence. It records the decisions that are in force, deliberate non-goals, and supersession chains that keep old evidence from being mistaken for current truth. The linked issues and receipts carry the rationale and implementation history; this file carries the current answer. Update a row when the answer changes and link the issue that settles the change.

## Foundational decisions

| Id | Current decision |
| --- | --- |
| **H1** | The gateway runs detached. Desktop launches `centraid-gateway` as a child that outlives the app window; the in-process path is test-only and requires `CENTRAID_EMBEDDED_GATEWAY=1`. See [ARCHITECTURE.md](../ARCHITECTURE.md). |
| **C1** | There are no fallback paths for an unsupported protocol or capability. The client shows an update wall; protocol parsing remains strict and graceful. See [protocol.md](protocol.md). |
| **Signing** | Enroll in Apple Developer Program, Azure Trusted Signing, and Play App Signing. Human steps live in [enrollment.md](enrollment.md). |
| **J7** | Mobile uses store releases as the routine path. `expo-updates` is configured as a dormant, already-shipped-version recovery lane; CI does not run `eas update`. |
| **D4** | Patch releases contain fixes only. Added, changed, or removed product behavior is minor before 1.0; agents never propose a major. See [release.md](release.md). |
| **D5** | Beta is desktop-only; TestFlight and Play internal track are mobile beta channels; web is continuous on `app.centraid.dev`. Stable download and `latest` image targets never move for beta. |
| **R1** | One product version stamps the monorepo. A surface may skip shipping a version but never carries a divergent package version. |
| **R2** | Build numbers derive from product semver. A store resubmission without product change is not supported; cut a patch instead. |
| **R3** | Protocol version is the runtime connection comparator. Product version is display-only; capability flags gate features. |
| **R4** | Product tags ship desktop, gateway image, and gateway npm by default. Mobile is dispatch-opt-in; web/docs are continuous on main. |
| **R5** | A failed build is retried or rebuilt; product semver is not bumped solely to make a build pass. |
| **F1** | 1.0 begins when every schema change ships a migration. Before 1.0, epoch changes may require vault recreation and the handshake refuses mismatches. |
| **H5** | OS service installation is opt-in and default-off. The LaunchAgent label is `dev.centraid.gateway`. |
| **J1** | GitHub Actions holds the Android upload key; Google Play App Signing holds the release key. |
| **J4** | Secrets use platform secure storage (`expo-secure-store`, Keychain, or Android Keystore), never plaintext. |
| **J5** | The reverse-DNS root is `dev.centraid`; the full table is [identifiers.md](identifiers.md). |
| **K5** | The PWA manifest id is `/`, so future `start_url` changes do not orphan installs. |
| **I12** | What's new is sourced from GitHub Releases; desktop opens it at most once per product version. |
| **L1 / E2** | PRs run unit, integration, contract, boot-smoke, and path-filtered client e2e; nightly owns full cross-client, performance, scale, mutation, mobile, and pairing lanes. See [TESTING.md](../TESTING.md). |
| **L3** | [TESTING.md](../TESTING.md) is the winning test contract; a contradictory suite README is corrected. |

## Superseded decision pointers

| Former decision | Current pointer |
| --- | --- |
| **T1 / #505 direct transport** | Superseded by [#555](https://github.com/srikanth235/centraid/issues/555): gateway connections are Iroh-only and identified by `EndpointId`; the original transport rationale remains in [#505](https://github.com/srikanth235/centraid/issues/505). |
| **#298 erase posture** | Superseded and amended by [#555](https://github.com/srikanth235/centraid/issues/555) and [#603](https://github.com/srikanth235/centraid/issues/603); current erase/restore behavior is the backup-plane `centraid-gateway recover` contract. |
| **#599 member/role model** | Superseded by [#726](https://github.com/srikanth235/centraid/issues/726); current authority is one owner per vault. |
| **#724 enrichment service** | Superseded by [#731](https://github.com/srikanth235/centraid/issues/731); current recognition runs inside bundled handlers. |

## Gateway founding and recovery

A fresh gateway founds itself: it creates `Shared` and `Personal` and enrolls the host device as owner on both. An existing data directory is never modified by founding. There is one ticket concept — the pair ticket — and web/PWA and mobile onboarding are ticket-only. The former founding ceremony and `vaults:initialize` / `vaults:restore` routes are not part of the current surface. Recovery kits remain a backup-plane export and are consumed by `centraid-gateway recover`. Settled in [#603](https://github.com/srikanth235/centraid/issues/603).

## Ownership, sharing, and peer transport

The current authority model from [#726](https://github.com/srikanth235/centraid/issues/726) is:

- `vault_owners(vault_id PRIMARY KEY, owner_id)` structurally enforces one owner per vault. Role enums and the `member_roles` table are not part of the model.
- A proved device identity binds to an owner; authorization asks which owner the device proves and whether that owner owns the vault. Device capability masks remain orthogonal.
- Sharing is placement, not row filtering. Give is a receiver-owned snapshot; Commons is circle-backed co-owned residency with domain rows and blobs in each joined vault.
- `share_edges` is the snapshot placement primitive. `vault_links` is the one permission table for local and remote vaults; locality changes routing, not sharing semantics.
- The peer ALPN forwards into the gateway's existing local HTTP surface. Rust transports bytes; TypeScript owns identity, consent, authorization, and persistence.

The current authentication boundary is transport-first: Iroh `EndpointId` proves the device, and custody of the data directory proves the host. There is no password/session/OIDC plane. This remains the standing security decision from [#599](https://github.com/srikanth235/centraid/issues/599), except that the owner model above supersedes its role vocabulary.

## Commons

Commons is circle-backed, steward-serialized multi-writer state from [#731](https://github.com/srikanth235/centraid/issues/731). The steward orders member-signed commands into a monotonic log; members apply checkpoint plus tail and compute balances from identical rows. Non-steward writes require the bound vault signature and fresh nonce. v0 uses deterministic last-write-wins by steward sequence; invalid commands are refused rather than surfaced as retriable conflicts.

The proposed fixed-window replacement for steward-side ack-gated compaction is **not adopted**. The current `share_commons_cursor` ack and retention behavior remains until unconditional checkpoint digest verification and real dogfood lag measurements justify a change. The instrumentation is exposed through the commons diagnostics described in [logs.md](logs.md#commons-sync-observability-731); the proposal and its rejected alternatives live in [#731](https://github.com/srikanth235/centraid/issues/731).

## Recognition automations and derived data

Recognition is self-contained automation. `photo-ocr`, `transcript`, `embed-image`, `embed-text`, and `faces` read bytes through `ctx.vault.content`, run their bundled implementation, and persist through `ctx.vault.invoke`. The automation engine owns scheduling, consent, retries, cursor watermarks, and ledger history. There is no service wire, `ctx.infer`, or `ctx.enrich`; only OCR may use the explicit consented `ctx.delegate` variant. Device-side model inference is not part of the product; clients consume replicated derived rows. See [recognition-automations.md](recognition-automations.md) and [Photos derived ledger](photos/derived-ledger.md).

Faces consume only an open `enrich_request(capability='faces')` or a prior consent stamp. `media.forget_person` removes regions, embeddings, derivation stamps, and clusters. `enrich_derivation` is the provenance record, and model upgrades are backfills that leave older rows serving until replacements land.

## Blueprint-readiness policies

The current cross-app policies from [#630](https://github.com/srikanth235/centraid/issues/630) are:

| Topic | Current decision |
| --- | --- |
| Schema migrations | New blueprint-readiness data uses ordered real-vault-preserving migrations; pre-1.0 recreation is not permission to erase a real vault. |
| Backup and restore | Schema and recovery evidence land together; snapshot/restore and restore-after-erase retain new rows. |
| Notification permission | Request permission when the first reminder is created, never at launch; a denial leaves an actionable Settings path. |
| Local OCR | The bundled `photo-ocr` handler is the local path; an explicit provider-egress-consented OCR delegate is optional. |
| Quick add | Deterministic rules route unambiguous input; ambiguous input gets a bounded delegate preview and nothing commits before confirmation. |
| Google OAuth | BYO client is the path for Calendar/Contacts until Assist's verification evidence is accepted. |
| Push | Expo Push is wake-only and content-free; the gateway remains canonical and resident-device notifications are the local fallback. |

## Typography and design contracts

The design contract is binding in [DESIGN.md](../DESIGN.md) and lowered by `@centraid/design`. Shared semantic roles use one spelling across shell, blueprint, and native lowerings; size and line-height may differ by renderer, while family and weight express the role. The composable `--t-*-size` rungs are the supported escape from shorthand font roles, and `kit.css` consumes them rather than owning a second scale. The `--t-tiny` family/weight exception remains explicit in the role-parity contract until a separately named eyebrow role can replace it. See [design machinery](design-machinery.md) and [#686](https://github.com/srikanth235/centraid/issues/686).

The seat and north-star contract is orthogonal to form factor: mobile is `origin`, desktop is `custodian`, and web/PWA is `viewer`; record-only apps use replica data, byte-bearing apps use the custody triple. Locker is disabled on the viewer seat, and Photos uses a merged timeline plus automatic frame-owned backup. See [blueprint seats](blueprint-seats.md).

## Inline system apps and served apps

The eight bundled system apps are inline React routes in the shared shell. Their reads, subscriptions, and writes use `ReplicaShellSession`; writes carry `intentId`, and the apps render from the replica offline. Served builder/code-store apps remain opaque iframe documents with the existing bridge, CSP, and postMessage settings path. The app-scoped RPC surface is `/centraid/<app>/actions|queries/<name>`; the former shared admin token plane is retired in favor of revocable owner enrollment. Full render-path details live in [ARCHITECTURE.md](../ARCHITECTURE.md#app-render-paths). Settled by [#505](https://github.com/srikanth235/centraid/issues/505).

## Performance and Rust byte plane

The constrained gateway profile keeps request p99 ≤ 250 ms, event-loop p99 ≤ 150 ms, RSS ≤ 512 MiB, and bounded fsync, physical-write, and idle-work ceilings. Node remains the gateway runtime until Bun supports `node:sqlite` and passes the same durability suite. Five designs — dependency-aware read cache, compiled consent decisions, incremental materializations, verified boot snapshot, and lazy vault mount — remain evidence-gated; eager mounting is current because missed wakeups are correctness failures.

The Rust `packages/tunnel/data-plane` service moves bounded bytes only. TypeScript chooses the authorized object, route, headers, range, provider operation, and expiry; Rust validates the ticket, confines paths, caps transforms, and streams with backpressure. Rust never owns identity, consent, journal, replica, agent, or automation decisions. See [ARCHITECTURE.md](../ARCHITECTURE.md#performance-and-byte-plane-boundary) and [#456](https://github.com/srikanth235/centraid/issues/456).

## Product grammar and block composition

The product grammar is the current design contract, not a migration plan: semantic roles, lowerings, recipes, icon/identity/formatter contracts, and reference states are enforced by [DESIGN.md](../DESIGN.md), [design machinery](design-machinery.md), and their tests. The former plan's durable outcome is that app identity and action colour remain separate, host appearance owns appearance, and mobile consumes `toNativeTheme()` without CSS parsing. See [#690](https://github.com/srikanth235/centraid/issues/690) and its review closure [#695](https://github.com/srikanth235/centraid/issues/695).

The headless block logic lives in `@centraid/design/blocks`. React DOM composition is still split between shell and inline blueprint markup; the consolidation remains a follow-up tracked by [#765](https://github.com/srikanth235/centraid/issues/765). Served custom elements are a distinct rendering technology and keep their own implementation.

## Related docs

| Doc | Current contract |
| --- | --- |
| [protocol.md](protocol.md) | Two-contract, COMPAT, wire-purity, RPC, and stream authority rules |
| [release.md](release.md) | Versioning, surfaces, release gates, and recovery |
| [identifiers.md](identifiers.md) | `dev.centraid.*` identifiers |
| [enrollment.md](enrollment.md) | Human signing and public-service setup |
| [TESTING.md](../TESTING.md) | PR/nightly lanes and app admission |
| [SECURITY.md](../SECURITY.md) | Threat model and automated security gates |
