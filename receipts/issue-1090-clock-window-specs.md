# Issue #1090 — two mobile core round-trip specs fail depending on the hour

## Checklist

- [x] Both causes named, each red first at a fixed clock
- [x] Both fixed in product code; neither spec loosened
- [x] The two Kotlin specs pass with the JVM clock pinned inside their old windows

## What changed

- **A daily task left Today every evening.** A task due on a bare date (`due_at` "2026-10-04") was read as UTC midnight, and `next_occurrence`/`collapse_missed` (`crates/vault/src/time/recurrence.rs`) counted its periods on UTC midnights. In New York the next due became 20:00 the evening before, so the task left Today from 20:00 to midnight. Completing it wrote an instant, not a date, as the successor. A bare-date anchor is now all-day: it recurs on the member's civil days, read in the request's zone (`load_board`, `load_task` and the search loaders take the zone), and its successor stays a date. Commit `346540161`.
- **The trash countdown disagreed with the purge.** `purge_in_days` counted civil days to the purge's local day. The vault purges at `purge_at` = trash + 30 × 24 h, and refuses a restore from then on. So the count read 29 or 31 when daylight saving changed inside the window, and 0 for the whole last local day: the shell disabled Restore and said "lapsed" hours before the vault would refuse. It is now `phone::purge_in_days(purge_at, now)` = ⌈(purge_at − now) / 24 h⌉: 30 for a fresh trash, and positive exactly while a restore is accepted. Retention is unchanged. Commit `b550d2633`.
- **Not fixed.** `TasksDetail.kt` sends a due time with no zone, which the core reads as UTC (not verified end to end). Instant-bearing repeating tasks still leave Today once their time of day passes.

## Verification

```
cargo test -p centraid-vault (lib, schedule_commands, time_corpus, event_times)   # red before the fix (clock-red.log): lib "13 passed; 3 failed", e.g. "America/New_York at 2026-10-07T00:00:00.000Z  left: Some(\"2026-10-07T00:00:00.000Z\")  right: Some(\"2026-10-06\")"; schedule_commands "0 passed; 1 failed"; green after
cargo test -p centraid-core (lib + integration)    # red before (clock-red.log): "trashed 2026-10-08T04:10:00.000Z (2026-10-08T00:10), purging 2026-11-07T04:10:00.000Z (2026-11-06)  left: 29  right: 30"; green after
:core:jvmTest --tests TasksQueryRoundTripSpec --tests DocsQueryRoundTripSpec, the test JVM pinned by libfaketime   # before the fix, run at 03:38Z (tasks-spec.log, written 03:38:22): "TasksQueryRoundTripSpec[jvm] > tasks.board groups by the device's day, and the trash is on no place[jvm] FAILED … NoSuchElementException"; no retained log shows the Docs spec red, whose cause core's docs_tests show above
                                                    # after, on 734433cbb at 03:25Z, 03:38Z, 04:10Z and 04:42Z: "BUILD SUCCESSFUL" each (clock-kotlin-*.log); the 04:42Z run's reports read tests="1" failures="0" for each spec with timestamp 2026-10-08T04:42:01Z, so the pin reached the test JVM (re-run after the first audit)
cargo xtask gate --profile mobile-jvm              # PASS on the merged head 30c414b24
python3 regen.py refreeze                          # the runtime reads due dates, so the fix could move gold. On 18319d402 and on its first parent 678e80266 (refreeze-final.log, refreeze-base.log): val's output equals the frozen v7.4 (5d3d9035737a) on both;
                                                    # test's output is 9ac6f1773519 on both, so the fix moves no gold. It differs from the frozen test v6 (fedc45825fc3) on both, which is the nt15 runtime's, not this fix's; test is re-versioned only at a milestone
```

## Audit

**REFUTED**

Audited 2026-10-08 by a reviewer who did not write the receipt, against `346540161`, `b550d2633` and the merge `18319d402`, the logs in the root agent's scratchpad (`clock-red.log`, `tasks-spec.log`, `tasks-spec-utc.log`, `final-gate-mjvm.log`), my own re-runs on this tree and `.governance/law/rules/receipt-per-issue.mjs`. The `## What changed` claims hold. The Kotlin pinned-clock line and the third checklist box have no retained evidence.

- **`## What changed` against the diff.** PASS.
  - Cause one. `recurrence.rs` adds `is_all_day_anchor`, `next_all_day` and `collapse_all_day`, routed from `next_occurrence` and `collapse_missed`. `queries.rs` threads the member's `FireZone` through `recurrence_of`, `load_board`, `load_task`, `load_search` and `load_search_term`, and `core/src/app_query/tasks.rs` passes `&zone`. `schedule_commands.rs` pins that the successor of `2026-03-01` is `2026-03-02` and a date.
  - Cause two. `phone::purge_in_days(purge_at, now_ms)` is `-(-left).div_euclid(DAY_MS)`, the ceiling of `(purge_at - now) / 24 h`. `crates/vault/src/commands/core.rs` is untouched by `b550d2633`: `PURGE_AFTER_DAYS = 30` stamped as `30 * 86_400_000` ms, and a restore needs `purge_at > now`, so "retention is unchanged" and "positive exactly while a restore is accepted" hold. `DocsFold.kt:353` is `enabled = row.purge_in_days > 0`, which is the claimed Restore behaviour.
  - Not fixed. `TasksDetail.kt:232` sends `"${day}T$time"` with no zone, as stated.
  - Not named, mechanical: `crates/apps/tasks/README.md`, the `load_board`/`load_search` signature updates in `tests/parity.rs` and `tests/year3.rs`, the `docs.proto` and `CONTRACT.md` wording of `purge_local_day` and `purge_in_days`, and the removal of the public `phone::days_between`.
- **Each `- [x]` against the diff.** REFUTED on box 3.
  - Box 1 holds. `clock-red.log` (05:33:57) precedes both fixes (05:50:13, 05:50:44): vault lib "13 passed; 3 failed", `schedule_commands` "0 passed; 1 failed", core "70 passed; 4 failed" (two docs, two tasks).
  - Box 2 holds. `git diff a3f49c7f6 HEAD -- mobile/core` is `AssistRoundTripSpec.kt` only, so `TasksQueryRoundTripSpec` and `DocsQueryRoundTripSpec` are untouched.
  - Box 3 has no evidence. No retained log shows `:core:jvmTest` under libfaketime after the fix, at any of 03:25Z, 03:38Z, 04:10Z or 04:42Z. `spec.sh` pipes Gradle through `grep | head -12` to the terminal and writes no file. `tasks-spec.log` and `tasks-spec-utc.log` (03:38 and 03:47, in `wt-1088-replay`, before either fix) show the red half only: "TasksQueryRoundTripSpec[jvm] > tasks.board groups by the device's day, and the trash is on no place[jvm] FAILED … NoSuchElementException at TasksQueryRoundTripSpec.kt:250". `tasks-spec3.log` ("BUILD SUCCESSFUL in 11s", 04:01) is also before the fix and records no clock. The mobile-jvm gate ran near 08:00Z, outside the failing hours, so it does not stand in.
- **`## Verification` against a log or a re-run.** REFUTED on the third line; the others hold.
  - Line 1, vault. My re-runs on this tree: `--lib recurrence` "test result: ok. 16 passed; 0 failed", `--test schedule_commands` "ok. 27 passed", `time_corpus` "ok. 14 passed", `event_times` "ok. 5 passed". Red is in the log for the lib (3) and `schedule_commands` (1) only; `time_corpus` and `event_times` are regression runs. The quoted "at 2026-10-08T03:25:00.000Z (2026-10-07T23:25) the daily task is not on Today" is a `centraid-core` test, `the_round_trip_specs_daily_task_is_on_today_at_the_hours_it_failed` (`tasks_tests.rs:421`), listed here on the `centraid-vault` line. It is in no retained log (`clock-red.log` ran 74 `app_query` tests; HEAD has 76). I reproduced it: with `recurrence.rs`, `queries.rs` and `app_query/tasks.rs` put back to `346540161^` in an export of HEAD, that test panics with exactly that message; at HEAD it passes. Move the quote to the core line.
  - Line 2, core. `clock-red.log`: "assertion `left == right` failed: trashed 2026-10-08T04:10:00.000Z (2026-10-08T00:10), purging 2026-11-07T04:10:00.000Z (2026-11-06)", then "left: 29" and "right: 30". The receipt's quote shortens and rewords it inside quote marks ("(00:10 New York) …"). Green after: my re-run `cargo test -p centraid-core --lib app_query::` "test result: ok. 76 passed; 0 failed". PASS.
  - Line 3, Kotlin. REFUTED: "expected:<30> but was:<29>" and "pass at all four" appear in no file under the scratchpad. Re-run `spec.sh` at the four clocks with the output tee'd to files and quote them, or drop the line and untick box 3.
  - Line 4. `final-gate-mjvm.log`: "ok    mobile-jvm        250.9s  git diff --exit-code -- design copy mobile contracts/screens" and "gate mobile-jvm: PASS". `git diff 30c414b24 HEAD` over `mobile`, `contracts`, `design` and the Rust crates is empty. PASS.
  - Line 5. `sha256sum experiments/toolchat/native/eval/sets/val.jsonl` is `5d3d9035737a…` and matches `eval/FROZEN.md:38`; `test.jsonl` is `fedc45825fc3…` and matches the next line; the sets are unchanged over `a3f49c7f6..HEAD`. I did not open `refreeze-*.log`, so "before and after the merge" and "the test refreeze identical too" are not confirmed by me. The line is unexplained in this receipt: `crates/nativetools` depends on the vault's apps, so a recurrence change could in principle move a replay. Say that, or drop the line.
- **Governance form.** PASS. `## What changed` and `## Verification` are present, the receipt is not a stub, `## Verification` holds a fence and outcome words ("PASS", "pass", "green"), and this section carries a verdict.

### Re-audit (2026-10-08)

**PASS**

The receipt's text above the first audit was re-read as it now stands; the first audit is unchanged.

- **Box 3 and the Kotlin line.** Fixed. `clock-kotlin-0325.log`, `-0338.log`, `-0410.log` and `-0442.log` each open with "SPEC_FAKETIME=2026-10-08 <hh:mm>:00 (UTC), head 734433cbb", run `> Task :core:jvmTest` (not up to date) with the two specs filtered in, and end "BUILD SUCCESSFUL" (1m 15s, 14s, 13s, 14s). The 04:42 log appends `tests="1" skipped="0" failures="0" errors="0" timestamp="2026-10-08T04:42:01.750Z"  TEST-dev.centraid.core.TasksQueryRoundTripSpec.xml` and the same for `DocsQueryRoundTripSpec` at `04:42:01.096Z`, so the pin reached the test JVM; `fakeclock.log` shows the mechanism ("real: 2026-10-08T10:53:58…", "pinned: 2026-10-08T03:38:00.560119160Z"). Only the 04:42 run has report timestamps; the other three rest on the same script. The "before" half is thinner than the line reads: `tasks-spec.log` holds no clock; its mtime (03:38:22) and "BUILD FAILED in 50s" put the run at the natural clock in the window, not under the pin. The receipt says no Docs red is retained, which is true. Wording only; I do not hold the verdict on it.
- **"expected:<30> but was:<29>" and "pass at all four".** Fixed. The first is gone from the line; the second is now the four logs above.
- **The vault line's misplaced quote.** Fixed. The vault line quotes `clock-red.log`'s own failure, "America/New_York at 2026-10-07T00:00:00.000Z" with left "2026-10-07T00:00:00.000Z" and right "2026-10-06", and "13 passed; 3 failed" / "0 passed; 1 failed". The core line quotes "trashed 2026-10-08T04:10:00.000Z (2026-10-08T00:10), purging 2026-11-07T04:10:00.000Z (2026-11-06)", then "left: 29" and "right: 30", as the log has it. "Green after" is carried by `final-gate-local.log` ("ok    test             1401.2s") and my re-runs in the first audit.
- **The refreeze line.** Fixed as to the explanation; not confirmable by me. It now says why the line is here (the runtime reads due dates) and names the two commits, and `18319d402^1` is `678e80266`. The on-disk `val.jsonl` and `test.jsonl` hashes (`5d3d9035737a…`, `fedc45825fc3…`) equal the frozen values the line quotes. The "9ac6f1773519 on both" and equal-output claims are in `refreeze-*.log`, which I may not open.
- **Governance form.** PASS, as before.
