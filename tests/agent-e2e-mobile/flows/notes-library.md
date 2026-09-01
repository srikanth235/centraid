# notes-library

**Claim:** a write made on the phone reaches the vault and survives process death — the one property that makes this a local-first product rather than a cache. If this passes when it should not, a release ships in which a member's note is gone after the OS reclaims the app.

**Goal:** prove the phone's Notes cover against the real seeded library — the reading room lists the vault's notes with the promoted heading AND the preview under it, a row opens the editor with its acts, and **a note captured on the device round-trips through a real process restart**.

**Setup:** `ctx.ensureDemo("notes")` runs before pairing, so the initial replica clone holds the deterministic library (`packages/blueprints/apps/notes/seed.js`: two notebooks and five notes, three markdown and two plain). The flow then pairs via `ctx.configureGateway()`.

**Steps:** open Notes from Home's launcher tile, observe the header's one action, observe a seeded row by its promoted heading and by the preview line under it, open that row, observe the editor sheet's close control and its two acts, close it — then quick-capture a note of this run's own, observe it as the library's leading row, force-stop and relaunch, and observe it again.

**Expectations:**

1. **The cover is the arrival.** `New note` (`NotesHome.tsx:290`) is published by the Notes header alone.
2. **A row is the vault's note, promoted.** `Open Mom's chili, written down properly` is `NoteRow`'s accessible name (`NotesHome.tsx:88`), built by the blueprint's own `promote()` — the phone imports it rather than re-deriving it, so first-line promotion cannot mean two things on two seats.
3. **The preview is the note's own body.** `NotesHome.tsx:105` renders the preview with newlines collapsed to spaces, so the body's first instruction is a real single-line node the matcher can reach. A heading with no body under it is a projection that dropped the content join.
4. **A row opens the editor.** `Close the note`, `Save this note`, and `Move this note to trash` (`NotesHome.tsx:458`, `:522`, `:536`) are the modal's own accessible names.
5. **A write round-trips and survives process death** ([#890](https://github.com/srikanth235/centraid/issues/890) W5). Notes had no `inputText` anywhere in this layer; writing is the defining mobile act, so this is the PR gate's write claim and it is deliberately load-bearing rather than a smoke tap. `notes-capture` opens the editor, the title is typed and asserted **at the field** (where a swallowed keystroke actually happens), `Save this note` fires `create-note`, and the note is then observed as `notes-row-first` **carrying its own title** — the list is a different tree from the editor, sorted pinned-then-newest (`notes-model.ts:89-92`), so a note captured just now leads it. `ctx.restart()` then kills the OS process and relaunches without clearing state, and the same handle-plus-title assertion is repeated: nothing of the writing process survives, so the row can only have come back through the replica.

   The title carries `ctx.state.runId` (a timestamp plus three random bytes). `ctx.ensureDemo` seeds only when the scenario is absent, so on a long-lived gateway a note left by an earlier run would otherwise satisfy the survival assertion without this run writing anything — which is exactly how a persistence claim quietly stops being one.

**Marginal cost:** ~35 s on a journey that has already paid the boot, the pairing and the seed — one sheet open, one field, one save, one `ctx.restart()` (a `stopApp` + relaunch plus the Home marker), and the cover reopened.

**Verdict:** PASS only if the row carries BOTH its heading and its preview, the editor opens with all three acts, and the captured note is still the library's leading row after the restart. A list of headings above empty previews is the seam this flow exists to catch — the note rows and the note bodies are two reads, and only a device proves they were joined.

**Deliberately not asserted:** the editor's `Note title` / `Note body` **labels**. Both are `accessibilityLabel`s on a React Native `TextInput`, which does not reach the iOS accessibility tree as accessible text (see README "Known caveats"); asserting them would be asserting selectors Maestro cannot see. The title field's typed _value_ is a different matter and is asserted — a single-line `TextInput`'s whole node text is its value, which is the case Maestro's matcher does handle, and it is the same instrument `native-v0-resilience.mjs` uses on the Tally composer.

**Known gap:** the editor's title field carries no `testID`, so the capture step reaches it by its placeholder (`Title`). An id is not invented here — `scripts/lint-mobile-testids.mjs` fails on an id no screen renders, and adding one is an `apps/mobile` change, not a flow change.
