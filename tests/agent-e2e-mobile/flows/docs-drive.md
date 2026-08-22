# docs-drive

**Goal:** prove the phone's Docs seat end to end against the real seeded drive — the All shelf counts the vault's own documents, a row opens the reading surface, and a band tap from that pushed route returns to the stack's home with a different shelf named rather than pushing a second copy of it.

**Setup:** `ctx.ensureDemo("docs")` runs before pairing so the initial replica clone already holds the deterministic drive (`packages/blueprints/apps/docs/seed.js`: two folders, three documents, one of them starred, tagged, and carrying a second version). The flow then pairs via `ctx.configureGateway()`, which reuses the nightly paired profile when the suite runner sets `MAESTRO_REUSE_PAIRED_STATE=1`.

**Steps:** open Docs from Home's launcher tile, observe the All shelf's own standing status sentence and two seeded titles, open the packing list, observe the reading surface's back control and its changed-byline, then tap **Folders** in the band FROM the pushed reading route and observe the Folders shelf's own status and a seeded folder.

**Expectations:**

1. **The All shelf counts the seeded drive.** `allStatus()` (`apps/mobile/src/apps/docs/docs-copy.ts:17`) is published by this shelf alone; a zero there means the drive read never reached the replica.
2. **The rows are the vault's rows.** `Tahoe packing list` and `Renters insurance policy (sample)` are `DocRow`'s accessible names (`DocRow.tsx:69`), taken straight from the seeded titles.
3. **A row opens the reading surface.** `Back to All` (`DocsShelfHeader.tsx:34` with `DocumentRead.tsx:69`'s `backTo="All"`) exists only on a pushed Docs route, so it cannot pass on the shelf that was tapped from.
4. **The band pops, it does not push.** Tapping `Folders` from the pushed reading route lands on `DocsHome`'s Folders shelf (`DocsScreen.tsx`'s `popTo`), proved by `foldersStatus()` (`docs-copy.ts:22`) plus the seeded `Travel` folder (`DocsFoldersView.tsx:139`).

**Verdict:** PASS only if all four hold. A full All shelf above a `0 folders …` line, or a `Folders` tap that leaves the reading surface's `Back to All` on screen, is a real defect and must fail here.

**Deliberately not asserted:** the packing list's second-version body line (`Tire chains …`). The reading view renders the whole markdown body as ONE multi-line text node, and Maestro anchors a text selector to the whole node with a Java regex whose `.` does not cross newlines — a `.*Tire chains.*` selector would be red for a reason unrelated to its claim. Proving that the replica carries the CURRENT version's bytes needs either a single-line surface or an on-disk read; it is recorded as an open gap rather than cemented as a fragile selector.
