# Hand-offs from #1020 wave 4 slot 4b, lane DOCS

## `kit.patch` — the representation fold, lifted into `crates/apps/kit`

`crates/apps/kit/**` has no wave 4 owner; the census recommends **root**, and a
change arrives "as a named function plus its demonstrated red" rather than an
edit in place (`census-wave4.md` §Cross-lane).

This patch is that change, and it is **applied in this lane's branch** so the
Docs crate could be written at all — the receipt says so, and this file is the
hand-off the root splices or re-applies.

- **What moves**: `crates/apps/photos/src/representations.rs`'s fold and
  statement, into `crates/apps/kit/src/representations.rs`. Lane Photos wrote
  the module and filed exactly this lift for "whichever lane ports the second
  caller"; Docs is that caller.
- **What the lift adds**: `RepresentationIndex.by_content`, v0's second index
  (`packages/blueprints/apps/_shared/representation-reads.ts:36`), which Photos'
  narrowing dropped. `by_owner` is also re-keyed on the PAIR
  `(owner_type, owner_id)` as v0 keys it, instead of on `owner_id` under one
  implied owner type.
- **The demonstrated red**: `two_owners_over_one_sha_keep_their_own_readings`
  in the new module. Docs' `history` query reads a media type for a
  **superseded** version — bytes the document no longer reads, so there is no
  owner row for them — and answers it from `by_content`. Against Photos' fold
  the call does not typecheck, because the index it needs does not exist; with
  `by_content` present but keyed to the newest reading instead of the oldest,
  a document whose format was re-declared prints the wrong type against every
  historical version. The test pins the oldest-wins rule.
- **What did not change**: every name `crates/apps/photos` exported
  (`ASSET_OWNER_TYPE`, `fold_media_types`, `read_media_types`,
  `representations_statement`) still resolves, and
  `cargo test -p centraid-apps-photos` is green over the same 24 + 3 tests.
