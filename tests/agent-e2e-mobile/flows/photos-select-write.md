# photos-select-write

**Goal:** prove the Library selection bar performs a reversible vault write.

**Steps:** select two seeded tiles, verify the count, confirm Trash, verify the selection disappears, open Collections → Trash, select the trashed rows, and Restore them.

**Verdict:** PASS only when the write changes the replica-visible shelf and the inverse write removes the restored selection from Trash.

**Selectors** ([#890](https://github.com/srikanth235/centraid/issues/890) W2): the cover, both band destinations, the Library select chip, the trash action and the Trash shelf heading are taken by handle (`photos-collections`, `photos-band-library`, `photos-band-collections`, `photos-grid`, `photos-select`, `photos-selection-trash`, `photos-shelf-trash`) — the shelf heading especially, since `Open Trash, N` carries the vault's count and so changes on every seed. The selection count, the confirm sentence and the 30-day reassurance stay copy: they are what the write promises.

**Known gap:** the Trash shelf is a separate route (`PhotoStateView`) whose own select chip carries no `testID` — `photos-select` belongs to `PhotosHome`'s Library destination — so that one tap stays on copy rather than on an id that would resolve to the wrong screen.
