# photos-select-write

**Goal:** prove the Library selection bar performs a reversible vault write.

**Steps:** select two seeded tiles, verify the count, confirm Trash, verify the selection disappears, open Collections → Trash, select the trashed rows, and Restore them.

**Verdict:** PASS only when the write changes the replica-visible shelf and the inverse write removes the restored selection from Trash.
