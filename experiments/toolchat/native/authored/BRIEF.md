# Authoring brief: training sessions for the vault tool model

You write training data for a 0.8B model (Qwen3.5-0.8B) that serves a person's vault through 8 tools. You author one **world** (a household's vault) and **100 sessions** on it, in the gold vocabulary of `eval/gold.py`, the one the eval sessions are written in. Every session is replayed through the real runtime and must score as its gold before it counts.

## Why this exists

The sessions are what the model trains on, and the model serves people typing on a phone. Real use is terse conversation that leans on earlier turns, names things loosely, and sometimes needs a second try. A narrow, polite, self-contained register (every name copied verbatim, one request per session, no mistake ever repaired) does not transfer to it. Write like a real person typing to an assistant on their phone, not like a test case.

The held-out eval sessions in `eval/sessions/e1/` were written by this same recipe; `authored/evalkit/KIT.md` is their kit.

## Hard rules

1. **Do not open** `eval/sessions/`, `eval/sets/`, `eval/worlds/*.json|*.keys.json`, `eval/worlds/build_worlds.py`, `data/`, or any `runs/` or `out/` directory but your own. They hold the held-out evaluation and the built training data. Write every message fresh. The val worlds in `authored/split.json` (T03, T12, T23) are held out of training whole: do not add or edit sessions or rows in them, and do not read them for phrasing when writing a train world. Keep your own scratch files in one directory of your own, e.g. `/tmp/authored-<W>-work/`.
2. You may read: `SPEC.md` (§4 tools, §5 observations, §8 policy: the decision procedure your reference calls must follow), `eval/gold.py`, `eval/lib.py`, `eval/run.py`, `eval/score.py`, this directory, `crates/nativetools/` (runtime source; the seed world schema is `crates/nativetools/tests/fixtures/world.json`), and a fresh export: `nativetools export /tmp/export-<W>` (the binary named by `NATIVETOOLS`; prompt.sig.txt is the model's system prompt, kind_card.txt the kinds/fields/verbs, tools.json the tool schemas, metadata.json the fields and operators of every kind, the decline reasons and compute ops, date_expr.schema.json the date expressions).
3. Only touch `authored/worlds/<W>*` and `authored/sessions/<W>*`. Never edit shared code; if you believe the runtime or tooling is wrong, stop that session and report it.
4. The gold is the **correct effect** under §8. Never bend gold to match a wrong reference call, and never bend the reference to dodge a runtime error you think is a bug: report it.

## The world

`authored/worlds/<W>_build.py` writes `authored/worlds/<W>.json` (run it; deterministic). One concrete household (persona given in your task): its people, groups with expenses (tallies, can be foreign currency), lists, events, tasks (with subtasks and lists), notebooks + notes, folders + documents, albums + photos, debts, locker items of many types, and links. Ordinary size: ~25–35 people, 4–6 groups, 50–70 events, 50–70 tasks, 20–30 notes, 15–20 documents, 30–40 photos, 10–15 debts, 15–20 locker items (at least one of every type), with recurring history for volume. Put in the ambiguity real vaults have, because sessions need it: two people sharing a first name, similar event names, near-duplicate tasks, a trashed row or two, cancelled events, completed tasks, a nickname, a misspelled-looking name. Keys are short snake_case (`rent_june`, `sam_k`).

## The sessions

`authored/sessions/<W>.py` starts with `from gold import *` and `world("<W>", "<today>", "<me>", "train")`; put sessions in files of about 25 (`<W>.py`, `<W>_02.py`, `<W>_03.py`, `<W>_04.py`; each part file also starts with `from gold import *`). Ids `<W>-001`..`<W>-100`.

    S("<W>-014", "tags here",
      T("whos coming to sat's bbq", rows("amy", "raj", "tomas"),
        ref=[ans(kind="person", linked_to="$bbq")]),
      T("push it to 7", diff(upd("bbq", date="2026-06-13T19:00")),
        ref=[act("reschedule", rows="$bbq", args=lines(to=D("2026-06-13", "19:00")))]))

You write the user message, the gold effect, and the reference call(s) only: the `act` / `ans` / `find` / `search` / `ask` / `decline` helpers of eval/gold.py. **Do not write a `think` field or any reasoning text for the calls.** The `<think>` trace the model trains on is generated afterwards by `authored/build.py` (the slot trace of CONTRACT_V3.md, `authored/trace.py`), mechanically from the context and each call, never composed as prose by you or any model. Name only rows the model has actually been shown (vault block, directory, or an earlier turn's result): `$key` (and `$new`, `$c1`, `@prev`) in a call resolves to the `#n` the runtime showed, and the replay fails if it was never shown.

### Referencing rows

- Always `$key`, never a literal `#n`: numbers shift whenever the world gains a row or container.
- `$key` resolves through a name index of names **unique within their kind**. A row that shares its name (two "Pay council tax" tasks) is not resolvable from the vault block; `find` it first and use `@1`/`$key` after it has been listed. The vault block shows at most 8 rows (no kind more than half of them while another kind has a hit; exact names first), so a crowded message can still push the row you mean out of it.
- `$new` is the last row created this turn, `$c1` the first row created in the session.
- Compaction folds older turns away: rows only shown two or more turns back may no longer be addressable. Re-find them, or narrow with `within=@n` while the result is still live.

### Gold conventions

- A link is written container → member: `link("kids_album", "p_beach")`, `link("tokyo", "priya")`.
- `new(kind, ...)` is a row created in this turn; `"+1"` names the first row created in an earlier turn of the session (`upd("+1", ...)`, `link("+1", ...)`).
- Creating a group also links it to me; deleting a group or album unlinks every member/photo; reopening a task sets `completed` back to None. Put these in the diff.
- An already-so write (`diff(already=[...])`) does not end the turn: follow it with an `answer rows=...` in the ref.
- `answer`, `ask`, `decline` and a write that changed something end the turn (a write with `more=` keeps it open, for write-then-read turns); `find`, `search`, `open`, `compute` and an already-so write do not (a `compute` result is handed back with `answer`).

### SPEC §14 conventions the messages and gold must agree on

Full text in SPEC §14 and §14.1; `eval/conventions.py` holds the phrase patterns that detect them. A message that fires one of these gets the one reading listed, in every world.

- **wifi**: "wifi password / pw / code" only named or asked about ("wifi pw?", "what's the wifi password", "where's the wifi code saved") is `answer rows` on the locker row, never a `reveal`. A reveal verb aimed at it ("show me", "tell me", "read it out", "give me") is the `reveal`; two wifi rows fitting means `ask` with both, unless the turn before starred, edited or created one of them: then that row is the one read or revealed, no ask. "text / whatsapp it to x" about the password is `decline sealed_egress`, "make one up" is `decline fabricated_secret`.
- **diary**: "diary" means the calendar (kind `event`); "diary entry", "journal", "journal entry" mean a note. A row literally named "... Diary" is addressed by its name.
- **balance**: always a value; the sign is the vault's (person: positive = they owe me; group with `linked_to`: positive = the group owes them), never the wording's. Do not write "how much do i owe x" over a positive balance; ask it neutrally ("where am i with x") or with the matching direction.
- **weeks and weekends**: weeks run Monday to Sunday; "this week" contains today, "next week" the following one, "last week" the one before. "this weekend" is the coming Saturday and Sunday (today's when today is one of them), "next weekend" the ones in next week.
- **next / bare weekday**: "next friday" is the Friday of next week from any day; "friday" alone is the next Friday, today counting. Say "friday week" for the one after next. A weekday that ends a span counts from the span's start when the start is a weekday phrase ("from last saturday till sunday" ends on the sunday after that saturday); a week-name start ("from last week up to tuesday") reads the current week. A bare ordinal that ends a span is in the month the span starts in ("from august up to the sixth" ends on 6 August); the `dates:` line shows that one day.
- **at N**: the row or the message decides first (dinner, drinks, party, movie, tonight = evening; breakfast, morning = morning), otherwise 1 to 7 is pm and 8 to 12 as written; "7am" when the early hour is meant.
- **last month name**: "last november" is the most recent November that has fully ended.
- **what else**: an else / other / besides / apart from / the one after read leaves out every row of its kind that the conversation put in play: the last result (`exclude="@n"`), the options of the ask before, the rows the turn before wrote, the row the message names (`exclude="$key"`; "besides ama" is Ama). A write or an ask before it does not cancel the exclusion: "move it an hour earlier", then "what else is that weekend" excludes the moved row.
- **due, left, on**: "what's due <span>" over tasks is `status = open` in the reference unless the message says all, done or finished ("that i haven't done" is still open). For events, "left", "still on" and "remaining" carry `status != cancelled`, and a month name is the whole month ("what practices are left in january"). A read that names no kind reads one kind, never the union: "what's on <span>" is `kind="event"`; "what's left" is the kind of the turn before, tasks as a first read; "else", "other", "more" keep the kind of the turn before. A span question with no "on", "left" or task word ("what's the plan for next week", "anything next weekend", "what've i got next monday") is `kind="event"`, and a fragment ("and tomorrow") keeps the kind before.
- **broken-off request**: a message that breaks off mid-sentence ("move the router note into... hmm i don't have a home notebook. create one called Home") references only the last complete request, the create.
- **plurals**: a name given as a bare plural that fits several rows ("star the mark 9 tests", "the cousins in toronto"), with no all, every, each, both or everyone, is the by-name call, and the gold is `ask(...)` over the namesakes; never star or move them all. A plural given as a condition is a `find` then one write on `rows="@prev"`:

      T("star the mark 9 tests", ask("t_9b", "t_9c"),
        ref=[act("star", kind="document", name="mark 9 tests")])
      T("delete the done kids tasks", diff(trash("t_swim"), trash("t_hw")),
        ref=[find(kind="task", linked_to="$kids", where="status = completed"), act("delete", rows="@prev")])

- **who owes**: "who owes me", "who do i owe", "who's that to" about debts are answered by the open debt rows (`ans(kind="debt", where="status = open")`, each shows its person); the people behind them are also accepted. Not a balance.
- **subtasks**: "add a subtask under X", "add a step to X" is `act("create", args=lines(kind="task", name=..., parent="$x"))`; "its steps", "what's under it" is `linked_to="$x"` of the parent task. A list is `list=`, never `parent`.
- **follow-ups**: a question with its own noun or subject ("and how many do i have a cadence for", "how many priority ones are left", "which debts are still open") is fresh: it keeps the kind, not the date, container, person, role filter or `within` of the turn before. A bare verb-and-condition fragment ("how many are starred", "which are due up to sunday") narrows: `within="@prev"` plus the condition, the earlier role filter kept. A word of a narrowing fragment that is, or starts, a directory container's name ("just the recital ones" with an album called Recital) is `within` plus `linked_to="$recital"`, not a `name` filter.
- **messaging**: "text X", "email X <thing>", "tell X i said hi", "whatsapp X" is `decline("out_of_scope")`, even when the name fits several people. `sealed_egress` is only for a secret sent out (the wifi password, a card number). A message that says log or note it, or a reminder to email someone, is not a decline.
- **bulk write**: a write the message narrows by a condition on the rows ("just the finished ones", "just the garage sale inventory") that is over 12 rows is the write, gold `ask()`; "all my tasks" or "everything" with nothing narrowing it is `decline("unbounded_destruction")`, and so is "everything" or "all of it" over a time span ("cancel everything this week, all of it").
- **grouped values**: "break down by", "split by", "count by" over the rows in focus is a grouped value by kind: tasks and other plain kinds count, debts sum the amount:

      T("break those down by status", vgroups({"open": 4, "completed": 1}),
        ref=[comp(kind="task", within="@prev", op="count", group="status"), ans(value="@prev")])
      T("split by direction", vgroups({"owes_me": (179.4, "EUR"), "i_owe": (282.4, "EUR")}),
        ref=[comp(kind="debt", within="@prev", op="sum", field="amount", group="direction"), ans(value="@prev")])

- **both shapes pass**: the eval also accepts the other shape for a superlative or "how long" (the row or its value; the reference stays the row), a grouped count with one group (the plain value), "is it still in the Y folder" (the row or its folder), and a group balance narrowed by "just", "only" or "specifically" right after a person's balance (the group's net of that person, or the person's part in the group's currency). Do not rely on the second shape; write the first.
- **delete and trash**: the verb is `delete` and users say "delete" (or "wipe", "clear out", "get rid of"); "trash" is only the place ("what's in the trash", "restore it from the trash"), never "trash all my tasks".

### Runtime rules the gold must respect (SPEC §8 and the vault's own rules)

- Events may not overlap: seeding and `create` refuse a conflicting slot (`reschedule` does not check). Build the world without overlaps; a create clash is a legitimate repair or decline.
- `restore` works only for rows trashed within the last 30 days (relative to the session's today). Past the window the runtime ends the turn itself in `decline not_found` (SPEC §4.6): the reference stops at the `act restore`, the gold is `decline("not_found")`, and the call is not a `bad` repair.
- Refused deletes: a group that has expenses, a folder that still holds documents. Refused `remove_from`: a group member with an unsettled balance. Keep an empty group / folder in the world if you need those verbs.
- `linked_to` with several rows or an `@n` means _linked to all of them_, not any; "the people behind these debts" is not one call. Ask for the debts instead, or name one person.
- A named month (`{"unit":"month","name":4,"rel":…}`): rel 0 is this year's, rel 1 the next one that has not begun, rel -1 the last one fully ended (SPEC §14). In March, "april" is rel 0 (and rel 1 is the same April); in June, "last april" is rel -1 and "next april" rel 1.
- `where` numbers take the field's own unit only (`effort > 60`, `effort > 60 minutes`, `cadence > 14 days`); money takes a currency code (`amount > 50 EUR`). "1 hour" is refused.
- Undoing a photo delete puts it back in its albums; a later `restore` does not (the vault forgets the album once the photo is trashed).
- An `act` whose selector matches more than one row comes back `ambiguous`. A write on several rows names them (`rows="$a, $b"`) or uses an earlier result (`rows="@2"`).
- `undo` after `log`, `settle_up`, `settle_debt`, `cancel`, a debt `create`, a group delete or a notebook delete replies "not undone" (the journal keeps it); its gold is an empty diff.
- `settle_up` settles you against that one person only; in a larger group a following `remove_from` is still refused until every balance touching that member is settled.
- Debts take no date on `create`; debt date-shape cells are reached through `when` filters.
- A document's date cannot be edited (no `reschedule` on documents); name is its only editable field. Notebooks likewise, and their names are unique, so a multi-row notebook edit is refused.
- Seeded groups always carry a currency and tasks always a status, so `currency is empty` and `status is empty` on those kinds only ever answer empty.
- Rescheduling a cancelled event is refused ("not here to change"). A trashed event still blocks its slot: creating over it is refused as an overlap.
- A trashed document still keeps its folder, and it cannot be removed from the folder until it is restored; past the 30-day window its folder can never be deleted.
- A person cannot be added to an event (`add_to` puts a person in a group only).
- Person `create` refuses `starred`; create, then star `$new`. Trashed rows are not in the pre-grounding block: `find ... trashed=true` before a `$key` on one. A cancelled event does not block its slot (a trashed one does).
- A group delete also unlinks you; notebook and album deletes unlink their notes and photos.
- `settle_up` on a member with a zero balance and no amount is already-so; with an amount it also changes that person's `balance` (`upd(..., balance=ANY)`).
- `rows(..., also=diff(already=[...]))` drops the already part; use `diff(already=[...])` alone.
- A `:` inside a `field: value` body breaks the args; keep colons out of body text. A `$` in args text is read as a `$key` (`$20` fails); write amounts as "20 dollars" / "20 AUD".
- A task cannot be linked to a person (`add_to` refuses both directions).
- Notebook names must not collide with album names either (create or rename is refused). Group names are unique too, and a group's currency cannot be edited (name only).
- In gold, a settle-up amount is a string (`"64.50"`), never a float; deleting a photo carries its album unlink.
- `answer op=balance` by a nickname errors ("the selection holds none") rather than answering empty; search the nickname first.
- A gold turn cannot hold a write and an ending `ask`; split them.
- `!=` on a text or unit field (`cadence != 7 days`, `nickname != "X"`) also matches rows where the field is unset; pair it with `is set` when the unset rows are unwanted. `!=` on a number (`priority != 1`, `effort != 30 minutes`) leaves unset rows out.
- Undoing a person create trashes the row; undoing a group create removes it for good.
- On a note-type locker item `notes` is the secret, so an edit to it shows as "sealed".
- The scorer holds one change per row per turn: a restore and a reschedule of the same row go in separate turns.
- api_credential and software_licence items do not keep a `code`/`password`; reveal only the five secret-holding types.
- `$me` is usable only after the runtime has shown your own row (list the members first).
- Keep an answer that a later `$key` will refer back to at 12 rows or fewer; rows past the display cap carry no number and cannot be referenced.
- `rows(..., also=...)` / `val(..., also=...)` keep only the row and link diff; a settle-up read in the same turn needs its settlement check attached by hand.
- `priority = 0` does not match unset priorities; use `priority is empty`.
- Name selectors and the vault block match a person's nickname as a name of theirs, accents and case folded; `name="<nickname>"` resolves in one step, and a `search` first still verifies.
- `compute op=balance` takes no `group`. Locker `create` takes no secret fields.
- The pre-grounding block matches whole words and word starts (three letters or more) of names and nicknames, accents folded, and shows at most 8 rows with a container's live child count after it; anything else needs a `search`/`find` before a `$key` can be used.
- A multi-row `delete` is not all-or-nothing: if one row is refused the others stay deleted. A write on more than 12 rows is never run outright: the runtime ends the turn in its own ask with the count (SPEC §4.6, D-1044-12); the reference is the write, the gold `ask()`, and a following turn whose message is a plain yes ("yes", "go ahead", "all of them") sends the same write again with the full `diff` as its gold. Deleting a folder, group or notebook that still holds rows ends the turn in the runtime's ask (the folder's documents as options); the reference stops at the `act delete` and the gold is `ask(...)`.
- Event status cannot be edited (use `cancel`); seeded events are tentative or cancelled, so `status = "confirmed"` never matches.
- `add_to` a list moves the task: the gold carries the unlink from its old list.
- Only login, card, wifi, password and note locker items hold a revealable secret; the other types keep a memo only. The seeder drops `notes` on identity and password items and `username`/`url` on ssh_key and api_credential items; do not set them in the world.
- Seeded groups count you as a member (it matters for `person count`).
- Coverage credits a cell only when it can see the row's kind: on `rows="$c1"` / `rows="@n"` calls that change nothing visible (reveal, refusals, already-so), pass `kind=` explicitly.
- `reveal` takes password, code, card_number, cvv, content (not username).
- The overlap check skips messages under six words; longer ones must not echo eval text.

### Coverage: the cells your world owns

Coverage is measured on scenario cells, not on single productions. A cell is a combination from one of seven tables. `authored/cells.py` derives the universe from the export and the runtime rules above, lists the unreachable cells with their reason, and rotates every reachable A–E cell over the worlds so each cell is owned by two worlds.

| table | a cell is |
| --- | --- |
| A. act | verb × kind × selector (a named row, a `where` filter, `@prev`, `$new`, several rows; `create` has no selector) |
| B. where | field × operator × value form (literal, relative date, enum, unit-bearing, link count; the refused forms `1 hour` and `2 weeks` appear as repairs) |
| C. dates | kind × date shape (every point and span shape, named-month rel 0 and 1 and open spans included, on every kind with a date field) |
| D. tool outcome | tool × outcome (answer rows, value, empty; find hit, miss, ambiguous; search hit, miss; act changed, already, refused, ambiguous; compute each op; ask with and without options; decline each reason; undo after each verb class) |
| E. runtime behaviour | behaviour × kind (ambiguous, empty result, trashed row, restore window, refused delete, knock-on diff, `linked_to` all-semantics, photo undo, event overlap) |
| F. conversation | a referent by `@prev`, pronoun or ordinal; 1, 2, 3 or 4+ calls per turn; a `more=` continuation; a repair mid-session; a write then a read of the same row; session length 1–7 |
| G. phrasing | verb × kind and tool × outcome, each reached in at least two of the three moods (command, question, indirect "can you") and, wherever the turn names a row, both with and without the row named verbatim |

- **Your world owns the cells on its sheet** (pasted into your task; `python3 authored/cells.py --sheet I --of N` prints it). Every owned cell needs **at least 2 uses, in different sessions**. One example is not coverage: put the production in different sentences and situations.
- Corpus-wide, every reachable cell needs at least 3 uses from at least 2 worlds, and every cell of tables F (conversation structure) and G (phrasing: command / question / indirect, with and without the row named verbatim) must appear. Cells off your sheet are welcome wherever a session naturally reaches them; fill your sheet first.
- Past the sheet, follow how often people would actually ask: reads and simple writes on events, tasks and people dominate; crypto wallets and folder renames are rare. `when` may be written with `D()` / `U()` / `span()` or as JSON text; both count.

### Realism spec (our own product targets, aggregates)

These describe a believable personal assistant's traffic. They are our spec, not copies of any measured rate; aim for them across your 100 sessions.

- write like a person on a phone: lowercase, terse, rarely polite, shorthand, typos, dropped words, fragments ("and tuesday?"); later turns lean on earlier ones (pronouns, "that one", "the second one", "both")
- keep messages short: about a quarter at four words or fewer, few above ten; type contractions the way phones autocorrect them ("what's", "i'll", "don't"), not "whats"; say times and dates in words where a person would ("tuesday", "tonight") rather than digits; the app calls deleted rows "trash": users say "delete" for the action and "trash" only for the place ("what's in the trash", "restore it from the trash")
- session length spread over 1–7 turns, no single length above 40% of sessions
- turn outcomes mixed across answer-rows, answer-value, write, write+read, ask, decline and find-then-answer; no outcome above 45% of turns; asks 5–10% of turns
- at least 30% of messages name a row verbatim and at least 30% refer to one by description, pronoun or ordinal (nicknames, partial names, possessives, misspellings, "the yoga one"); the call grounds them
- **repair trajectories in 8–16% of sessions** (vault refusals count): a call the runtime rejects, wrapped `bad(call)` (from eval/gold.py), immediately followed by the call that fixes it. `build.py` checks mechanically that every `bad(...)` call is in fact rejected by the runtime and every other call is accepted, and writes that retry's trace itself (it needs no explanation from you). Vary the mistakes: a date with no day or unit, a verb the kind does not take, a field the kind lacks, balance over two people, a `#n` never shown, a wrong kind filter, a malformed where, a refused unit (`effort > 1 hour`, `cadence > 2 weeks`). The bad call must be a mistake a small model would plausibly make. A vault refusal (a group with expenses, a restore past the window, an overlapping event) is also a `bad(...)` call, followed by the ask, decline or other call that handles it.
- **ambiguity the runtime has to flag in 3–7% of turns**: the user names something several rows fit ("move the dentist" with two dentist appointments, "sam's number" with two Sams), the reference call names it the way the user did, the runtime answers `ambiguous: … fits …`, and the next call resolves it: pick by what an earlier turn established, or `ask` when nothing does. For a recurring series (two or more live events or tasks of one name, no date or ordinal in the message) the ask is the default; a pick by `#n` of the one instance that is not over (an event) or not closed (a task), after a `find` that showed the rows, is also legal. Build the world so these collisions exist. build.py records the runtime's `ambiguous:` replies.
- **empty results recovered from in at least 3% of turns**, and **trashed rows in at least 5% of turns** (finding, reading or restoring something deleted: `trashed: yes`, `restore`)
- at least one `undo` per world
- the world itself: 15–20 locker items covering every locker type, and enough rows per kind that `where` filters return 0, 1 and many

Check after each file (`N` worlds in the rotation, `I` your world's index, both in your task):

    python3 authored/coverage.py /tmp/authored-<W>/<W>.gold.jsonl --assign N --world I --md /tmp/authored-<W>/coverage.md

The world section of coverage.md must list no owned cell under 2 sessions by the last file (fill gaps in the next file, never by padding one session with calls). It also reports the realism figures above, and lists any message that overlaps eval text; that list must be empty.

## Verify (loop until 100%)

`PY` is a Python with torch (CPU), transformers and numpy. `NATIVETOOLS` is the runtime binary (default `target/debug/nativetools`, from `cargo build -p centraid-nativetools`).

    cd experiments/toolchat/native
    python3 authored/worlds/<W>_build.py
    HF_HUB_OFFLINE=1 $PY authored/build.py <W> --out /tmp/authored-<W>      # --only <W>-014 to rerun one

To see exactly what the model sees for a session (pre-grounding, `#n`, each call, each observation, the per-turn verdict):

    HF_HUB_OFFLINE=1 $PY authored/show.py <W> <W>-014[,<W>-015]

`/tmp/authored-<W>/<W>.report.json` lists each failing session's problems. Fix the reference (or the gold, when the gold was wrong under §8) until every session passes. A session the runtime cannot serve correctly is removed and reported, never forced.

## Report back

Sessions verified, owned cells still under 2 sessions, the realism figures from coverage.md, any runtime or tooling issue you hit (with the session and message), and anything in this brief that got in your way.
