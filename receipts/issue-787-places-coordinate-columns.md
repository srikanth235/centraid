# Receipt — issue #787: Places shelf/detail read the wrong coordinate columns

## Checklist

- [x] `placeCardKey` reads the physical `core_place` columns (`geo_lat`/`geo_lng`)
      first, through the web handler's type-guard semantics, in the same chain
      `placePoints` reads.
- [x] The tests that deliberately pinned the defective column reads are
      consciously flipped, and the real-vault row shape now drives the model
      and component fixtures.
- [x] Demonstrated red: re-introducing the defective read fails the new tests.

## What changed

`apps/mobile/src/apps/photos/places-model.ts` — the one-function fix #787 asked
for, plus the guard the audit that filed it recommended:

- A shared `coordOf()` guard (`typeof value === "number" &&
  Number.isFinite(value)`) mirroring the web handler's `readPlaces` semantics
  (`packages/blueprints/apps/photos/queries/_shared.ts`): an explicit `NULL`, a
  string, or any other type is dropped by type, never coerced and caught as
  `NaN` downstream.
- `placeCardKey` now reads `geo_lat ?? latitude ?? lat` / `geo_lng ??
  longitude ?? lng` through that guard — the same chain `placePoints` already
  read — so the shelf, the detail, and the map finally see the same rows.
  **`lon` is dropped from the chain**: nothing on mobile ever fed it — the
  only occurrence in `apps/mobile/src` was the defective line itself, and the
  replica hands raw `core_place` columns.
- `placePoints` uses the same `coordOf` guard, replacing its bare `Number()`
  coercion.
- The `KNOWN DEFECT` docblock (added when the #781 testing wave found and
  preserved the bug) is replaced by a short column-contract comment citing
  #787.

`apps/mobile/src/apps/photos/places-model.test.ts` — the tests that pinned the
old reads are consciously flipped, exactly as the `KNOWN DEFECT` comment
demanded: the `TAHOE`/`TAHOE_CABIN`/`HOME` fixtures and two inline rows move to
the real `geo_lat`/`geo_lng` shape, and a new
`describe("the columns a place's coordinates arrive in (#787)")` adds 5 cases —
a geo-shaped row cards, opens, and plots through one key; explicit-NULL geo
columns yield neither card nor pin; string coordinates are dropped by type
(they would have passed the old `Number()` coercion); and both legacy
fixture shapes (`latitude`/`longitude`, `lat`/`lng`) still work as fallbacks.

`apps/mobile/src/apps/photos/PlacesView.test.tsx` and `PlaceDetail.test.tsx` —
`PLACE_ROWS` fixtures flipped to `geo_lat`/`geo_lng` so the component tests run
on the real vault shape. `PlacesMap.test.tsx` was already on it and is
untouched by this commit.

### Checklist crosswalk

- **"`placeCardKey` reads the physical `core_place` columns (`geo_lat`/`geo_lng`)"**
  — done in `places-model.ts` as described above: `geo_lat ?? latitude ?? lat`
  through `coordOf`, character-identical to `placePoints`'s chain.
- **"The tests that deliberately pinned the defective column reads are"**
  consciously flipped — `places-model.test.ts` fixtures and the new #787
  describe block, plus the `PLACE_ROWS` flips in `PlacesView.test.tsx` and
  `PlaceDetail.test.tsx`, all detailed above.
- **"Demonstrated red: re-introducing the defective read fails the new tests."**
  — the 15-failure evidence under Verification, independently reproduced by
  the audit.

## Out of scope

- The distinct Collections place-tile keying defect found while fixing this
  (`PhotosCollectionsView` passes the raw `place_id` as `placeKey`, so tapping
  a place tile opens an empty detail) — its own bug issue, filed from the same
  session.
- The Places Maestro flow and everything else in the #781 wave on this branch
  — separate commit, separate receipt.

## Decisions

**`lon` is removed rather than kept as a fourth fallback.** A fallback nothing
feeds is not compatibility, it is a place for the next wrong column name to
hide. The chain keeps exactly the shapes with a live producer: the physical
schema columns first, then the two legacy fixture spellings the existing tests
used.

## Verification

```bash
node node_modules/vitest/vitest.mjs run apps/mobile/src/apps/photos/
# 43 files / 483 tests passed (includes the 4 Places files: 46 tests)
bun run --cwd apps/mobile typecheck   # clean
bun run --cwd apps/mobile lint        # clean
bun run test:hygiene-ratchet          # at budget; this commit adds 0 counted sites
```

Demonstrated red: with the fix in place, the defective
`Number(row.latitude ?? row.lat)` / `Number(row.longitude ?? row.lon ?? row.lng)`
read was re-introduced in `placeCardKey` — **15 tests failed across 3 files**
(7 in `places-model.test.ts` including the cross-screen agreement law and the
new #787 block; 4 in `PlacesView.test.tsx`; 4 in `PlaceDetail.test.tsx`; the
audit below reproduced exactly this split). The fix was restored and the suite
re-ran green. The defect can no longer regress silently from either direction.

## Audit

Fresh-context adjudication (2026-08-15, staged diff only, judged against the
index):

**Check 1 — "What changed" vs the staged diff: PASS.** Every hunk in the five
staged files is accounted for and nothing extra is claimed. `coordOf` matches
the web handler's `readPlaces` semantics (`typeof === "number"` type-drop,
never coercion — verified against
`packages/blueprints/apps/photos/queries/_shared.ts`) and is strictly stronger,
retaining the pre-existing `Number.isFinite` check. The flipped tests are
stronger, not weaker: fixtures move to the real `geo_lat`/`geo_lng` shape and
five new #787 cases add type-guard and fallback assertions the old suite could
not express. The `lon` claim verified: `git grep` shows the defective line was
the only `\blon\b` in `apps/mobile/src` at HEAD, and none remain in the index.
`PlacesMap.test.tsx` confirmed unstaged, untouched, and already geo-shaped.

**Check 2 — checklist boxes: PASS.** All three `[x]` claims are true against
the staged diff: `placeCardKey` reads `geo_lat ?? latitude ?? lat` /
`geo_lng ?? longitude ?? lng` through `coordOf`, character-identical to
`placePoints`'s chain; the pinning tests are flipped in all three test files;
demonstrated red independently reproduced (check 3).

**Check 3 — verification reproduces: PASS, one breakdown discrepancy.** Ran
`node node_modules/vitest/vitest.mjs run` on the 4 Places files: 4 files /
46 tests green, as claimed. Independently re-introduced HEAD's defective read
in `placeCardKey` and re-ran: **15 tests failed across 3 files**, matching the
receipt's headline exactly, including the cross-screen agreement law and the
#787 block's vault-shaped-row case. Per-file I observed 7 / 4 / 4
(places-model / PlacesView / PlaceDetail); the receipt originally said "9 in
places-model.test.ts", which was internally inconsistent (9+4+4 ≠ 15) and has
been corrected above to the reproduced split. Restored via
`git checkout --` (from the index), verified `git diff` vs index empty, suite
green again at 46/46.

## Session

- harness: claude-code
- session: 36f0a126-2d40-5128-b3ea-59456606a925

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-15 | claude-code | 36f0a126-2d40-5128-b3ea-59456606a925 |
