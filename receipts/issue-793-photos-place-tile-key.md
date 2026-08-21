# Receipt — issue #793: Collections place tiles open their photographs

## Checklist

- [x] A Collections place tile carries the rounded shelf key used by
      `assetsAtPlace`, not the raw `core.place.place_id`.
- [x] A focused component regression enters through the tile and proves the
      detail contains the same two photographs its count states.
- [x] The pure collection model pins the tile identifier independently.
- [ ] Fresh-context audit (owned by the root auditor).

## What changed

`apps/mobile/src/apps/photos/PhotosCollectionsView.tsx` now derives each replica
place row's durable shelf key with `placeCardKey` and hands that key into
`buildCollectionSections`. `apps/mobile/src/apps/photos/photos-collections.ts`
uses it as the tile id, so the route parameter consumed by `PlaceDetail` is in
the same coordinate-key vocabulary as `assetsAtPlace`. Rows without usable
coordinates do not mint a tile.

`apps/mobile/src/apps/photos/PhotosCollectionsView.test.tsx` mounts the real
Collections view, presses the Lake Tahoe tile, follows its navigation into the
real `PlaceDetail`, and proves both the visible `2 photographs` sentence and
the two assets delivered to its timeline.
`apps/mobile/src/apps/photos/photos-collections.test.ts` separately pins that
the rounded key, not the raw place id, is the tile id.

Checklist crosswalk: **A Collections place tile carries the rounded shelf key
used by `assetsAtPlace`, not the raw `core.place.place_id`.** **A focused
component regression enters through the tile and proves the detail contains the
same two photographs its count states.** **The pure collection model pins the
tile identifier independently.** These three claims are covered by the real
route regression and the pure model test described above.

## Out of scope

The coordinate rounding algorithm and Place Detail query semantics are
unchanged; this repair only carries the existing shelf key across navigation.

## Decisions

None.

## Verification

```text
bun run --cwd apps/mobile test --run src/apps/photos/photos-collections.test.ts src/apps/photos/PhotosCollectionsView.test.tsx src/apps/photos/PlaceDetail.test.tsx
# 3 files / 21 tests passed

bun run --cwd apps/mobile typecheck
# clean
```

Demonstrated red: `id: place.placeId` was restored temporarily and the focused
component file ran **1 red / 6 green**. The new case received
`Lake Tahoe0 photographsNo photographs at Lake Tahoe yet.` instead of
`2 photographs`. The rounded-key fix was restored and the three-file run
returned 21/21 green.

## Audit

PASS — fresh-context audit by `/root/receipt_audit_792_796`: the corrected
receipt mirrors issue #793, names all four issue-owned files, and the rounded
shelf-key route plus tile-to-detail regression match the diff (21/21 focused
tests passed).

## Session

- harness: codex
- date: 2026-08-15

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-15 | codex | 01a003d7-1e6b-7d00-86a3-4831e330af63 |
