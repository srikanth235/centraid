# G3 brief: ten more sessions per world, thin cells and one runtime feature

Read `authored/BRIEF.md` first; every rule there holds (hard rules, gold conventions, runtime rules, no `think` text, the realism spec). `authored/GAPBRIEF.md` is the previous wave (ids 101-130); its session files `authored/sessions/<W>_g1.py` are the pattern for syntax. This wave adds **ten sessions per train world**, ids `<W>-131` to `<W>-140`, in **one file `authored/sessions/<W>_g3.py`** (it starts with `from gold import *` and the same `world(...)` line as `<W>_g1.py`; copy it). Sessions `<W>-001` to `<W>-130` stay untouched; never touch a val world (T03, T12, T23), and never edit a world file (rebuilding it is part of the verify command).

## Goal

The corpus already holds hundreds of hard instances of the failing tags (dates, cancel, reschedule, balance, multi-write, long messages). More of the same is wasted. Only thin cells need sessions, plus one runtime feature the corpus never shows (the model repeating a call and the runtime answering with a hint). Write these and only these; every turn is a request a person would make in that household.

## Your quota (per world, the numbers in `authored/quota.json`)

| Cell | Tag it produces | New uses per world (at least) | Hard share of them (at least) |
| --- | --- | --- | --- |
| limit | `limit:present`: an `order` and/or `limit` arg on `answer`/`find` ("my three biggest debts", "next event", "latest note") | 8 | any |
| typo | `typo:present`: a real misspelling in the message, as a phone types it ("recieve", "tommorow", "wensday"); overlay on other turns | 9 | any |
| min | `value:min`: `answer`/`compute op=min` | 7 | 55% |
| max | `value:max` | 7 | 55% |
| sum | `value:sum` | 6 | 50% |
| never_mind | `decline:never_mind`: the person backs out after an ask or a proposed change | 4 | 60% |
| unbounded | `decline:unbounded_destruction`: "delete everything", "wipe all my X", "clear out the vault" | 4 | 50% |
| recovery | sessions with a repeated call and the runtime hint, then a fix (below) | 2 sessions | n/a |

A **hard** turn (same definition as `gapreport.py`): two or more rows fit the message, or it has 12+ words, or it takes three or more calls, or it shares no whole word with the row it acts on. Make the hard ones honestly hard (a long message with context, a name that fits two rows, "the cheapest of those" after a list, min and max asked in one message so the reference makes two `compute` calls and an `answer`). A turn may hit several cells at once (a limited find with a typo, min and max in one message); prefer that to filler turns.

Suggested skeleton (`authored/quota.json` `session_plan`; it overshoots the minimums, adapt it to your world's rows and vary the situations; `L` limit, `T` typo, `MN`/`MX`/`SM` min/max/sum, `NM` never_mind, `UD` unbounded, `R`/`R2` recovery with one/two repeats; turns separated by `/`):

| Id | Shape | Turn cells |
| --- | --- | --- |
| 131 | recovery: find with order/limit, bad repeat, answer; then min+max; then sum | L+R / MN+MX / SM+T |
| 132 | recovery twice (hint then nudge), changed call; then sum; then min+max | L+R2 / SM+T / MN+MX |
| 133 | min+max together, sum, never mind | MN+MX+T / SM / NM |
| 134 | min+max together, sum, limit | MN+MX / SM+T / L |
| 135 | sum, max, min+max, limit | SM / MX+T / MN+MX / L+T |
| 136 | never mind, limit, never mind | NM / L+T / NM+T |
| 137 | unbounded destruction, never mind, unbounded destruction | UD+T / NM / UD |
| 138 | limit, unbounded destruction, min+max | L+T / UD / MN+MX+T |
| 139 | limit, limit, sum+min, never mind | L / L+T / SM+MN / NM+T |
| 140 | limit, unbounded destruction, never mind, sum+max | L+T / UD+T / NM / SM+MX+T |

## Recovery sessions (the runtime hint)

The runtime does not re-run an identical call sent right after itself. It answers the first repeat with `error: repeated call. You already made this exact call and it returned: <what it returned> Answer from that result, or change the call.` and a second consecutive repeat with `error: repeated call again. Do not send it a third time: change a parameter the reply above points to, use another tool, or answer or decline with what you have.` (a third ends the turn as a loop; never write that). Only a call that does not end the turn can be repeated: `find`, `search`, `open`, `compute`, or an already-so write.

Write it with the repo's `bad(call)` form, so the repeat carries no loss and the model trains only on the call that fixes it: the first call normal, the identical call again wrapped in `bad(...)` (once for the hint, twice for hint then nudge), then a changed call or an `ans`/`ask`/`decline`:

    T("any swimming lesson up to saturday", rows("swim_0221", "swim_0228", "swim_0307", "swim_0314"),
      ref=[find(kind="event", name="swimming lesson", when=WK),
           bad(find(kind="event", name="swimming lesson", when=WK)),
           ans(within="@prev")])

The bad call must be argument-for-argument identical to the one before it (build a variable and reuse it). The runtime writes the hint text itself; you write no hint. `build.py` checks that every `bad` call is in fact rejected and derives the retry's `<think>` line. Pick a first call whose result already answers the question (so answering from it is right), or where a small model would plausibly resend it instead of narrowing (an empty or long result). The counter is `quota_check.py`: it counts a turn whose replay shows `error: repeated call` followed by an accepted call.

## Vocabulary and conventions

Users say **delete**, not trash, for the action; "trash" is only the place ("what's in the trash", "restore it from the trash"). The SPEC 14.1 conventions apply to every message and gold (wifi, diary, balance sign, weeks and weekends, next and bare weekday, at N, last month name); `python3 authored/audit.py` checks them. Runtime vocabulary is conversation, turn, item. Never-mind turns: the reference is `dec("never_mind")` after an ask or proposed change (an `undo` only when the request already changed something). Unbounded destruction: `dec("unbounded_destruction")` with no bound in the message; a bounded delete ("delete the three cancelled events") is an ordinary write, not this cell.

## World groups

| Group | Worlds                  |
| ----- | ----------------------- |
| g1    | T01, T02, T04, T05, T06 |
| g2    | T07, T08, T09, T10, T11 |
| g3    | T13, T14, T15, T16, T17 |
| g4    | T18, T19, T20, T21, T22 |
| g5    | T24, T25, T26, T27, T28 |

Each author takes one world (five authors per group run in parallel, one file each). Output `authored/sessions/<W>_g3.py`, ids `<W>-131` to `<W>-140`. Do not repeat the situations of `<W>.py`, its part files, `<W>_g1.py` or `<W>_g2.py`; read them first. Sessions are 2-4 turns (about 33 turns in all).

## Verify (loop until every session passes and the quota check is clean)

    PY=/tmp/claude-0/-home-user-centraid/f31227f9-ca10-5f19-9c12-db2b239388c1/scratchpad/ft/bin/python
    cd experiments/toolchat/native
    python3 authored/worlds/<W>_build.py
    HF_HUB_OFFLINE=1 $PY authored/build.py <W> --out /tmp/authored-<W>
    python3 authored/quota_check.py --mine <W>
    python3 authored/coverage.py /tmp/authored-<W>/<W>.gold.jsonl --assign 28 --world <index> --md /tmp/authored-<W>/coverage.md

`build.py` replays all 140 sessions of the world (old and new); every one must verify (`--only <W>-131` reruns one; `authored/show.py <W> <W>-131` prints what the model sees; `/tmp/authored-<W>/<W>.report.json` lists problems). `quota_check.py --mine <W>` must print `LOW CELLS 0`. The overlap list in coverage.md stays empty. A session the runtime cannot serve correctly is removed and reported, never forced.

## Prohibitions

Do not open `eval/` (sets, sessions, worlds json, keys, run.py outputs), any `runs/` or `out/` directory, `data/`, or any path under `/tmp/claude-0/` other than the `PY` interpreter (running it is fine) and the task files you were given. Keep scratch files in `/tmp/authored-<W>-work/`. Do not read val worlds (T03, T12, T23) for phrasing. Do not edit shared code, `quota.json`, or another world's files. Do not commit or push.

## Report back

Sessions verified, `quota_check.py --mine` output, the recovery sessions written (id), any runtime or tooling issue (session and message), anything in this brief that got in your way.
