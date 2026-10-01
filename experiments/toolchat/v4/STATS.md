# v4 STATS

Built by `sessgen.py` (canonical sessions) -> `select_batches.py` (selection, Sonnet batches) -> `run.sh` (Sonnet, PROMPT_V4.md) -> `build_v4.py` (checks, v3 conversion, this file).

|  | count |
| --- | --- |
| sessions (sessions.jsonl) | 2906 |
| generated sessions | 1406 |
| converted v3 one-turn sessions | 1500 |
| (v3 rows with an ISO date rewritten to a RelDate: see conversion table, `reldate`) |  |
| assistant turns (all) | 5114 |
| assistant turns (generated) | 3614 |
| held-out sessions | 160 |
| refuse share of turns | 3.0% (155; 140 converted) |
| turns with a RelDate | 10.1% (515) |
| clarify turns | 0 |
| unique turn skeletons (literals masked) | 694 |
| unique session skeleton sequences | 1046 |
| Sonnet calls | 67 |

## Turn-count mix (generated sessions)

| turns | sessions | share |
| ----- | -------- | ----- |
| 1     | 422      | 30.0% |
| 2     | 353      | 25.1% |
| 3     | 282      | 20.1% |
| 4     | 183      | 13.0% |
| 5-6   | 166      | 11.8% |

## Follow-up moves (turns after the first, generated sessions)

| move       | turns | share |
| ---------- | ----- | ----- |
| act        | 879   | 39.8% |
| new        | 787   | 35.6% |
| switch     | 155   | 7.0%  |
| backtrack  | 155   | 7.0%  |
| substitute | 150   | 6.8%  |
| refine     | 42    | 1.9%  |
| undo       | 40    | 1.8%  |

## Idioms and refs (generated sessions containing each)

| tag           | sessions |
| ------------- | -------- |
| act_held      | 476      |
| create        | 223      |
| value         | 172      |
| delete_kind   | 160      |
| backtrack     | 155      |
| switch        | 155      |
| reschedule    | 141      |
| contact       | 117      |
| whats_on      | 110      |
| last_contact  | 108      |
| log           | 105      |
| and_name      | 102      |
| login         | 95       |
| month_spend   | 82       |
| group_balance | 78       |
| settle        | 76       |
| trip_spend    | 76       |
| birthday      | 73       |
| weekend_past  | 72       |
| message       | 71       |
| when_is       | 71       |
| photo_place   | 71       |
| rx2           | 70       |
| album         | 62       |
| open_tasks    | 61       |
| overdue       | 59       |
| owe_x_sum     | 58       |
| did_delete    | 56       |
| no_deadline   | 54       |
| ticked        | 50       |
| substitute    | 48       |
| delete_class  | 48       |
| role          | 47       |
| amount        | 47       |
| owe_x         | 46       |
| c14           | 45       |
| last_journal  | 45       |
| hour_later    | 45       |
| same          | 42       |
| i_owe         | 41       |
| what_else     | 41       |
| value_sub     | 40       |
| v3walker      | 40       |
| undo          | 40       |
| notebook      | 40       |
| refine        | 40       |
| c12           | 40       |
| colleague     | 39       |
| mark_done     | 39       |
| reveal        | 39       |
| owes_me       | 39       |
| value_follow  | 38       |
| restore       | 38       |
| filed_under   | 38       |
| folder        | 38       |
| c13           | 36       |
| c10           | 28       |
| refuse        | 15       |

## Paraphrase rejects (per session variant)

| reason         | count |
| -------------- | ----- |
| reldate        | 15    |
| literal absent | 8     |
| stray weekday  | 6     |
| ordinal unsaid | 4     |
| near-duplicate | 3     |
| shape          | 2     |
| dialect leak   | 1     |
| empty          | 1     |
| no reply       | 1     |

## v3 conversion (rows dropped / rewritten)

| reason            | count |
| ----------------- | ----- |
| reldate           | 134   |
| literal absent    | 68    |
| log without since | 53    |
| clarify           | 34    |
| stray weekday     | 33    |
| dialect leak      | 21    |
| iso unsaid        | 10    |
| iso day           | 7     |
