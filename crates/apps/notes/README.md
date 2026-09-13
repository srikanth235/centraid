# `centraid-apps-notes` — notebooks as a projection of the vault

Notes is 9,336 lines of v0 TypeScript: 6 queries, 15 actions, 33 scopes over five schemas, and a 61-line demo seed. This crate is the read plane and the action table; the writes are `crates/vault`'s `knowledge` schema (nine commands) plus the five `core.*` link and attachment commands, and the text search is `crates/search`.

| Module | What it is |
| --- | --- |
| `manifest` | v0's `app.json`, byte for byte, parsed by the kit's parser at load time. Two copies of "which tables does Notes write" is how the two answers drift. |
| `queries` | `library`, `note`, `search`, `history`, `journal` and `link-targets`: the statements, the three shelves, the six `IN`-bounded joins, the tag chips and the powerbox. |
| `derive` | The preview and the checklist tally, and the one decoder for a body. ONE copy, where v0 has three. |
| `version_chain` | The occurrence walk, with a **typed refusal** for a cycle and for a chain past its cap. |
| `journal` | The People-journal marker set, read once and excluded four ways. |
| `cards` | The far end of a link, as the shelf draws it — a fold over bounded reads, with the consent half behind a `CardDoor`. |
| `commands` | The fifteen actions as invocations, `invoke_key` mandatory. |

## The rulings this crate is shaped by

Every one is an answer to a way the port could have been wrong, and every one has a test named after it.

**D-1020-N3 — the library asymmetry is the contract, not an oversight.** A People-journal entry is a `knowledge.note` carrying a marker concept, and it is **absent from the library, the trash shelf, the derived tag chips, `search` and the powerbox — and reachable by id**, because the People screen opens one (#834 R-journal). The asymmetry is spelled as the ABSENCE of a filter in `load_note`: that function does no journal read at all. `a_journal_entry_is_absent_from_every_list_and_reachable_by_id` is what keeps it from being tidied up, and the parity fixture holds both halves as a comparison rather than a claim. A port that unified the two would either leak journal entries onto the notes shelf or break the screen that opens one.

**The library is a bounded recent window PLUS every pinned note.** A pin survives the note ageing out, so the pinned shelf is read _beside_ the window and never out of it — which means `notes` can be LONGER than `window`. At the year-3 profile that is **2,200 rows for a 2,000-row window**: the 2,000 newest plus the 200 pins that aged out. A port that clamped the union to `window` would drop a pin, which is the bug the shelf exists to prevent.

**D-1020-D3-12 — the declared window is walked, not clamped.** `MAX_PAGE_ROWS` clamps a page to 500, and v0 asks for its 2,000-row window as one page and takes the rows — so a v0 library declaring `limit: 2000` answers **500 notes** and discards the cursor that says there are more. `knowledge_note.updated_at` is `NOT NULL`, so the keyset walk is continuable and the stated window is reachable. Measured at the year-3 profile: the port folds 2,200 rows in ~480 ms on `ci-linux-x64-4c` (debug); v0 would have folded 500. Invisible under 500 notes, which is every parity fixture.

**D-1020-N2 — a cycle is a refusal, not a truncated list.** History is the note's own occurrences, walked from `current_revision_id` through `parent_revision_id` (#996 R20(a)). v0's walk `break`s on a revision it has already seen and hands back what it has — and **a truncated list is indistinguishable from a short history**: the screen draws four versions and the note has forty, or a loop, and nothing says which. `note_version_chain` answers `VersionChainError::Cycle` (or `TooLong`, naming the size it reached), and `load_history` folds it onto the payload's denial, which is the shape a screen renders. `contracts/migrations/002_revisions.sql` is the proposal that makes the malformed row unwritable; the reader's refusal **stays** even after it lands, because the ladder is forward-only and an older binary's file reaches this build with rows the guards were added after.

**D-1020-N1 — the powerbox is secret-free by construction.** `link-targets` is one bounded probe per domain over seven domains through `crates/search`, each probe **isolated** so a denied scope leaves its column absent rather than emptying the sheet. Locker is not a domain: the absence is structural, so a secret cannot become a link target by adding a probe. The journal read rides inside the notes probe, because that is the only domain it narrows.

**A list row carries a preview, never a body** (#404). Six lines, 200 **characters** — not bytes: a byte slice would split the em dash `note-body.ts` was written about. The editor pulls the full text lazily through `note`, which is what keeps a 48 KiB body off the shelf.

**A denial is a value.** Every query answers the empty shape plus a `Denial` rather than throwing. The one read that fails CLOSED is the journal marker set (`journal.rs`): answering "no journal entries" would leak them into four surfaces, so its refusal propagates — and the query still turns it into the payload's own `vaultDenied`, so the app's contract holds at the surface.

## Two v0 defects this crate does not reproduce, and one it does

- **A created note's `updated_at` was the host's wall clock** (R-1020-35, fixed at source). `create_note` inserted the row and then repointed `current_revision_id`, and `knowledge_note_touch_updated_at` stamps `strftime('now')` over any update that does not carry a new `updated_at`. Invisible in production, where the two instants are the same; not invisible with an injected clock, and the library sorts on that column — four of the six notes in the parity corpus carried a host instant, and the page order was a fact about the machine. Both sides now record the occurrence FIRST and insert the note with its pointer already set: one gesture, one statement, one `row_version`.
- **`link-targets` declares a subtitle v0 has never served.** `subtitles: ["preview"]` for notes, over a search row that has no `preview` column, so every note target's subtitle falls back to the app's name. This crate serves the decoded body out of `core_content_text` — the same text the index was built from. Stated as a divergence in `tests/parity.rs`, with v0's answer asserted beside the port's so neither can drift silently.
- **A trashed note's reference card reads `live`.** Seven of `cards.ts`'s eleven projections hardcode `0 AS trashed`, `knowledge.note` among them, so a link to a note a member deleted draws as if it were still there. **Reproduced** for parity and filed as a finding: fixing it changes what v0 answers, and v0 is the oracle until wave 6.

## Parity

`contracts/apps/notes/` is generated from the v0 tree by `contracts/tools/export-notes-parity.ts` (with `notes-parity-bundle.ts` and `notes-parity-script.ts` beside it) and asserted in both directions:

```sh
CENTRAID_WRITE_CONTRACTS=1 bunx vitest run tests/quality/notes-parity.contract.test.ts --config vitest.quality.config.ts
bun run format && git diff --exit-code contracts/apps/notes   # the drift check
cargo test -p centraid-apps-notes --test parity               # the port's side
```

**30 cases over six queries, 40 command steps of which 14 are refusals**, and **no step marked `pending`** — `send-to-tasks` invokes `schedule.add_task`, which the Agenda/Tasks lane registered (slot 4d), so the step executes. Ids are compared, not masked, so page order is part of the comparison.

## Owner hand-off — the typing-latency number

The wave-0 target is a round trip through the **editor's state machine on a reference device** (#1020 `:167`), and that machine is Kotlin with no Rust twin:

```sh
./gradlew :shared:jvmTest --tests '*ScreenMachineSpec*'   # the reducer, on a JVM
# and on a device, which no machine in this repository's CI has:
#   maestro test mobile/maestro/notes-editor.yaml
```

What this box measures is the half that IS Rust, reported as projected provenance in `receipts/issue-1020-v1-platform.md`: the editor's on-open pull over the largest body the product holds (~1.1 ms for 48 KiB on `ci-linux-x64-4c`, debug) and the per-row derivation a shelf pays (~1.0 ms for a 48 KiB body, ~1.7 ms for 4,000 checklist lines). `crates/apps/notes/tests/year3.rs` prints all three.
