# `centraid-apps-photos` — the library as a projection

Photos is the largest app in the product: 21,348 lines of v0 TypeScript, 8 queries, 18 actions, 38 scopes over five schemas and a 551-line demo seed. This crate is the read plane and the action table; the writes are `crates/vault`'s `media` schema, and the bytes are `crates/media`'s.

| Module | What it is |
| --- | --- |
| `manifest` | v0's `app.json`, byte for byte, parsed by the kit's parser at load time. Two copies of "which tables does Photos write" is how the two answers drift. |
| `queries` | `library` and `search`: the asset columns, the `IN`-bounded joins, the star derived from the flags scheme, and the keyset cursor. |
| `storage` | The custody sweep as a **three-state** summary. `computed_at` and `buckets` are `Some` together or `None` together, so "not counted yet" cannot be printed as zeroes. |
| `faces` | `faces`, `face-queue` and `people`, with the four traps ported as tests. |
| `duplicates` | A **read** over the cluster id a sweep computed. The clustering is `centraid_media::duplicates`. |
| `enrichment` | A read-only mirror of `enrich.policy`, three-state over a closed `Tier`. |
| `places` | The Places facet, inside Photos. A location is a phrase before it is a pin. |
| `commands` | The eighteen actions as command invocations, `invoke_key` mandatory. |

## Six rulings this crate is shaped by

Every one of them is an answer to a way the port could have been wrong, and every one has a test named after it.

**D-1020-P1 — the storage answer is three states, not a number.** `blob_custody_rollup.computed_at` is `NOT NULL`, so a null `computedAt` means *no rows*, not a row with no timestamp — two facts that travel together and are one fact. `StorageSummary` makes that a type, and `an_unswept_vault_never_yields_zeroes` is the test. `local-unproven` is a type-level marker rather than a flag: `offerable_release` hands back a `Freeable`, and there is no constructor for one from the unproven bucket, because releasing an unproven original destroys the only copy.

**D-1020-P2 — the face queue keeps its four traps.** Confidence is a **match count**, an integer, deduped by photograph — the detector's `[0,1]` score is a different field with a different name (`detector_confidence`). The filter is on `review_state`, never on `confirmed_by_party_id`, and a rejection keeps its row so the enricher cannot propose the same stranger again. "First seen" is the earliest `captured_at` among the matches and **`None` when none has one** — no proposal time is invented. `QUEUE_LIMIT` 60, `REGION_ROWS` 4,000 and `PARTY_ROWS` 500 are reachable bounds that report the size they reach.

**D-1020-P3 — duplicates read, never compute.** There must be exactly one clustering: a second implementation inside the query would agree with the sweep until the threshold moved, and then disagree silently at the boundary where a member is deciding what to delete.

**D-1020-P4 — enrichment status is a mirror.** `tier ∈ off | device | gateway`, with `local`/`model` read forward and never written back. **A denial is not `off`**: telling a member their recognition is switched off when the app lost its grant is the bug `Reading<Tier>` prevents.

**D-1020-P5 — the Places facet stays here.** There is no `crates/apps/places`. The phrase logic is the load-bearing half: in a **shared** context the relative rung is skipped, because "5.2 km NW of Home" hands a stranger a bearing to the member's house — and `printable_name` refuses a coordinate-shaped name at every rung, so a gazetteer that wrote digits into `name` cannot leak them.

**D-1020-P11 — the library window is one page, and the port says so.** `media_asset.captured_at` is nullable, and the kit's door refuses a **continued** page over a nullable sort key because SQLite's row-value comparison puts every NULL on one side of the keyset and the walk silently drops them. So the declared 2,000-row window is unreachable by a walk. v0 arrives at the same place by accident — it asks for 2,000 as one page and the clamp gives it 500 — and the difference is the report: `window` says what was asked, `truncated` is the page's own cursor, and a surface continues with `before`. The remedy for the ceiling is a **typed cursor** on the app's `before` input, which is a manifest input-schema change and therefore the root's.

## What stops this crate doing more

| Not allowed | What stops it |
| --- | --- |
| SQL, in any form | `cargo xtask rules`' `sql-confinement` scans this crate and finds none; a statement here is a `PageQuery` — a projection, a `from`, a predicate and an order, as data |
| A model, a codec or a hash | recognition is the automations lane's and the byte plane is `crates/media`'s; the dependencies are the kit and `serde` |
| A write from a query | `queries` holds statements and a `PageDoor`, whose one method reads |
| An invocation with no `invoke_key` | the field is required (D-1020-D3-5) |
| A denial turned into an error | `Outcome::Denied` and `Reading::Denied` are states a surface renders |
| A failed read folded into a `0` | every three-state answer models the third state explicitly |

## Two gates, never one

The manifest's `confirmation: "required"` is what the **dispatching surface** asks before sending, and Photos declares it on `purge-asset` and `delete-album`. A command definition's `confirm: true` parks a **non-owner** invocation regardless of risk, and in the whole `media` schema exactly one command carries it — `media.forget_person`, which no Photos action invokes. Collapsing the two would add a dialog in front of a member's own purge and drop the park in front of an agent's.

## Fixtures

- `crates/apps/photos/tests/parity.rs` folds all eight queries over a vault seeded by `centraid_apps_kit::fixtures::photos_demo` — v0's own nineteen-frame roll, transcribed as data — inside a database built from `contracts/schema/vault-ddl.sql`.
- `contracts/apps/photos/sample/manifest.json` records every shipped frame's pixel dimensions and asserts the `THUMB_EDGE` coupling: every frame is ≤ 360 px on its long edge **on purpose**, so a tile paints the original instead of probing a `?variant=thumb` derivative the preview backstop has not generated. Nothing on either side tested that before.
- `contracts/apps/photos/queries.json` — v0's own answers — is **not committed yet**. `contracts/apps/photos/manifest.json` declares `fixtures: "pending-regeneration"` with the exact command, and a test asserts that declaration, so a green suite cannot be read as parity. See `contracts/apps/photos/README.md`.
- `crates/apps/photos/tests/year3.rs` is the `year3-50k-assets` axis. Measured numbers and their provenance are in the lane's receipt section.
