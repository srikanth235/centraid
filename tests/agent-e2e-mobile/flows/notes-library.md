# notes-library

**Goal:** prove the phone's Notes cover against the real seeded library — the reading room lists the vault's notes with the promoted heading AND the preview under it, and a row opens the editor with its acts.

**Setup:** `ctx.ensureDemo("notes")` runs before pairing, so the initial replica clone holds the deterministic library (`packages/blueprints/apps/notes/seed.js`: two notebooks and five notes, three markdown and two plain). The flow then pairs via `ctx.configureGateway()`.

**Steps:** open Notes from Home's launcher tile, observe the header's one action, observe a seeded row by its promoted heading and by the preview line under it, open that row, and observe the editor sheet's close control and its two acts.

**Expectations:**

1. **The cover is the arrival.** `New note` (`NotesHome.tsx:290`) is published by the Notes header alone.
2. **A row is the vault's note, promoted.** `Open Mom's chili, written down properly` is `NoteRow`'s accessible name (`NotesHome.tsx:88`), built by the blueprint's own `promote()` — the phone imports it rather than re-deriving it, so first-line promotion cannot mean two things on two seats.
3. **The preview is the note's own body.** `NotesHome.tsx:105` renders the preview with newlines collapsed to spaces, so the body's first instruction is a real single-line node the matcher can reach. A heading with no body under it is a projection that dropped the content join.
4. **A row opens the editor.** `Close the note`, `Save this note`, and `Move this note to trash` (`NotesHome.tsx:458`, `:522`, `:536`) are the modal's own accessible names.

**Verdict:** PASS only if the row carries BOTH its heading and its preview and the editor opens with all three acts. A list of headings above empty previews is the seam this flow exists to catch — the note rows and the note bodies are two reads, and only a device proves they were joined.

**Deliberately not asserted:** the editor's `Note title` / `Note body` fields. Both are `accessibilityLabel`s on a React Native `TextInput`, which does not reach the iOS accessibility tree as accessible text (see README "Known caveats"); asserting them would be asserting selectors Maestro cannot see.
