# Runtime issues found while building the data (step 3)

Found by driving `nativetools`; the crate was not patched here. Status is as of the binary the final data was built with (after runtime fixes #19–#23, sha256 `fda5ace7…`).

| # | issue | status | generator |
| --- | --- | --- | --- |
| 1 | Rows created by `act create` stopped being addressable after their turn (`error: #9 is not shown any more`), against SPEC §5/§6.0.4. | fixed (created rows always kept) | uses the echoed `#n` again |
| 2 | An empty `answer` by name ended the turn while a `no_link` answer did not, so §8.5 recovery was impossible after it. | fixed (empty / only-trashed / no-link answers keep the turn open) | takes offered rows, searches a name once, else `decline not_found` — see 13 |
| 3 | `act rows=@n` on a value handle (`@1 = count`) returned an empty text and an empty diff instead of an error. | not re-tested | never emits it |
| 4 | `settle_up` echoes `no field changed` and only the text carries the settlement, so an effect scorer (§10) may not see it. | open | — |
| 5 | `undo` after a cancel is partial: `not undone: … the vault has no command that un-cancels an event` (§4.2 says one unit). | open | no `undo` after `cancel`, `log`, `settle_up`, `reveal` |
| 6 | `already:` does not end the turn; §4.2 says the model "answers with that". | open (by design?) | follows with `answer rows=#n` (the row, showing its state); eval gold should accept it |
| 7 | World JSON could not set the vault's default currency. | fixed (`"currency"`) | worlds use 17 default currencies; groups add others |
| 8 | `search` missed a letter transposition ("Adiyta" for "Aditya"). | not reproduced after the fix round ("Bendikt" → Benedikt) | typo scenarios require the misspelt word to name one row |
| 9 | Trashed rows were invisible to `search`. | fixed (hits marked `trashed`) | a write whose only match is trashed → `decline not_found`; a read answers the trashed row |
| 10 | The rendered user message is not defined by the binary: `user` returns the vault block and the harness prepends it. | open | `"<vault block>\n\n<message>"`; trainer and eval must render the same (shared `native/render.py` takes the content as given) |
| 11 | Event status `confirmed` cannot occur (seeded and created events are `tentative` or `cancelled`). | open | — |
| 12 | Domain refusals come back as plain `error:` with no next step (§5): deleting a non-empty folder or a group with expenses, removing a member with a balance, calendar overlaps, restore past the trash grace window, a name that also matches the owner. | open | avoids those targets; the few that still happen drop the turn (logged) |
| 13 | With 2 fixed, a `where`/`when` answer that matches nothing leaves the turn open and the only closing call is `decline not_found`; the effect of "you have none" is no longer an `answer` with an empty set. Eval gold for empty reads must agree. | question for the owner | ends such turns with `decline not_found` |
| 14 | **Request:** export the locker per-type field table in `metadata.json` (which of username / url / notes / secrets each `type` keeps). Today only `seed`'s `dropped` list reveals it (username/url on `login` only; notes on login, note, ssh_key, api_credential, passport, bank_account, driving_licence, software_licence, crypto_wallet, membership, document). | open (runtime request) | table probed from `seed` (worlds.py `LOCKER_NOTES`); replace with the export when it lands |
| 16 | Locker `notes` are sealed only on `note`-type items (their notes are the sealed content, opened by `reveal field: content`); `reveal field: notes` is rejected (`reveal takes field: password · code · card_number · cvv · content`). On other types notes are plain: shown, filterable (`notes contains`), editable. | open (doc / naming) | notes as a plain field except on `note` items; sealed content via `reveal field: content` |
| 15 | The prompt changed under the data runs (full schemas → signature lines). | handled | each example records `tools_mode` and `tools_hash`; the pinned binary is copied next to the data |
