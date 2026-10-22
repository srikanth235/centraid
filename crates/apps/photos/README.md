# `centraid-apps-photos` — the library as a projection

Photos is 3 queries and 19 actions. This crate is the read plane and the action table; the writes are `crates/vault`'s `photo.*`, `place.*` and `album.set_cover` commands and the shared verbs (`entity.*`, `flag.*`, `tag.*`, `edge.*`, `container.*`), and the bytes are `crates/media`'s.

| Module | What it is |
| --- | --- |
| `manifest` | The app's `manifest.json`, parsed by the kit's parser at load time. Two copies of "which tables does Photos write" is how the two answers drift. |
| `queries` | `library` and `search`: the photograph columns, the `IN`-bounded joins, the star and the archive read from the flag edges, and the keyset cursor. |
| `duplicates` | A **read** over the perceptual hashes: it hands the clustering the live photographs' fingerprints and folds the answer into cards. The clustering is `centraid_media::duplicates` ([R-1135-5-15](../../../docs/decisions.md#photos)). |
| `places` | The Places facet, inside Photos. A location is a phrase before it is a pin. |
| `commands` | The nineteen actions as command invocations, `invoke_key` mandatory. An action names one command and takes that command's input verbatim; two actions may share one (`rename-album` and `name-place` are both `entity.retitle`). |

## The model Photos reads (#1135)

A photograph is an `entity` of kind `photo` (its title is the caption, and may be empty) over a `photo` row (the blob, what it is, when and where it was taken, the burst it belongs to and the photograph it was edited from); an album is a `container` joined to its photographs by ordered `contains` edges; a heart, the archive and a label are `tagged` edges; a place is a `place` entity; a thumbnail, a perceptual hash and a caption are the blob's `derivative`s. The decisions are [R-1135-5-1 to R-1135-5-19](../../../docs/decisions.md#performance-and-scale).

## The rulings this crate is shaped by

Every one is an answer to a way this crate could be wrong.

**Faces and memories are gone** ([R-1135-5-18](../../../docs/decisions.md#photos), Q-1047-2). Their queries, actions and surfaces left when nothing produced either; so did `storage` and `enrichment-status` and the `request-enrichment` action ([R-1135-5-12](../../../docs/decisions.md#photos)). The model holds no table for them, and `contracts/apps/photos` carries v0's answers as frozen evidence nothing reads.

**Duplicates are read, never stored.** There must be exactly one clustering: a second implementation inside the query would agree with the code until the threshold moved, and then disagree silently at the boundary where a member is deciding what to delete. The core runs `centraid_media::duplicates::cluster` over the live photographs' `phash` derivatives when asked, takes the first 4,000 fingerprints by blob, and drops a cluster left with fewer than two live photographs.

**An edit folds its original, and a burst folds its older stills.** A phone's edited photograph arrives as two photographs of one capture: the camera's bytes, and the edit's render with `edited_from` naming them and a shared `burst`. The library draws the newest live one, so the grid shows the edit; trashing or archiving the edit brings the original back. A crop saved from Centraid's own editor carries no burst and folds nothing.

**The Places facet stays here.** There is no `crates/apps/places`. The phrase logic is the load-bearing half: in a **shared** context the relative rung is skipped, because "5.2 km NW of the cabin" hands a stranger a bearing to the member's house, and `printable_name` refuses a coordinate-shaped name at every rung, so a gazetteer that wrote digits into a title cannot leak them. A place has no kind, so the relative rung measures from the nearest named place and prefers no home ([R-1135-5-3](../../../docs/decisions.md#photos)).

**The library window is one page, and the answer says so (D-1020-P11).** `photo.taken_at` is nullable, and the kit's door refuses a **continued** page over a nullable sort key because SQLite's row-value comparison puts every NULL on one side of the keyset and the walk silently drops them. So the declared 2,000-row window is unreachable by a walk: asking for 2,000 as one page gets 500 from the clamp, and the answer reports it (`window` says what was asked, `truncated` is the page's own cursor, and a surface continues with `before`). The remedy is a typed cursor on the app's `before` input, which is a manifest input-schema change and therefore the owner's call. The phone's own grid reads by keyset pair and has no such gap.

**An album's cover is a photograph's blob, and the read falls back to the first live member** ([R-1135-5-2](../../../docs/decisions.md#photos)). Trashing a photograph keeps its album edges, and counts and covers read live members only ([R-1135-5-6](../../../docs/decisions.md#the-vault-model)).

## What stops this crate doing more

| Not allowed | What stops it |
| --- | --- |
| SQL, in any form | `cargo xtask rules`' `sql-confinement` scans this crate, tests included, and finds none; a statement here is a `PageQuery`, a projection, a `from`, a predicate and an order, as data |
| A model, a codec or a hash | recognition is not this crate's and the byte plane is `crates/media`'s; the dependencies are the kit, the search door and `serde_json` |
| A write from a query | `queries` holds statements and a `PageDoor`, whose one method reads |
| An invocation with no `invoke_key` | the field is required (D-1020-D3-5) |
| A denial turned into an error | `Outcome::Denied` and `Reading::Denied` are states a surface renders |
| A failed read folded into a `0` | every three-state answer models the third state explicitly |

## Two gates, never one

The manifest's `confirmation: "required"` is what the **dispatching surface** asks before sending, and Photos declares it on `purge-photo` and `delete-album`. A command definition's `confirm: true` parks a **non-owner** invocation regardless of risk, and no command Photos names carries it. Collapsing the two would add a dialog in front of a member's own purge and drop the park in front of an agent's.

## Fixtures

- `tests/reads.rs` runs the library, the albums, the places, the search and the duplicates against a vault the product founds and Photos' own commands fill.
- `tests/year3.rs` is the `year3-photos` (90,000) and `year3-50k-assets` (50,000) axes, each with 3,000 or 1,500 near-duplicate families of three, a trash shelf wider than its 200-row bound and a duplicates read that stops at its 4,000-fingerprint cap. A shrunken profile in the same shape runs by default. Measured numbers and their provenance are in the receipt and `tests/journeys.json`.
