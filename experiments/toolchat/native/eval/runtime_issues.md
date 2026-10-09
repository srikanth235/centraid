# nativetools runtime issues

The open issues of the `nativetools` runtime that bear on gold and on authoring. A session that cannot pass until an issue is fixed carries `blocked: runtime_issues.md#N` (`gold.S(..., blocked=...)`), and `score.py` reports those sessions separately. The numbers are stable: they name the regression tests in `crates/nativetools/tests/` (`fixes.rs` calls them `issue_<N>_...`) and the `blocked` field of a session.

Open: #10, #13, #29, #30, #31. Fixed, numbers reserved: #1–9, #11, #12 and #14–28; each has a regression test in `crates/nativetools/tests/` (`where_lang.rs` holds #25).

Repros use the seeded eval vaults (`python3 seed_worlds.py`) and a session such as `nativetools session $EVAL_VAULTS/A/vault --today 2026-10-14T08:40 --me "Priya Raman"`, fed one JSON op per line. A `ref` repro is `python3 run.py --set sets/<set>.jsonl --model ref --only <id> --out OUT`.

- **#10 [open] No CLI op renders the transcript as the model sees it.** The driver rebuilds it from `text`/`compacted` (`lib.Transcript`), which can drift from the runtime's own rendering.
- **#13 [open] `undo` can't revert some writes.** `act cancel` on "1:1 with Dana", then in the next turn `act undo` gives `not undone: ... the vault has no command that un-cancels an event`. `log` is the same. The full list is in `authored/BRIEF.md` "Runtime rules"; the gold for those undos is an empty diff.
- **#29 [open] A multi-row delete is not all-or-nothing.** `act delete rows="$a, $b"` deletes the first row, then refuses the second and reports an error; the first delete stays applied. Authored sessions avoid mixed multi-row deletes (repro: T11-087).
- **#30 [open] A notebook cannot take an album's name.** `act create kind=notebook name: Family` is refused with "You already have a notebook with that name" when only an album is called Family (repro: T11-072).
- **#31 [open] A trashed event still blocks its slot.** `crates/vault/src/commands/schedule.rs` `no_busy_conflict` counts events with `deleted_at` set, so creating an event in a slot that a trashed event occupies is refused with "This time conflicts with another event on your calendar." The other event predicates in the same file already add `deleted_at IS NULL`. This is a vault-side bug, not a nativetools one. Authored sessions treat a trashed event's slot as taken (repro: T17-034).
