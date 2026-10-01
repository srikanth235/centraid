# v5 coverage audit: what the executor answers vs what v4 trains

Sources: `crates/candidates/src/exec.rs` (the executor; no string literal copied from it) and `crates/evalsuite/grammar/derive/derived.json` / `terminals.json` (kind table, field typing, verb classes). Counts are assistant turns in `experiments/toolchat/v4/sessions.stripped.jsonl` containing the cell, computed by `python3 cells.py ../v4/sessions.stripped.jsonl` (`cells.py` holds the cell tagger and the target list). The after-v5 counts per cell are in [STATS.md](STATS.md).

## 1. What the executor supports

**Kinds** (a door read each; `kind_rows`): every kind of `terminals.json` whose door is one of the eight apps (agenda, docs, locker, notes, people, photos, tally, tasks), filtered to the kind's entity; `journal notes` are the People door's `knowledge.note` rows; `profiles` are People's party rows; `obligations` are built from the parties' `owed_to_me` / `owed_to_them` ids, one field-door read per column. Trashed rows are hidden unless the turn mentions `deleted_at` or the verb is a restore/undo (`mentions_trash`).

**`things`** (R-T1/R-T2): the union of all eight boards plus every party's obligations. `things during W` keeps only events, important dates and NOT-completed tasks. `things` is never a command anchor: any write `on (things ...)` clarifies (the member must say which kind), so `things` is for lists/counts only (`show (things called "X")`, `show (things during W)`, `count of (things ...)`), and a write on a row picked from a things list goes through a ref + verb class (`delete{} on (the 2nd one)`).

**Walks** (`walk` arms; target of source): expenses of groups, groups of expenses, settlements of groups, members of groups, obligations of parties, parties/profiles of parties (identity), important dates / contact channels / activities of parties, parties of obligations, parties of events (attendees), events of parties, photos of places, places of photos, photos of albums, albums of photos, tasks of tasks (subtasks), and any kind of a ref of the same kind (identity). Anything else is R-C4 **clarify**, except the party bridge: when every source row names a party (`party_id` / attendees) the walk is retried from those parties. A walk from held rows that reaches nothing clarifies.

**Filters** (`pred`): `and/or/not`; `count of Kind Cmp N` (a correlated walk count); membership `= (Set)`; `is [not] null`, `is [not] me`; `Field during Window`; `around N` (half-again band); `contains Lit` (case-insensitive substring); `in (...)`; `Field Cmp Lit|Field|(Set)`. A field is read from the row's reader extras (e.g. `favorite`, `album_titles`, `place` on photos; `starred`, `folder` on documents; `notebooks` on notes; `owed_to_me`, `owed_to_them`, `next_occurrence`, `member_party_ids`), its label/salient date/identity column, or the field door (probe budget 8 misses per entity/column). `deleted_at` is the liveness stamp.

**Windows** (`span`): phrases (`today`, `this week`, `last month`, `this weekend`, `last weekend`...), `before now`, ISO date / datetime / month / daterange stamps, rolling `next N days|weeks|months`, anchored windows between two values. RelDates are resolved before the executor (SPEC §1). `Set during W` tests the row's salient date (dtstart, due_at, captured_at, spent_on, started_at, next_occurrence, ...).

**Values**: `count of`, `sum|min|max F of` (numbers; min/max also on stamps), `F of Set` (one agreed value, R-C1: several different values clarify), `balance of (member) in (group)`, and `same? A B`.

**Commands with a body** (`body` arms; args read): `schedule.edit_task` (to), `schedule.reschedule_event` (to | by), `schedule.add_task` (title, due_at), `schedule.set_task_status` (status), `schedule.propose_event` (summary, dtstart, dtend default +1h), `schedule.cancel_event`, `schedule.delete_task`, `schedule.restore_task`, `schedule.delete_event`, `knowledge.create_note` (title), `knowledge.delete_note`, `core.trash_document`, `core.star_document`, `core.restore_document`, `locker.add_item` (type default note, title, content sealed by the seat), `locker.trash_item`, `locker.reveal_receipt` (columns, default password), `media.add_to_album` (album_id: a set that must resolve to ONE album, or a literal id), `media.restore_asset`, `media.delete_asset`, `people.log_interaction` (kind default call; `since` is carried per SPEC §4-H but not read), `people.settle_debt` (on obligations), `people.trash_person`, `people.undo_person` (needs the previous write's revision), `tally.add_expense` (amount_minor, description, group_id set, paid_by me|set, category), `tally.delete_expense`, `tally.undo_expense` (previous write's revision), `tally.settle_up` (group_id, from_party me|set|anchor, amount_minor literal or `balance of (it) in ...`), `tally.add_group_member` (group_id). **Verb classes** resolve by the anchor's entity: `reschedule` (task/event), `delete` (8 kinds), `cancel` (event), `restore` (8 kinds in the table, but only restore_task / restore_document / restore_asset have a body: a class `restore` on an event, note, locker item, expense or person is **unhandled**), `complete` (-> people.complete_task, no body: **unhandled**). Egress verbs (`social.send_message`, `locker.export`) are refused. Destructive verbs over an unbounded set are refused (R-R4); over rows spanning kinds they clarify (R-C3). Party-subject verbs (log_interaction, settle_debt, trash_person, add_group_member) need exactly one person — for `settle_debt` the person is the source of `obligations of (...)`, so money acts on a party go through `obligations of (parties called "X")`. A write whose anchor is only in the trash is `nothing` (R-N1). A failed restore/undo is a refusal.

## 2. Cells and their v4 counts

`<15` marks the under-covered cells (110 of 174). Walks count a named source only (`walk X of ref` is counted separately by `cells.py`).

| cell | idiomatic English | v4 turns |  |
| --- | --- | --- | --- |
| bare albums | all my albums / how many albums | 6 | **<15** |
| bare documents | all my documents / how many documents | 7 | **<15** |
| bare events | all my events / how many events | 10 | **<15** |
| bare expenses | all my expenses / how many expenses | 14 | **<15** |
| bare groups | all my groups / how many groups | 4 | **<15** |
| bare important dates | all my important dates / how many important dates | 13 | **<15** |
| bare locker items | all my locker items / how many locker items | 14 | **<15** |
| bare notes | all my notes / how many notes | 7 | **<15** |
| bare obligations | all my obligations / how many obligations | 12 | **<15** |
| bare parties | all my parties / how many parties | 26 |  |
| bare photos | all my photos / how many photos | 23 |  |
| bare places | all my places / how many places | 22 |  |
| bare settlements | all my settlements / how many settlements | 10 | **<15** |
| bare tasks | all my tasks / how many tasks | 18 |  |
| called albums | the <name> albums | 10 | **<15** |
| called documents | the <name> documents | 36 |  |
| called events | the <name> events | 163 |  |
| called expenses | the <name> expenses | 39 |  |
| called groups | the <name> groups | 274 |  |
| called journal notes | the <name> journal notes | 6 | **<15** |
| called locker items | the <name> locker items | 75 |  |
| called members | the <name> members | 167 |  |
| called notes | the <name> notes | 26 |  |
| called parties | the <name> parties | 686 |  |
| called photos | the <name> photos | 141 |  |
| called places | the <name> places | 7 | **<15** |
| called tasks | the <name> tasks | 93 |  |
| called things | what do I have about X (things called) | 0 | **<15** |
| cmd cancel on events | cancel (class verb) | 7 | **<15** (not generated, s.4) |
| cmd core.restore_document | write | 5 | **<15** |
| cmd core.star_document | write | 24 |  |
| cmd core.trash_document | write | 29 |  |
| cmd delete on documents | delete / bin (class verb) | 0 | **<15** (not generated, s.4) |
| cmd delete on events | delete / bin (class verb) | 0 | **<15** (not generated, s.4) |
| cmd delete on expenses | delete / bin (class verb) | 0 | **<15** (not generated, s.4) |
| cmd delete on locker items | delete / bin (class verb) | 0 | **<15** (not generated, s.4) |
| cmd delete on notes | delete / bin (class verb) | 3 | **<15** (not generated, s.4) |
| cmd delete on photos | delete / bin (class verb) | 3 | **<15** (not generated, s.4) |
| cmd delete on tasks | delete / bin (class verb) | 0 | **<15** (not generated, s.4) |
| cmd knowledge.create_note | write | 47 |  |
| cmd knowledge.delete_note | write | 36 |  |
| cmd locker.add_item | write | 5 | **<15** |
| cmd locker.add_item type=note | save the code 4417 in my locker | 0 | **<15** |
| cmd locker.reveal_receipt | write | 35 |  |
| cmd locker.trash_item | write | 29 |  |
| cmd media.add_to_album | write | 1 | **<15** |
| cmd media.add_to_album album_id:(set) | add these photos to album X | 1 | **<15** |
| cmd media.delete_asset | write | 25 |  |
| cmd media.restore_asset | write | 10 | **<15** |
| cmd people.log_interaction | write | 54 |  |
| cmd people.settle_debt | write | 79 |  |
| cmd people.trash_person | write | 14 | **<15** |
| cmd people.undo_person | put them back after deleting a person | 0 | **<15** |
| cmd reschedule on events | move / push | 71 |  |
| cmd reschedule on tasks | move / push | 31 |  |
| cmd restore on documents | put it back (class verb) | 0 | **<15** (not generated, s.4) |
| cmd restore on photos | put it back (class verb) | 0 | **<15** (not generated, s.4) |
| cmd restore on tasks | put it back (class verb) | 0 | **<15** (not generated, s.4) |
| cmd schedule.add_task | write | 42 |  |
| cmd schedule.cancel_event | write | 10 | **<15** |
| cmd schedule.delete_event | write | 16 |  |
| cmd schedule.delete_task | write | 23 |  |
| cmd schedule.edit_task | write | 2 | **<15** (not generated, s.4) |
| cmd schedule.propose_event | write | 69 |  |
| cmd schedule.reschedule_event | write | 11 | **<15** (not generated, s.4) |
| cmd schedule.restore_task | write | 10 | **<15** |
| cmd schedule.set_task_status | write | 39 |  |
| cmd tally.add_expense | write | 67 |  |
| cmd tally.add_group_member | write | 19 |  |
| cmd tally.delete_expense | write | 24 |  |
| cmd tally.settle_up | write | 11 | **<15** |
| cmd tally.undo_expense | put it back after deleting an expense | 0 | **<15** |
| count activities | how many activities | 4 | **<15** |
| count albums | how many albums | 2 | **<15** |
| count contact channels | how many contact channels | 2 | **<15** |
| count documents | how many documents | 6 | **<15** |
| count events | how many events | 5 | **<15** |
| count expenses | how many expenses | 7 | **<15** |
| count groups | how many groups | 3 | **<15** |
| count important dates | how many important dates | 2 | **<15** |
| count locker items | how many things in my locker | 1 | **<15** |
| count members | how many members | 6 | **<15** |
| count notes | how many notes | 6 | **<15** |
| count obligations | how many obligations | 1 | **<15** |
| count parties | how many parties | 10 | **<15** |
| count photos | how many photos | 3 | **<15** |
| count places | how many places | 6 | **<15** |
| count tasks | how many tasks | 18 |  |
| field-of amount_minor expenses | when is / how much was / what is | 1 | **<15** |
| field-of dtstart events | when is / how much was / what is | 33 |  |
| field-of due_at tasks | when is / how much was / what is | 0 | **<15** |
| field-of next_occurrence important dates | when is / how much was / what is | 0 | **<15** |
| field-of spent_on expenses | when is / how much was / what is | 4 | **<15** |
| field-of value contact channels | when is / how much was / what is | 0 | **<15** |
| filter activities: started_at | calls/visits when | 7 | **<15** |
| filter contact channels: kind | phone / email / address | 175 |  |
| filter contact channels: label | work / home number | 0 | **<15** |
| filter documents: deleted_at is not null | binned docs | 7 | **<15** |
| filter documents: folder | in folder X | 24 |  |
| filter documents: starred = true | starred docs | 1 | **<15** |
| filter documents: updated_at | changed recently | 7 | **<15** |
| filter events: deleted_at is not null | deleted events | 0 | **<15** |
| filter events: dtstart | starting before/after | 3 | **<15** |
| filter events: status | cancelled / tentative | 9 | **<15** |
| filter expenses: amount_minor | over / under N | 0 | **<15** |
| filter expenses: category | food / travel spending | 2 | **<15** |
| filter expenses: spent_on | spent when | 54 |  |
| filter important dates: label | birthday / anniversary | 88 |  |
| filter important dates: next_occurrence | coming up when | 10 | **<15** |
| filter locker items: compromised = true | compromised logins | 0 | **<15** |
| filter locker items: type | cards / wifi / notes in the locker | 2 | **<15** |
| filter members: party_id is not me | the others in the group, not me | 0 | **<15** |
| filter notes: deleted_at is not null | deleted notes | 0 | **<15** |
| filter notes: notebooks | in notebook X | 25 |  |
| filter notes: pinned = true | pinned notes | 0 | **<15** |
| filter notes: updated_at | edited recently | 1 | **<15** |
| filter obligations: from_party = me | debts I owe | 7 | **<15** |
| filter obligations: settled_at is null | outstanding debts | 142 |  |
| filter obligations: to_party = me | money owed to me | 11 | **<15** |
| filter parties: birth_date | born before/after | 9 | **<15** (not generated, s.4) |
| filter parties: deleted_at is not null | removed contacts | 1 | **<15** |
| filter parties: kind | organisations / pets | 3 | **<15** |
| filter parties: owed_to_me is not null | who owes me | 10 | **<15** |
| filter parties: owed_to_them is not null | who I owe | 14 | **<15** |
| filter parties: role | my dentist / plumber | 71 |  |
| filter photos: album_titles | in album X | 55 |  |
| filter photos: deleted_at is not null | deleted photos | 6 | **<15** |
| filter photos: favorite = true | my favourite photos | 0 | **<15** |
| filter photos: place | taken at X | 2 | **<15** |
| filter places: kind | home / work / venue places | 1 | **<15** |
| filter tasks: completed_at | finished when | 59 |  |
| filter tasks: deleted_at is not null | in the trash / deleted | 10 | **<15** |
| filter tasks: due_at | due before/after/during | 191 |  |
| filter tasks: due_at is null | no due date | 39 |  |
| filter tasks: priority | high-priority | 9 | **<15** |
| filter tasks: status != completed | open / still to do | 209 |  |
| filter tasks: status = completed | done / ticked off | 57 |  |
| filter things: folder | anything filed under X | 18 |  |
| filter things: notebooks | anything in notebook X | 18 |  |
| max amount_minor expenses | total / biggest / smallest / earliest | 0 | **<15** |
| max dtstart events | total / biggest / smallest / earliest | 0 | **<15** |
| members excluding me | who else is in the group (not me) | 2 | **<15** |
| min amount_minor expenses | total / biggest / smallest / earliest | 0 | **<15** |
| min due_at tasks | total / biggest / smallest / earliest | 3 | **<15** |
| money act via obligations of | settle/sum/show money with a person | 63 |  |
| nothing | forget it / never mind | 37 |  |
| order activities | activities sorted by / latest / earliest | 75 |  |
| order documents | documents sorted by / latest / earliest | 3 | **<15** |
| order events | events sorted by / latest / earliest | 11 | **<15** |
| order expenses | expenses sorted by / latest / earliest | 5 | **<15** |
| order journal notes | journal notes sorted by / latest / earliest | 45 |  |
| order notes | notes sorted by / latest / earliest | 4 | **<15** |
| order obligations | obligations sorted by / latest / earliest | 1 | **<15** |
| order parties | parties sorted by / latest / earliest | 14 | **<15** |
| order photos | photos sorted by / latest / earliest | 2 | **<15** |
| order tasks | tasks sorted by / latest / earliest | 68 |  |
| sum amount_minor expenses | total / biggest / smallest / earliest | 53 |  |
| sum amount_minor obligations | total / biggest / smallest / earliest | 49 |  |
| walk activities of parties | activities of a named parties | 69 |  |
| walk albums of photos | albums of a named photos | 0 | **<15** |
| walk contact channels of parties | contact channels of a named parties | 150 |  |
| walk events of parties | events of a named parties | 11 | **<15** |
| walk expenses of groups | expenses of a named groups | 57 |  |
| walk groups of expenses | groups of a named expenses | 6 | **<15** |
| walk important dates of parties | important dates of a named parties | 96 |  |
| walk members of groups | members of a named groups | 40 |  |
| walk obligations of parties | obligations of a named parties | 150 |  |
| walk parties of events | parties of a named events | 3 | **<15** |
| walk parties of obligations | parties of a named obligations | 5 | **<15** |
| walk photos of albums | photos of a named albums | 3 | **<15** |
| walk photos of places | photos from/taken at a place | 5 | **<15** |
| walk places of photos | places of a named photos | 63 |  |
| walk settlements of groups | settlements of a named groups | 8 | **<15** |
| walk tasks of tasks | tasks of a named tasks | 8 | **<15** |

## 3. The known holes, verified

| hole | v4 turns | verdict |
| --- | --- | --- |
| `things called "X"` ("what do I have about X") | 0 | hole |
| `photos of (places called "X")` ("photos from a place") | 5 | hole (<15) |
| `favorite = true` on photos | 0 (`favorite = false` 1, `favorite of` 2) | hole |
| `count of (locker items)` | 1 | hole |
| `tally.undo_expense` / `people.undo_person` ("put it back" after deleting an expense/person) | 0 / 0 | hole |
| `media.add_to_album` from a held photo set (`on (them)`) | 0 (1 on a named set) | hole |
| "forget it" / "never mind" -> `nothing` | 37 | NOT a hole (all as a follow-up; kept, v5 adds 16x5 more) |
| "save the code 4417 in my locker" -> `locker.add_item{ type: "note", ... }` | 0 (5 add_item, all login/membership) | hole |
| members of a group excluding me (`that (party_id is not me)`) | 2 (plus 2 on other kinds) | hole |
| money acts on a party via `obligations of (...)` | 63 via obligations; 5 act on parties/members directly (e.g. `people.settle_debt{} on (parties during tomorrow)`) | covered, with 5 contradicting rows in v4 |

## 4. Not generated in v5, and why

- `cmd delete|restore|cancel|reschedule on <named kind>` (class verb with a known kind): v4 and v5 write the DIRECT verb when the kind is named (`schedule.delete_task{} on (tasks called ...)`) and the class verb only on refs whose kind the sentence does not fix (after a `things` list). Adding both forms for the same request would make the target ambiguous. Class verbs on refs are generated in multi-turn sessions (`delete{}` / `restore{}` after a `things during` list).
- `cmd schedule.edit_task` / `cmd schedule.reschedule_event` direct: same reason, the class `reschedule` is the form.
- `filter parties: birth_date`: needs an ISO date the user must say with its day ("born before 1 January 1990"); left at its v4 count (6).
- restore of events, notes, locker items, expenses, persons (class `restore` -> no body) and `complete` (people.complete_task, no body): unhandled by the executor, not generated.
- v4 contains 79 turns walking edges the executor does not hold (e.g. `parties of photos` 7, `expenses of members` 6, `groups of members` 6, `notes of parties` 5, `documents of parties` 4); they clarify unless the party bridge applies. They are kept as v4 had them (this lane does not rewrite v4's canonicals except literals, SPEC §5).
