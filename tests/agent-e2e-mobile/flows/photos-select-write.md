# photos-select-write

**Goal:** prove the Library selection bar performs a reversible vault write.

**Steps:** select two seeded tiles, verify the count, confirm Trash, open Collections → Trash, select the trashed rows, Restore them, require the empty-trash state, then return through Collections → Library and require the seeded album to be present again.

**Verdict:** PASS only when the write changes the replica-visible shelf and the inverse write empties Trash and restores the seeded Library corpus.
