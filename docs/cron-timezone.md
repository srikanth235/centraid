# Cron timezone model (issue #570)

Cron triggers store an optional IANA timezone. The fire zone is resolved in
three tiers (n8n-shaped, without a hardcoded geographic fallback):

1. **Per-trigger `tz`** — optional field on `{ kind: 'cron', expr, tz? }`.
2. **Gateway-wide default** — device pref `automation.cron.defaultTimezone`
   (Settings → Layout → Default cron timezone).
3. **Host-local** — process wall clock via `Date` getters. This is the pre-#570
   behavior and the fallback when both upper tiers are empty.

Absent `tz` therefore keeps every existing automation firing at the same
wall-clock minute it always did. There is no migration shim.

## Validation

Unknown IANA names are rejected at **manifest validation** (create/patch of
`automation.json`), not at fire time. The gateway default is validated when
written from Settings (unknown names are refused and the pref is not updated).

## Matching

`cronMatches(expr, date, timeZone?)` reads wall-clock fields in the resolved
zone when `timeZone` is set, otherwise host-local getters. The client
preview (`cronNextRuns` / `cronRunLabel`) uses the same resolved zone so a
mobile/web viewer does not re-interpret the schedule in the device zone.

When the schedule zone differs from the viewer's zone, next-run pills append
a short zone label (e.g. `Today, 7:00 PM IST`).

## DST policy

| Case | Policy |
| --- | --- |
| **Gap** (spring-forward): wall-clock time does not exist | **Skip** — the minute never matches any absolute instant, so the automation does not fire that day for that expression. |
| **Overlap** (fall-back): wall-clock time exists twice | **Once** — matching can hit both absolute minutes, but the cursor reader dedupes by zone wall-clock key so the automation fires once for that wall-clock minute. |

Pinned transition dates used in tests (America/New_York):

- Spring-forward 2026-03-08 (02:00 → 03:00)
- Fall-back 2026-11-01 (02:00 → 01:00)

Missed fires during gateway downtime are still not backfilled (#149). DST
policy only governs whether a wall-clock minute is due while the scheduler
is running.

## Code pointers

| Concern | Location |
| --- | --- |
| Resolution + wall-clock extraction | `packages/automation/src/cron-timezone.ts` |
| Matcher | `packages/automation/src/fire/cron-match.ts` |
| Cursor / due instants | `packages/automation/src/fire/cron-cursor.ts` |
| Manifest shape + IANA validation | `packages/automation/src/manifest/manifest.ts` |
| Gateway default wiring | `packages/gateway/src/serve/build-gateway.ts` (`defaultCronTimeZone`) |
| Client preview + labels | `packages/client/src/cron.ts` |
| Editor timezone control | `packages/client/src/react/screens/AutomationEditorScreen.tsx` |
| Settings default | `packages/client/src/react/screens/SettingsLayoutScreen.tsx` |
