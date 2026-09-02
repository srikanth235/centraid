# Civil time and cron timezone model (issues #570 and #630)

`@centraid/core/time` is the shared civil-time and recurrence core for Agenda, Tasks, Tally, and automation previews. It owns IANA wall-clock resolution, RRULE expansion, completion-relative next occurrences, stable original-occurrence identity, and occurrence/future exceptions. The app engine exposes that package to blueprints as `ctx.time`; blueprints must not implement their own UTC recurrence loops.

Temporal values carry an explicit meaning:

- `zoned`: the wall time is resolved in `start_tz` (and `end_tz` when the end belongs to another zone).
- `floating`: the wall value follows the viewer without acquiring an implicit zone.
- `all-day`: date spans stay calendar dates and do not acquire an implicit zone.

The shared DST policy is the cron policy below: a nonexistent wall time is skipped and an overlapping wall time occurs once at the earlier instant. Per-instance exceptions are keyed by the unmodified original occurrence, even when an override moves what the user sees.

Cron triggers store an optional IANA timezone. The fire zone is resolved in three tiers (n8n-shaped, without a hardcoded geographic fallback):

1. **Per-trigger `tz`** — optional field on `{ kind: 'cron', expr, tz? }`.
2. **Gateway-wide default** — device pref `automation.cron.defaultTimezone` (Settings → Layout → Default cron timezone).
3. **Host-local** — process wall clock via `Date` getters. This is the pre-#570 behavior and the fallback when both upper tiers are empty.

Absent `tz` therefore keeps every existing automation firing at the same wall-clock minute it always did. There is no migration shim.

## Supported RRULE subset

The expander honours `FREQ` (`DAILY`, `WEEKLY`, `MONTHLY`, `YEARLY`), `INTERVAL`, `COUNT`, `UNTIL`, and `BYDAY` — the last steering `WEEKLY` expansion only. **Everything else is refused, never dropped.** `inspectRrule` returns `{ ok: false, reason: 'unsupported-part' | 'unsupported-freq' | 'malformed', … }` for `BYSETPOS`, `BYMONTHDAY`, `BYMONTH`, `BYYEARDAY`, `BYWEEKNO`, `BYHOUR`/`BYMINUTE`/`BYSECOND`, sub-daily `FREQ`, and `WKST` naming a day other than `SU` when `INTERVAL > 1`. A dropped part is a rule that means something else wearing the same face: `FREQ=MONTHLY;BYSETPOS=-1` used to expand to the anchor day and fire "last Friday of the month" on the wrong date forever.

`WKST` is refused rather than implemented: it only changes an expansion when a period spans more than one week, and the engine's week starts on Sunday, so the cases that would differ are the cases it refuses.

Three call shapes, one parser (`packages/core/src/time/rrule-support.ts`):

| Caller | Uses | On a refused rule |
| --- | --- | --- |
| Write boundary (vault command, importer) | `assertSupportedRrule` | throws `UnsupportedRruleError` carrying the typed refusal, so the member sees it where they wrote it |
| A surface that can report | `inspectRrule` | reads `reason`/`part`; `rruleRefusalMessage` renders the sentence |
| Read surfaces (summary, expansion) | `parseRrule` / `expandRecurrence` | `null` / no occurrences — never a plausible series that means something else |

## Validation

Unknown IANA names are rejected at **manifest validation** (create/patch of `automation.json`), not at fire time. The gateway default is validated when written from Settings (unknown names are refused and the pref is not updated).

## Matching

`cronMatches(expr, date, timeZone?)` reads wall-clock fields in the resolved zone when `timeZone` is set, otherwise host-local getters. The client preview (`cronNextRuns` / `cronRunLabel`) uses the same resolved zone so a mobile/web viewer does not re-interpret the schedule in the device zone.

When the schedule zone differs from the viewer's zone, next-run pills append a short zone label (e.g. `Today, 7:00 PM IST`).

## DST policy

| Case | Policy |
| --- | --- |
| **Gap** (spring-forward): wall-clock time does not exist | **Skip** — the minute never matches any absolute instant, so the automation does not fire that day for that expression. |
| **Overlap** (fall-back): wall-clock time exists twice | **Once** — matching can hit both absolute minutes, but the cursor reader dedupes by zone wall-clock key so the automation fires once for that wall-clock minute. |

Pinned transition dates used in tests (America/New_York):

- Spring-forward 2026-03-08 (02:00 → 03:00)
- Fall-back 2026-11-01 (02:00 → 01:00)

**How Overlap holds under a continuous tick.** The dedupe inside a single `dueInstants` call only ever saw one window, and a running scheduler ticks once a minute — so the two absolute minutes sharing a wall clock landed in two different one-minute windows, each deduped perfectly against itself, and the automation fired twice. "Once" held only for a window wide enough to contain both copies, which is the shape that follows downtime ([#846](https://github.com/srikanth235/centraid/issues/846) P2).

`readCronCursor` now carries the memory across windows, and derives it rather than persisting it: when — and only when — a schedule's zone actually moved its clock back inside the last three hours, the reader re-walks the window behind its cursor and drops any candidate whose wall-clock keys were all covered there. The cursor row stays a bare millisecond position, so there is no watermark to migrate or corrupt, and an ordinary tick pays two `Intl` reads for the check rather than a second scan. The survivor is the earlier instant, as the table above says.

The Gap row is unaffected: a minute that exists in no window cannot be delivered by any number of windows.

Both rows are held under a continuous minute-by-minute tick, across a whole-hour shift, a negative-DST zone and a thirty-minute shift, in `packages/server/src/automation/fire/time-zoo-cron.test.ts`.

Missed fires during gateway downtime are still not backfilled (#149). DST policy only governs whether a wall-clock minute is due while the scheduler is running.

## Multiple devices, one schedule

Devices sharing a vault share one cursor row, so the schedule is owned by whichever device's clock is furthest ahead. A device running behind reads a window whose start has already been committed past — an inverted window, which reads as "nothing due" — so it neither re-delivers a minute the leading device already fired nor delivers one of its own. That is what keeps the no-double-fire law true across devices without any coordination between them, and it is the reason a lagging device looks idle rather than broken.

The cost is the other half of the same coin: a device far enough behind never fires at all while a leading device is present. This is characterised (not pinned — it contradicts no ruling) in `packages/server/src/automation/fire/clock-adversity-cron.test.ts`, so a future change that lets a lagging device sweep its own window turns that exact configuration into a visible double fire rather than a silent one.

## Code pointers

| Concern | Location |
| --- | --- |
| Civil time + recurrence + exception expansion | `packages/core/src/time/` |
| RRULE parsing + the refusal contract | `packages/core/src/time/rrule-support.ts` |
| Blueprint runtime surface | `packages/server/src/engine/worker/runner.ts` (`ctx.time`) |
| Resolution + wall-clock extraction | `packages/server/src/automation/cron-timezone.ts` |
| Matcher | `packages/server/src/automation/fire/cron-match.ts` |
| Cursor / due instants | `packages/server/src/automation/fire/cron-cursor.ts` |
| Manifest shape + IANA validation | `packages/server/src/automation/manifest/manifest.ts` |
| Gateway default wiring | `packages/server/src/serve/build-gateway.ts` (`defaultCronTimeZone`) |
| Client preview + labels | `packages/client/src/cron.ts` |
| Editor timezone control | `packages/client/src/react/screens/AutomationEditorScreen.tsx` |
| Settings default | `packages/client/src/react/screens/SettingsLayoutScreen.tsx` |
