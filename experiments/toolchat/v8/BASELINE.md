# v8 per-skill baselines

Two runs over the dev-90 sessions (`crates/evalsuite/suite.json` ∩ `out/dev90.ids.json`, 184 turns), scored per skill by [`skillscore.py`](skillscore.py) against [`dev_skills.json`](dev_skills.json):

- **a1** — the first fine-tuned Granite 4.0 350m (`a1-bf16.gguf`), turns and steps from the scratchpad run (`a1.turns.jsonl`, `a1.steps.jsonl`).
- **sonnet-r8** — Sonnet playing the same tools, the near-ceiling reference (`sonnet90/turns-r8.jsonl`, `sonnet90/traj-r8.jsonl`).

Neither turns file carries `tier` yet, so `asked` is derived: a failed turn whose last call was `done` (the runtime asks back) or whose complaint says it declined to "clarify". A `tier` column from `tool-loop score` takes precedence once present.

```sh
python3 v8/skillscore.py --markdown --turns $SP/a1.turns.jsonl --steps $SP/a1.steps.jsonl --labels a1
python3 v8/skillscore.py --markdown --turns $SP/sonnet90/turns-r8.jsonl --steps $SP/sonnet90/traj-r8.jsonl --labels sonnet-r8
python3 v8/skillscore.py --markdown --turns $SP/a1.turns.jsonl --steps $SP/a1.steps.jsonl \
    --turns2 $SP/sonnet90/turns-r8.jsonl --steps2 $SP/sonnet90/traj-r8.jsonl --labels a1 sonnet
```

**Attribution is coarse.** A turn needs 2.6 skills on average, and its pass/fail is charged to every one of them. A skill at 0% means every turn that needs it failed, not that the skill caused the failure. Skills that only 1-3 dev turns need (`time.shift`, `link.subtasks`, `num.dtstart_of`, `compose.then`, `write.event`, and others) are measured on too few turns to rank. Treat them as coverage checks.

## Where to spend training rows

A row is one training turn. It counts toward every skill it exercises. Each skill needs its rows spread over at least 10 worlds.

- **80** is the floor. Only skills a1 passed on every dev turn get just the floor.
- **160** (2×) goes to any skill a1 failed at least once.
- **240** (3×) goes to skills a1 failed on 10 or more dev turns. These are the high-volume skills that sink whole sessions.

The ten worst a1 skills follow, in the table's order (accuracy, then dev volume). 23 skills tie at 0%, so the volume tie-break picks this ten. The high-volume list after it matters as much.

| # | skill | dev turns | a1 | sonnet-r8 | target rows |
| --: | --- | --: | --: | --: | --: |
| 1 | `route.media` | 10 | 0/10 (0%) | 9/10 (90%) | 240 |
| 2 | `follow.back_to` | 7 | 0/7 (0%) | 7/7 (100%) | 160 |
| 3 | `handle.them` | 7 | 0/7 (0%) | 7/7 (100%) | 160 |
| 4 | `follow.except` | 5 | 0/5 (0%) | 4/5 (80%) | 160 |
| 5 | `write.settle` | 5 | 0/5 (0%) | 5/5 (100%) | 160 |
| 6 | `compose.bulk` | 4 | 0/4 (0%) | 4/4 (100%) | 160 |
| 7 | `copy.number` | 4 | 0/4 (0%) | 4/4 (100%) | 160 |
| 8 | `follow.swap_subject` | 4 | 0/4 (0%) | 4/4 (100%) | 160 |
| 9 | `num.value_of` | 4 | 0/4 (0%) | 4/4 (100%) | 160 |
| 10 | `write.restore` | 4 | 0/4 (0%) | 4/4 (100%) | 160 |

The skills a1 failed on the most dev turns (target 240):

| skill                | dev turns | a1 failed |  a1 | sonnet-r8 |
| -------------------- | --------: | --------: | --: | --------: |
| `copy.anchor`        |        46 |        36 | 22% |       98% |
| `handle.pick`        |        31 |        27 | 13% |       97% |
| `copy.name`          |        28 |        20 | 29% |      100% |
| `route.schedule`     |        25 |        17 | 32% |      100% |
| `route.library`      |        20 |        17 | 15% |      100% |
| `link.media`         |        16 |        14 | 12% |      100% |
| `time.window`        |        20 |        13 | 35% |       95% |
| `follow.switch_kind` |        14 |        13 |  7% |       93% |
| `filter.field`       |        16 |        11 | 31% |      100% |
| `route.media`        |        10 |        10 |  0% |       90% |
| `handle.far`         |        12 |        10 | 17% |       92% |

The targets for every skill are below: 11 at 240, 52 at 160 and 2 at 80, which is 11120 skill-rows in total. Rows are multi-skill, so the corpus needs far fewer distinct rows than that (at about 2.6 skills per turn, roughly 4300 turns if they were spread evenly). `follow.back_to` and `handle.far` rows must be sessions of 4 or more turns with a detour, and `compose.correction` and `compose.undo` rows must follow a landed write.

<details><summary>All 65 targets</summary>

| skill | group | dev turns | a1 pass | sonnet pass | target |
| --- | --- | --: | --: | --: | --: |
| `route.media` | route | 10 | 0 | 9 | 240 |
| `follow.switch_kind` | follow | 14 | 1 | 13 | 240 |
| `link.media` | link | 16 | 2 | 16 | 240 |
| `handle.pick` | handle | 31 | 4 | 30 | 240 |
| `route.library` | route | 20 | 3 | 20 | 240 |
| `handle.far` | handle | 12 | 2 | 11 | 240 |
| `copy.anchor` | copy | 46 | 10 | 45 | 240 |
| `copy.name` | copy | 28 | 8 | 28 | 240 |
| `filter.field` | filter | 16 | 5 | 16 | 240 |
| `route.schedule` | route | 25 | 8 | 25 | 240 |
| `time.window` | time | 20 | 7 | 19 | 240 |
| `compose.bulk` | compose | 4 | 0 | 4 | 160 |
| `compose.correction` | compose | 2 | 0 | 2 | 160 |
| `compose.then` | compose | 1 | 0 | 1 | 160 |
| `compose.undo` | compose | 2 | 0 | 2 | 160 |
| `copy.number` | copy | 4 | 0 | 4 | 160 |
| `filter.numeric` | filter | 3 | 0 | 3 | 160 |
| `follow.back_to` | follow | 7 | 0 | 7 | 160 |
| `follow.except` | follow | 5 | 0 | 4 | 160 |
| `follow.swap_subject` | follow | 4 | 0 | 4 | 160 |
| `handle.them` | handle | 7 | 0 | 7 | 160 |
| `judge.refuse_guard` | judge | 2 | 0 | 2 | 160 |
| `link.subtasks` | link | 1 | 0 | 1 | 160 |
| `num.balance` | num | 2 | 0 | 2 | 160 |
| `num.count` | num | 2 | 0 | 2 | 160 |
| `num.dtstart_of` | num | 1 | 0 | 1 | 160 |
| `num.value_of` | num | 4 | 0 | 4 | 160 |
| `time.derived` | time | 3 | 0 | 2 | 160 |
| `time.order` | time | 3 | 0 | 3 | 160 |
| `time.shift` | time | 1 | 0 | 1 | 160 |
| `write.album_add` | write | 2 | 0 | 2 | 160 |
| `write.restore` | write | 4 | 0 | 4 | 160 |
| `write.settle` | write | 5 | 0 | 5 | 160 |
| `follow.narrow` | follow | 8 | 1 | 8 | 160 |
| `write.reschedule` | write | 7 | 1 | 7 | 160 |
| `time.field` | time | 6 | 1 | 6 | 160 |
| `filter.open` | filter | 5 | 1 | 5 | 160 |
| `route.everything` | route | 5 | 1 | 5 | 160 |
| `write.trash` | write | 5 | 1 | 5 | 160 |
| `compose.lookup_write` | compose | 8 | 2 | 8 | 160 |
| `handle.ordinal` | handle | 4 | 1 | 4 | 160 |
| `route.locker` | route | 8 | 2 | 6 | 160 |
| `write.add_task` | write | 4 | 1 | 3 | 160 |
| `write.log_interaction` | write | 4 | 1 | 4 | 160 |
| `copy.date` | copy | 9 | 3 | 8 | 160 |
| `filter.trashed` | filter | 3 | 1 | 3 | 160 |
| `judge.no_link` | judge | 3 | 1 | 2 | 160 |
| `judge.refuse_outside` | judge | 3 | 1 | 3 | 160 |
| `link.of_group` | link | 6 | 2 | 6 | 160 |
| `route.day` | route | 6 | 2 | 6 | 160 |
| `route.money` | route | 12 | 4 | 12 | 160 |
| `write.mark` | write | 3 | 1 | 3 | 160 |
| `write.reveal` | write | 3 | 1 | 3 | 160 |
| `copy.title` | copy | 8 | 3 | 7 | 160 |
| `link.parties_of` | link | 8 | 3 | 7 | 160 |
| `judge.ambiguous` | judge | 5 | 2 | 4 | 160 |
| `num.sum` | num | 7 | 3 | 7 | 160 |
| `route.people` | route | 9 | 4 | 8 | 160 |
| `judge.nothing_there` | judge | 4 | 2 | 4 | 160 |
| `write.note` | write | 2 | 1 | 2 | 160 |
| `write.tally` | write | 2 | 1 | 2 | 160 |
| `link.of_person` | link | 9 | 5 | 9 | 160 |
| `num.owed` | num | 4 | 3 | 4 | 160 |
| `judge.never_mind` | judge | 3 | 3 | 3 | 80 |
| `write.event` | write | 1 | 1 | 1 | 80 |

</details>

## a1

> Coarse attribution: every skill a turn needs (v8/dev_skills.json) is charged with that turn's pass/fail.  
> Sorted worst first. J = judgement skill (asking back is acceptable; read safe% = (pass+asked)/need).

**a1**: sessions 15/90 (16.7%), turns 44/184 (23.9%), sessions safe (no wrong turn) 25/90

| skill | group | J | need | pass | acc% | asked | wrong | safe% |
| --- | --: | --: | --: | --: | --: | --: | --: | --: |
| route.media | route |  | 10 | 0 | 0.0 | 1 | 9 | 10.0 |
| follow.back_to | follow |  | 7 | 0 | 0.0 | 1 | 6 | 14.3 |
| handle.them | handle |  | 7 | 0 | 0.0 | 1 | 6 | 14.3 |
| follow.except | follow |  | 5 | 0 | 0.0 | 0 | 5 | 0.0 |
| write.settle | write |  | 5 | 0 | 0.0 | 0 | 5 | 0.0 |
| compose.bulk | compose |  | 4 | 0 | 0.0 | 1 | 3 | 25.0 |
| copy.number | copy |  | 4 | 0 | 0.0 | 0 | 4 | 0.0 |
| follow.swap_subject | follow |  | 4 | 0 | 0.0 | 0 | 4 | 0.0 |
| num.value_of | num |  | 4 | 0 | 0.0 | 2 | 2 | 50.0 |
| write.restore | write |  | 4 | 0 | 0.0 | 3 | 1 | 75.0 |
| filter.numeric | filter |  | 3 | 0 | 0.0 | 0 | 3 | 0.0 |
| time.derived | time |  | 3 | 0 | 0.0 | 1 | 2 | 33.3 |
| time.order | time |  | 3 | 0 | 0.0 | 0 | 3 | 0.0 |
| compose.correction | compose |  | 2 | 0 | 0.0 | 1 | 1 | 50.0 |
| compose.undo | compose |  | 2 | 0 | 0.0 | 1 | 1 | 50.0 |
| judge.refuse_guard | judge |  | 2 | 0 | 0.0 | 0 | 2 | 0.0 |
| num.balance | num |  | 2 | 0 | 0.0 | 1 | 1 | 50.0 |
| num.count | num |  | 2 | 0 | 0.0 | 2 | 0 | 100.0 |
| write.album_add | write |  | 2 | 0 | 0.0 | 1 | 1 | 50.0 |
| compose.then | compose |  | 1 | 0 | 0.0 | 1 | 0 | 100.0 |
| link.subtasks | link |  | 1 | 0 | 0.0 | 0 | 1 | 0.0 |
| num.dtstart_of | num | J | 1 | 0 | 0.0 | 0 | 1 | 0.0 |
| time.shift | time |  | 1 | 0 | 0.0 | 0 | 1 | 0.0 |
| follow.switch_kind | follow |  | 14 | 1 | 7.1 | 2 | 11 | 21.4 |
| link.media | link |  | 16 | 2 | 12.5 | 1 | 13 | 18.8 |
| follow.narrow | follow |  | 8 | 1 | 12.5 | 1 | 6 | 25.0 |
| handle.pick | handle |  | 31 | 4 | 12.9 | 7 | 20 | 35.5 |
| write.reschedule | write |  | 7 | 1 | 14.3 | 3 | 3 | 57.1 |
| route.library | route |  | 20 | 3 | 15.0 | 0 | 17 | 15.0 |
| handle.far | handle |  | 12 | 2 | 16.7 | 2 | 8 | 33.3 |
| time.field | time |  | 6 | 1 | 16.7 | 0 | 5 | 16.7 |
| filter.open | filter |  | 5 | 1 | 20.0 | 0 | 4 | 20.0 |
| route.everything | route |  | 5 | 1 | 20.0 | 1 | 3 | 40.0 |
| write.trash | write |  | 5 | 1 | 20.0 | 0 | 4 | 20.0 |
| copy.anchor | copy |  | 46 | 10 | 21.7 | 5 | 31 | 32.6 |
| compose.lookup_write | compose |  | 8 | 2 | 25.0 | 2 | 4 | 50.0 |
| route.locker | route |  | 8 | 2 | 25.0 | 3 | 3 | 62.5 |
| handle.ordinal | handle |  | 4 | 1 | 25.0 | 1 | 2 | 50.0 |
| write.add_task | write |  | 4 | 1 | 25.0 | 0 | 3 | 25.0 |
| write.log_interaction | write |  | 4 | 1 | 25.0 | 0 | 3 | 25.0 |
| copy.name | copy |  | 28 | 8 | 28.6 | 4 | 16 | 42.9 |
| filter.field | filter |  | 16 | 5 | 31.2 | 2 | 9 | 43.8 |
| route.schedule | route |  | 25 | 8 | 32.0 | 1 | 16 | 36.0 |
| route.money | route |  | 12 | 4 | 33.3 | 3 | 5 | 58.3 |
| copy.date | copy |  | 9 | 3 | 33.3 | 3 | 3 | 66.7 |
| link.of_group | link |  | 6 | 2 | 33.3 | 1 | 3 | 50.0 |
| route.day | route |  | 6 | 2 | 33.3 | 0 | 4 | 33.3 |
| filter.trashed | filter |  | 3 | 1 | 33.3 | 0 | 2 | 33.3 |
| judge.no_link | judge | J | 3 | 1 | 33.3 | 0 | 2 | 33.3 |
| judge.refuse_outside | judge |  | 3 | 1 | 33.3 | 1 | 1 | 66.7 |
| write.mark | write |  | 3 | 1 | 33.3 | 0 | 2 | 33.3 |
| write.reveal | write |  | 3 | 1 | 33.3 | 0 | 2 | 33.3 |
| time.window | time |  | 20 | 7 | 35.0 | 1 | 12 | 40.0 |
| copy.title | copy |  | 8 | 3 | 37.5 | 0 | 5 | 37.5 |
| link.parties_of | link |  | 8 | 3 | 37.5 | 2 | 3 | 62.5 |
| judge.ambiguous | judge | J | 5 | 2 | 40.0 | 0 | 3 | 40.0 |
| num.sum | num |  | 7 | 3 | 42.9 | 1 | 3 | 57.1 |
| route.people | route |  | 9 | 4 | 44.4 | 2 | 3 | 66.7 |
| judge.nothing_there | judge |  | 4 | 2 | 50.0 | 0 | 2 | 50.0 |
| write.note | write |  | 2 | 1 | 50.0 | 0 | 1 | 50.0 |
| write.tally | write |  | 2 | 1 | 50.0 | 0 | 1 | 50.0 |
| link.of_person | link |  | 9 | 5 | 55.6 | 2 | 2 | 77.8 |
| num.owed | num |  | 4 | 3 | 75.0 | 0 | 1 | 75.0 |
| judge.never_mind | judge |  | 3 | 3 | 100.0 | 0 | 0 | 100.0 |
| write.event | write |  | 1 | 1 | 100.0 | 0 | 0 | 100.0 |

**Per group** (distinct turns needing any skill of the group; a turn counts once per group)

| group   | skills | turns | a1 pass | a1 acc% |
| ------- | -----: | ----: | ------: | ------: |
| copy    |      5 |    90 |      22 |    24.4 |
| route   |      8 |    95 |      24 |    25.3 |
| filter  |      4 |    26 |       7 |    26.9 |
| link    |      5 |    40 |      12 |    30.0 |
| time    |      5 |    27 |       7 |    25.9 |
| num     |      6 |    20 |       6 |    30.0 |
| follow  |      5 |    38 |       2 |     5.3 |
| handle  |      4 |    54 |       7 |    13.0 |
| write   |     12 |    42 |       9 |    21.4 |
| compose |      5 |    15 |       2 |    13.3 |
| judge   |      6 |    20 |       9 |    45.0 |

## sonnet-r8

> Coarse attribution: every skill a turn needs (v8/dev_skills.json) is charged with that turn's pass/fail.  
> Sorted worst first. J = judgement skill (asking back is acceptable; read safe% = (pass+asked)/need).

**sonnet-r8**: sessions 85/90 (94.4%), turns 178/184 (96.7%), sessions safe (no wrong turn) 85/90

| skill | group | J | need | pass | acc% | asked | wrong | safe% |
| --- | --: | --: | --: | --: | --: | --: | --: | --: |
| judge.no_link | judge | J | 3 | 2 | 66.7 | 0 | 1 | 66.7 |
| time.derived | time |  | 3 | 2 | 66.7 | 0 | 1 | 66.7 |
| route.locker | route |  | 8 | 6 | 75.0 | 0 | 2 | 75.0 |
| write.add_task | write |  | 4 | 3 | 75.0 | 0 | 1 | 75.0 |
| follow.except | follow |  | 5 | 4 | 80.0 | 0 | 1 | 80.0 |
| judge.ambiguous | judge | J | 5 | 4 | 80.0 | 1 | 0 | 100.0 |
| copy.title | copy |  | 8 | 7 | 87.5 | 0 | 1 | 87.5 |
| link.parties_of | link |  | 8 | 7 | 87.5 | 0 | 1 | 87.5 |
| copy.date | copy |  | 9 | 8 | 88.9 | 0 | 1 | 88.9 |
| route.people | route |  | 9 | 8 | 88.9 | 0 | 1 | 88.9 |
| route.media | route |  | 10 | 9 | 90.0 | 0 | 1 | 90.0 |
| handle.far | handle |  | 12 | 11 | 91.7 | 0 | 1 | 91.7 |
| follow.switch_kind | follow |  | 14 | 13 | 92.9 | 0 | 1 | 92.9 |
| time.window | time |  | 20 | 19 | 95.0 | 0 | 1 | 95.0 |
| handle.pick | handle |  | 31 | 30 | 96.8 | 1 | 0 | 100.0 |
| copy.anchor | copy |  | 46 | 45 | 97.8 | 0 | 1 | 97.8 |
| copy.name | copy |  | 28 | 28 | 100.0 | 0 | 0 | 100.0 |
| route.schedule | route |  | 25 | 25 | 100.0 | 0 | 0 | 100.0 |
| route.library | route |  | 20 | 20 | 100.0 | 0 | 0 | 100.0 |
| filter.field | filter |  | 16 | 16 | 100.0 | 0 | 0 | 100.0 |
| link.media | link |  | 16 | 16 | 100.0 | 0 | 0 | 100.0 |
| route.money | route |  | 12 | 12 | 100.0 | 0 | 0 | 100.0 |
| link.of_person | link |  | 9 | 9 | 100.0 | 0 | 0 | 100.0 |
| compose.lookup_write | compose |  | 8 | 8 | 100.0 | 0 | 0 | 100.0 |
| follow.narrow | follow |  | 8 | 8 | 100.0 | 0 | 0 | 100.0 |
| follow.back_to | follow |  | 7 | 7 | 100.0 | 0 | 0 | 100.0 |
| handle.them | handle |  | 7 | 7 | 100.0 | 0 | 0 | 100.0 |
| num.sum | num |  | 7 | 7 | 100.0 | 0 | 0 | 100.0 |
| write.reschedule | write |  | 7 | 7 | 100.0 | 0 | 0 | 100.0 |
| link.of_group | link |  | 6 | 6 | 100.0 | 0 | 0 | 100.0 |
| route.day | route |  | 6 | 6 | 100.0 | 0 | 0 | 100.0 |
| time.field | time |  | 6 | 6 | 100.0 | 0 | 0 | 100.0 |
| filter.open | filter |  | 5 | 5 | 100.0 | 0 | 0 | 100.0 |
| route.everything | route |  | 5 | 5 | 100.0 | 0 | 0 | 100.0 |
| write.settle | write |  | 5 | 5 | 100.0 | 0 | 0 | 100.0 |
| write.trash | write |  | 5 | 5 | 100.0 | 0 | 0 | 100.0 |
| compose.bulk | compose |  | 4 | 4 | 100.0 | 0 | 0 | 100.0 |
| copy.number | copy |  | 4 | 4 | 100.0 | 0 | 0 | 100.0 |
| follow.swap_subject | follow |  | 4 | 4 | 100.0 | 0 | 0 | 100.0 |
| handle.ordinal | handle |  | 4 | 4 | 100.0 | 0 | 0 | 100.0 |
| judge.nothing_there | judge |  | 4 | 4 | 100.0 | 0 | 0 | 100.0 |
| num.owed | num |  | 4 | 4 | 100.0 | 0 | 0 | 100.0 |
| num.value_of | num |  | 4 | 4 | 100.0 | 0 | 0 | 100.0 |
| write.log_interaction | write |  | 4 | 4 | 100.0 | 0 | 0 | 100.0 |
| write.restore | write |  | 4 | 4 | 100.0 | 0 | 0 | 100.0 |
| filter.numeric | filter |  | 3 | 3 | 100.0 | 0 | 0 | 100.0 |
| filter.trashed | filter |  | 3 | 3 | 100.0 | 0 | 0 | 100.0 |
| judge.never_mind | judge |  | 3 | 3 | 100.0 | 0 | 0 | 100.0 |
| judge.refuse_outside | judge |  | 3 | 3 | 100.0 | 0 | 0 | 100.0 |
| time.order | time |  | 3 | 3 | 100.0 | 0 | 0 | 100.0 |
| write.mark | write |  | 3 | 3 | 100.0 | 0 | 0 | 100.0 |
| write.reveal | write |  | 3 | 3 | 100.0 | 0 | 0 | 100.0 |
| compose.correction | compose |  | 2 | 2 | 100.0 | 0 | 0 | 100.0 |
| compose.undo | compose |  | 2 | 2 | 100.0 | 0 | 0 | 100.0 |
| judge.refuse_guard | judge |  | 2 | 2 | 100.0 | 0 | 0 | 100.0 |
| num.balance | num |  | 2 | 2 | 100.0 | 0 | 0 | 100.0 |
| num.count | num |  | 2 | 2 | 100.0 | 0 | 0 | 100.0 |
| write.album_add | write |  | 2 | 2 | 100.0 | 0 | 0 | 100.0 |
| write.note | write |  | 2 | 2 | 100.0 | 0 | 0 | 100.0 |
| write.tally | write |  | 2 | 2 | 100.0 | 0 | 0 | 100.0 |
| compose.then | compose |  | 1 | 1 | 100.0 | 0 | 0 | 100.0 |
| link.subtasks | link |  | 1 | 1 | 100.0 | 0 | 0 | 100.0 |
| num.dtstart_of | num | J | 1 | 1 | 100.0 | 0 | 0 | 100.0 |
| time.shift | time |  | 1 | 1 | 100.0 | 0 | 0 | 100.0 |
| write.event | write |  | 1 | 1 | 100.0 | 0 | 0 | 100.0 |

**Per group** (distinct turns needing any skill of the group; a turn counts once per group)

| group   | skills | turns | sonnet-r8 pass | sonnet-r8 acc% |
| ------- | -----: | ----: | -------------: | -------------: |
| copy    |      5 |    90 |             88 |           97.8 |
| route   |      8 |    95 |             91 |           95.8 |
| filter  |      4 |    26 |             26 |          100.0 |
| link    |      5 |    40 |             39 |           97.5 |
| time    |      5 |    27 |             25 |           92.6 |
| num     |      6 |    20 |             20 |          100.0 |
| follow  |      5 |    38 |             36 |           94.7 |
| handle  |      4 |    54 |             52 |           96.3 |
| write   |     12 |    42 |             41 |           97.6 |
| compose |      5 |    15 |             15 |          100.0 |
| judge   |      6 |    20 |             18 |           90.0 |

## a1 vs sonnet-r8

> Coarse attribution: every skill a turn needs (v8/dev_skills.json) is charged with that turn's pass/fail.  
> Sorted worst first. J = judgement skill (asking back is acceptable; read safe% = (pass+asked)/need).

**a1**: sessions 15/90 (16.7%), turns 44/184 (23.9%), sessions safe (no wrong turn) 25/90

**sonnet**: sessions 85/90 (94.4%), turns 178/184 (96.7%), sessions safe (no wrong turn) 85/90

| skill | group | J | need | a1 acc% | sonnet acc% | delta | a1 asked/wrong | sonnet asked/wrong |
| --- | --: | --: | --: | --: | --: | --: | --: | --: |
| route.media | route |  | 10 | 0.0 | 90.0 | +90.0 | 1/9 | 0/1 |
| follow.back_to | follow |  | 7 | 0.0 | 100.0 | +100.0 | 1/6 | 0/0 |
| handle.them | handle |  | 7 | 0.0 | 100.0 | +100.0 | 1/6 | 0/0 |
| follow.except | follow |  | 5 | 0.0 | 80.0 | +80.0 | 0/5 | 0/1 |
| write.settle | write |  | 5 | 0.0 | 100.0 | +100.0 | 0/5 | 0/0 |
| compose.bulk | compose |  | 4 | 0.0 | 100.0 | +100.0 | 1/3 | 0/0 |
| copy.number | copy |  | 4 | 0.0 | 100.0 | +100.0 | 0/4 | 0/0 |
| follow.swap_subject | follow |  | 4 | 0.0 | 100.0 | +100.0 | 0/4 | 0/0 |
| num.value_of | num |  | 4 | 0.0 | 100.0 | +100.0 | 2/2 | 0/0 |
| write.restore | write |  | 4 | 0.0 | 100.0 | +100.0 | 3/1 | 0/0 |
| filter.numeric | filter |  | 3 | 0.0 | 100.0 | +100.0 | 0/3 | 0/0 |
| time.derived | time |  | 3 | 0.0 | 66.7 | +66.7 | 1/2 | 0/1 |
| time.order | time |  | 3 | 0.0 | 100.0 | +100.0 | 0/3 | 0/0 |
| compose.correction | compose |  | 2 | 0.0 | 100.0 | +100.0 | 1/1 | 0/0 |
| compose.undo | compose |  | 2 | 0.0 | 100.0 | +100.0 | 1/1 | 0/0 |
| judge.refuse_guard | judge |  | 2 | 0.0 | 100.0 | +100.0 | 0/2 | 0/0 |
| num.balance | num |  | 2 | 0.0 | 100.0 | +100.0 | 1/1 | 0/0 |
| num.count | num |  | 2 | 0.0 | 100.0 | +100.0 | 2/0 | 0/0 |
| write.album_add | write |  | 2 | 0.0 | 100.0 | +100.0 | 1/1 | 0/0 |
| compose.then | compose |  | 1 | 0.0 | 100.0 | +100.0 | 1/0 | 0/0 |
| link.subtasks | link |  | 1 | 0.0 | 100.0 | +100.0 | 0/1 | 0/0 |
| num.dtstart_of | num | J | 1 | 0.0 | 100.0 | +100.0 | 0/1 | 0/0 |
| time.shift | time |  | 1 | 0.0 | 100.0 | +100.0 | 0/1 | 0/0 |
| follow.switch_kind | follow |  | 14 | 7.1 | 92.9 | +85.7 | 2/11 | 0/1 |
| link.media | link |  | 16 | 12.5 | 100.0 | +87.5 | 1/13 | 0/0 |
| follow.narrow | follow |  | 8 | 12.5 | 100.0 | +87.5 | 1/6 | 0/0 |
| handle.pick | handle |  | 31 | 12.9 | 96.8 | +83.9 | 7/20 | 1/0 |
| write.reschedule | write |  | 7 | 14.3 | 100.0 | +85.7 | 3/3 | 0/0 |
| route.library | route |  | 20 | 15.0 | 100.0 | +85.0 | 0/17 | 0/0 |
| handle.far | handle |  | 12 | 16.7 | 91.7 | +75.0 | 2/8 | 0/1 |
| time.field | time |  | 6 | 16.7 | 100.0 | +83.3 | 0/5 | 0/0 |
| filter.open | filter |  | 5 | 20.0 | 100.0 | +80.0 | 0/4 | 0/0 |
| route.everything | route |  | 5 | 20.0 | 100.0 | +80.0 | 1/3 | 0/0 |
| write.trash | write |  | 5 | 20.0 | 100.0 | +80.0 | 0/4 | 0/0 |
| copy.anchor | copy |  | 46 | 21.7 | 97.8 | +76.1 | 5/31 | 0/1 |
| compose.lookup_write | compose |  | 8 | 25.0 | 100.0 | +75.0 | 2/4 | 0/0 |
| route.locker | route |  | 8 | 25.0 | 75.0 | +50.0 | 3/3 | 0/2 |
| handle.ordinal | handle |  | 4 | 25.0 | 100.0 | +75.0 | 1/2 | 0/0 |
| write.add_task | write |  | 4 | 25.0 | 75.0 | +50.0 | 0/3 | 0/1 |
| write.log_interaction | write |  | 4 | 25.0 | 100.0 | +75.0 | 0/3 | 0/0 |
| copy.name | copy |  | 28 | 28.6 | 100.0 | +71.4 | 4/16 | 0/0 |
| filter.field | filter |  | 16 | 31.2 | 100.0 | +68.8 | 2/9 | 0/0 |
| route.schedule | route |  | 25 | 32.0 | 100.0 | +68.0 | 1/16 | 0/0 |
| route.money | route |  | 12 | 33.3 | 100.0 | +66.7 | 3/5 | 0/0 |
| copy.date | copy |  | 9 | 33.3 | 88.9 | +55.6 | 3/3 | 0/1 |
| link.of_group | link |  | 6 | 33.3 | 100.0 | +66.7 | 1/3 | 0/0 |
| route.day | route |  | 6 | 33.3 | 100.0 | +66.7 | 0/4 | 0/0 |
| filter.trashed | filter |  | 3 | 33.3 | 100.0 | +66.7 | 0/2 | 0/0 |
| judge.no_link | judge | J | 3 | 33.3 | 66.7 | +33.3 | 0/2 | 0/1 |
| judge.refuse_outside | judge |  | 3 | 33.3 | 100.0 | +66.7 | 1/1 | 0/0 |
| write.mark | write |  | 3 | 33.3 | 100.0 | +66.7 | 0/2 | 0/0 |
| write.reveal | write |  | 3 | 33.3 | 100.0 | +66.7 | 0/2 | 0/0 |
| time.window | time |  | 20 | 35.0 | 95.0 | +60.0 | 1/12 | 0/1 |
| copy.title | copy |  | 8 | 37.5 | 87.5 | +50.0 | 0/5 | 0/1 |
| link.parties_of | link |  | 8 | 37.5 | 87.5 | +50.0 | 2/3 | 0/1 |
| judge.ambiguous | judge | J | 5 | 40.0 | 80.0 | +40.0 | 0/3 | 1/0 |
| num.sum | num |  | 7 | 42.9 | 100.0 | +57.1 | 1/3 | 0/0 |
| route.people | route |  | 9 | 44.4 | 88.9 | +44.4 | 2/3 | 0/1 |
| judge.nothing_there | judge |  | 4 | 50.0 | 100.0 | +50.0 | 0/2 | 0/0 |
| write.note | write |  | 2 | 50.0 | 100.0 | +50.0 | 0/1 | 0/0 |
| write.tally | write |  | 2 | 50.0 | 100.0 | +50.0 | 0/1 | 0/0 |
| link.of_person | link |  | 9 | 55.6 | 100.0 | +44.4 | 2/2 | 0/0 |
| num.owed | num |  | 4 | 75.0 | 100.0 | +25.0 | 0/1 | 0/0 |
| judge.never_mind | judge |  | 3 | 100.0 | 100.0 | +0.0 | 0/0 | 0/0 |
| write.event | write |  | 1 | 100.0 | 100.0 | +0.0 | 0/0 | 0/0 |

**Per group** (distinct turns needing any skill of the group; a turn counts once per group)

| group | skills | turns | a1 pass | a1 acc% | sonnet pass | sonnet acc% | delta |
| --- | --: | --: | --: | --: | --: | --: | --: |
| copy | 5 | 90 | 22 | 24.4 | 88 | 97.8 | +73.3 |
| route | 8 | 95 | 24 | 25.3 | 91 | 95.8 | +70.5 |
| filter | 4 | 26 | 7 | 26.9 | 26 | 100.0 | +73.1 |
| link | 5 | 40 | 12 | 30.0 | 39 | 97.5 | +67.5 |
| time | 5 | 27 | 7 | 25.9 | 25 | 92.6 | +66.7 |
| num | 6 | 20 | 6 | 30.0 | 20 | 100.0 | +70.0 |
| follow | 5 | 38 | 2 | 5.3 | 36 | 94.7 | +89.5 |
| handle | 4 | 54 | 7 | 13.0 | 52 | 96.3 | +83.3 |
| write | 12 | 42 | 9 | 21.4 | 41 | 97.6 | +76.2 |
| compose | 5 | 15 | 2 | 13.3 | 15 | 100.0 | +86.7 |
| judge | 6 | 20 | 9 | 45.0 | 18 | 90.0 | +45.0 |
