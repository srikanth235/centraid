# v5 STATS

Built by `gen5.py` (canonical sessions for the under-covered cells, COVERAGE.md) -> `make_batches5.py` -> `run.sh` (Sonnet, PROMPT_V5.md) -> `build5.py` (synthetic vaults via `vault.py`, rendering via `retrieve.py`, checks, v4 conversion, this file).

|  | count |
| --- | --- |
| train sessions (sessions.jsonl) | 7768 |
| - new single/two-turn (part a) | 4800 |
| - new multi-turn (part b) | 343 |
| - v4 sessions re-rendered | 2625 (of 2625) |
| held-out sessions | 160 (v4 held-out 108, new 52) |
| assistant turns (train) | 10178 |
| unique session skeleton sequences (train) | 1292 |
| sessions naming a stored row | 4171 (53.7%) |
| sessions whose target literal is a vault label | 3130 (40.3%) |
| sessions whose target is a vault label the user did NOT say verbatim | 2589 (33.3%) |
| sessions with a named row ABSENT from the vault/candidates (user's words written) | 1222 (15.7%) |
| user turns with a `vault:` line | 8530 / 10178 (83.8%) |
| assistant turns naming a row (called / field value) | 4586 |
| - of which the literal is a shown candidate label (candidate hit) | 3347 (73.0%) |
| refuse share of turns | 1.4% |
| Sonnet calls (raw/calls.log) | 92 |

## Candidates shown per user turn

| candidates | turns |
| ---------- | ----- |
| 0          | 1648  |
| 1          | 587   |
| 2          | 408   |
| 3          | 271   |
| 4          | 170   |
| 5          | 143   |
| 6          | 6951  |

## Rank of the written label among the shown candidates (`called` literals)

| rank | turns |
| ---- | ----- |
| 1    | 1852  |
| 2    | 445   |
| 3    | 299   |
| 4    | 204   |
| 5    | 182   |
| 6    | 149   |

## Coverage cells (assistant turns containing the cell): v4 before -> v5 after

Cells are the executor-supported (kind x construct) cells of COVERAGE.md.

| cell | v4 | v5 |  |
| --- | --- | --- | --- |
| bare albums | 6 | 35 |  |
| bare documents | 7 | 41 |  |
| bare events | 10 | 33 |  |
| bare expenses | 14 | 31 |  |
| bare groups | 4 | 37 |  |
| bare important dates | 13 | 31 |  |
| bare locker items | 14 | 50 |  |
| bare notes | 7 | 26 |  |
| bare obligations | 12 | 32 |  |
| bare parties | 26 | 38 |  |
| bare photos | 23 | 23 |  |
| bare places | 22 | 34 |  |
| bare settlements | 10 | 31 |  |
| bare tasks | 18 | 18 |  |
| called albums | 10 | 314 |  |
| called documents | 36 | 96 |  |
| called events | 163 | 344 |  |
| called expenses | 39 | 287 |  |
| called groups | 274 | 656 |  |
| called journal notes | 6 | 70 |  |
| called locker items | 75 | 75 |  |
| called members | 167 | 167 |  |
| called notes | 26 | 71 |  |
| called parties | 686 | 1405 |  |
| called photos | 141 | 314 |  |
| called places | 7 | 263 |  |
| called tasks | 93 | 321 |  |
| called things | 0 | 92 |  |
| cmd cancel on events | 7 | 7 | <15, not generated (COVERAGE.md s.4) |
| cmd core.restore_document | 5 | 77 |  |
| cmd core.star_document | 24 | 36 |  |
| cmd core.trash_document | 29 | 53 |  |
| cmd delete on documents | 0 | 0 | <15, not generated (COVERAGE.md s.4) |
| cmd delete on events | 0 | 0 | <15, not generated (COVERAGE.md s.4) |
| cmd delete on expenses | 0 | 0 | <15, not generated (COVERAGE.md s.4) |
| cmd delete on locker items | 0 | 0 | <15, not generated (COVERAGE.md s.4) |
| cmd delete on notes | 3 | 3 | <15, not generated (COVERAGE.md s.4) |
| cmd delete on photos | 3 | 3 | <15, not generated (COVERAGE.md s.4) |
| cmd delete on tasks | 0 | 0 | <15, not generated (COVERAGE.md s.4) |
| cmd knowledge.create_note | 47 | 47 |  |
| cmd knowledge.delete_note | 36 | 60 |  |
| cmd locker.add_item | 5 | 152 |  |
| cmd locker.add_item type=note | 0 | 87 |  |
| cmd locker.reveal_receipt | 35 | 39 |  |
| cmd locker.trash_item | 29 | 41 |  |
| cmd media.add_to_album | 1 | 159 |  |
| cmd media.add_to_album album_id:(set) | 1 | 159 |  |
| cmd media.delete_asset | 25 | 39 |  |
| cmd media.restore_asset | 10 | 86 |  |
| cmd people.log_interaction | 54 | 54 |  |
| cmd people.settle_debt | 79 | 87 |  |
| cmd people.trash_person | 14 | 183 |  |
| cmd people.undo_person | 0 | 89 |  |
| cmd reschedule on events | 71 | 71 |  |
| cmd reschedule on tasks | 31 | 31 |  |
| cmd restore on documents | 0 | 0 | <15, not generated (COVERAGE.md s.4) |
| cmd restore on photos | 0 | 0 | <15, not generated (COVERAGE.md s.4) |
| cmd restore on tasks | 0 | 0 | <15, not generated (COVERAGE.md s.4) |
| cmd schedule.add_task | 42 | 42 |  |
| cmd schedule.cancel_event | 10 | 105 |  |
| cmd schedule.delete_event | 16 | 16 |  |
| cmd schedule.delete_task | 23 | 35 |  |
| cmd schedule.edit_task | 2 | 2 | <15, not generated (COVERAGE.md s.4) |
| cmd schedule.propose_event | 69 | 69 |  |
| cmd schedule.reschedule_event | 11 | 11 | <15, not generated (COVERAGE.md s.4) |
| cmd schedule.restore_task | 10 | 75 |  |
| cmd schedule.set_task_status | 39 | 43 |  |
| cmd tally.add_expense | 67 | 67 |  |
| cmd tally.add_group_member | 19 | 19 |  |
| cmd tally.delete_expense | 24 | 113 |  |
| cmd tally.settle_up | 11 | 67 |  |
| cmd tally.undo_expense | 0 | 81 |  |
| count activities | 4 | 68 |  |
| count albums | 2 | 15 |  |
| count contact channels | 2 | 50 |  |
| count documents | 6 | 70 |  |
| count events | 5 | 53 |  |
| count expenses | 7 | 67 |  |
| count groups | 3 | 20 |  |
| count important dates | 2 | 45 |  |
| count locker items | 1 | 83 |  |
| count members | 6 | 88 |  |
| count notes | 6 | 60 |  |
| count obligations | 1 | 18 |  |
| count parties | 10 | 63 |  |
| count photos | 3 | 114 |  |
| count places | 6 | 18 |  |
| count tasks | 18 | 18 |  |
| field-of amount_minor expenses | 1 | 58 |  |
| field-of dtstart events | 33 | 33 |  |
| field-of due_at tasks | 0 | 60 |  |
| field-of next_occurrence important dates | 0 | 61 |  |
| field-of spent_on expenses | 4 | 54 |  |
| field-of value contact channels | 0 | 57 |  |
| filter activities: started_at | 7 | 110 |  |
| filter contact channels: kind | 175 | 247 |  |
| filter contact channels: label | 0 | 55 |  |
| filter documents: deleted_at is not null | 7 | 94 |  |
| filter documents: folder | 24 | 74 |  |
| filter documents: starred = true | 1 | 21 |  |
| filter documents: updated_at | 7 | 72 |  |
| filter events: deleted_at is not null | 0 | 62 |  |
| filter events: dtstart | 3 | 78 |  |
| filter events: status | 9 | 77 |  |
| filter expenses: amount_minor | 0 | 73 |  |
| filter expenses: category | 2 | 70 |  |
| filter expenses: spent_on | 54 | 310 |  |
| filter important dates: label | 88 | 149 |  |
| filter important dates: next_occurrence | 10 | 111 |  |
| filter locker items: compromised = true | 0 | 22 |  |
| filter locker items: type | 2 | 135 |  |
| filter members: party_id is not me | 0 | 90 |  |
| filter notes: deleted_at is not null | 0 | 68 |  |
| filter notes: notebooks | 25 | 70 |  |
| filter notes: pinned = true | 0 | 14 | **<15** |
| filter notes: updated_at | 1 | 62 |  |
| filter obligations: from_party = me | 7 | 58 |  |
| filter obligations: settled_at is null | 142 | 297 |  |
| filter obligations: to_party = me | 11 | 47 |  |
| filter parties: birth_date | 9 | 9 | <15, not generated (COVERAGE.md s.4) |
| filter parties: deleted_at is not null | 1 | 75 |  |
| filter parties: kind | 3 | 59 |  |
| filter parties: owed_to_me is not null | 10 | 48 |  |
| filter parties: owed_to_them is not null | 14 | 36 |  |
| filter parties: role | 71 | 82 |  |
| filter photos: album_titles | 55 | 75 |  |
| filter photos: deleted_at is not null | 6 | 89 |  |
| filter photos: favorite = true | 0 | 89 |  |
| filter photos: place | 2 | 63 |  |
| filter places: kind | 1 | 63 |  |
| filter tasks: completed_at | 59 | 59 |  |
| filter tasks: deleted_at is not null | 10 | 135 |  |
| filter tasks: due_at | 191 | 191 |  |
| filter tasks: due_at is null | 39 | 39 |  |
| filter tasks: priority | 9 | 65 |  |
| filter tasks: status != completed | 209 | 272 |  |
| filter tasks: status = completed | 57 | 57 |  |
| filter things: folder | 18 | 18 |  |
| filter things: notebooks | 18 | 18 |  |
| max amount_minor expenses | 0 | 60 |  |
| max dtstart events | 0 | 60 |  |
| members excluding me | 2 | 92 |  |
| min amount_minor expenses | 0 | 68 |  |
| min due_at tasks | 3 | 20 |  |
| money act via obligations of | 63 | 63 |  |
| nothing | 37 | 143 |  |
| order activities | 75 | 93 |  |
| order documents | 3 | 67 |  |
| order events | 11 | 127 |  |
| order expenses | 5 | 77 |  |
| order journal notes | 45 | 45 |  |
| order notes | 4 | 42 |  |
| order obligations | 1 | 72 |  |
| order parties | 14 | 35 |  |
| order photos | 2 | 92 |  |
| order tasks | 68 | 68 |  |
| sum amount_minor expenses | 53 | 112 |  |
| sum amount_minor obligations | 49 | 80 |  |
| walk activities of parties | 69 | 94 |  |
| walk albums of photos | 0 | 76 |  |
| walk contact channels of parties | 150 | 310 |  |
| walk events of parties | 11 | 202 |  |
| walk expenses of groups | 57 | 152 |  |
| walk groups of expenses | 6 | 68 |  |
| walk important dates of parties | 96 | 157 |  |
| walk members of groups | 40 | 192 |  |
| walk obligations of parties | 150 | 200 |  |
| walk parties of events | 3 | 67 |  |
| walk parties of obligations | 5 | 72 |  |
| walk photos of albums | 3 | 69 |  |
| walk photos of places | 5 | 209 |  |
| walk places of photos | 63 | 63 |  |
| walk settlements of groups | 8 | 86 |  |
| walk tasks of tasks | 8 | 65 |  |

## Rejects

| reason                               | count |
| ------------------------------------ | ----- |
| near-duplicate                       | 428   |
| shape                                | 90    |
| refer word unsaid                    | 38    |
| v4 target not in candidates (retry)  | 28    |
| held-out dropped (skeleton in train) | 28    |
| ordinal unsaid                       | 26    |
| full title unsaid                    | 25    |
| target not in candidates             | 16    |
| v4 target not retrievable (retry)    | 14    |
| literal illegal                      | 6     |
| dialect leak                         | 6     |
| target not retrievable               | 4     |
| no reply                             | 4     |
| loose said full title                | 1     |
| reldate                              | 1     |
