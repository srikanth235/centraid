# issue-570 — Store an explicit timezone on cron triggers

GitHub issue: [#570](https://github.com/srikanth235/centraid/issues/570)

## Checklist

- [x] Optional IANA `tz` on cron triggers; unknown names rejected at manifest validation
- [x] Absent `tz` keeps host-local fire behavior (tier 3)
- [x] Resolution: per-trigger `tz` → gateway default pref → host-local (no geographic hardcode)
- [x] Zone-aware `cronMatches` / cursor paths; host≠trigger covered by tests
- [x] Client next-run / describe / labels use the resolved zone
- [x] Automation editor timezone control + Settings default timezone control
- [x] DST gap (skip) and overlap (once) documented and tested on real US transitions
- [x] `docs/cron-timezone.md` + this receipt; conventional commits with `(#570)`
- [x] `bun run check:pr` green; PR open

## What changed

### Optional IANA `tz` on cron triggers; unknown names rejected at manifest validation

- `packages/automation/src/manifest/manifest.ts` — `CronTrigger` gains optional `tz`; `validateOneTrigger` rejects empty/unknown IANA names via `isValidIanaTimeZone`.
- `packages/automation/src/manifest/manifest.test.ts` — accepts `America/New_York`, rejects `Not/A_Real_Zone` and blank `tz`.
- `packages/gateway/src/routes/lifecycle-automation-routes.ts` — create/patch pass `tz` through to the manifest.
- `packages/client/src/centraid-api.d.ts`, `packages/client/src/gateway-client-automation-editing.ts`, `packages/client/src/react/screen-contracts.ts`, `packages/client/src/react/shell/routes/builder/BuilderAutomationTriggers.tsx`, `apps/mobile/src/lib/automations.ts` — wire types include optional `tz`.

### Absent `tz` keeps host-local fire behavior (tier 3)

- `packages/automation/src/fire/cron-match.ts` — without `timeZone`, still uses `Date` getters (`getHours` / `getDay` / …), same as pre-#570.
- `packages/automation/src/fire/cron-cursor.ts` / `packages/automation/src/fire/cron-cursor.test.ts` — host-local schedules remain string exprs; existing DST fall-back host-local tests kept green.

### Resolution: per-trigger `tz` → gateway default pref → host-local (no geographic hardcode)

- **New** `packages/automation/src/cron-timezone.ts` — `resolveCronTimezone`, `isValidIanaTimeZone`, `wallClockFields`, `wallClockMinuteKey`, pref key `CRON_DEFAULT_TIMEZONE_PREF` (`automation.cron.defaultTimezone`).
- `packages/automation/src/fire/cursor-engine-support.ts` — `registrationsFor(row, defaultTimeZone)` builds `cronSchedules` with resolved zones.
- `packages/automation/src/fire/cursor-engine.ts` — `defaultCronTimeZone` option; `readCronCursor` uses `cronSchedules`.
- `packages/gateway/src/serve/build-gateway.ts` — reads the pref on each register/reconcile.
- `packages/automation/src/fire/scheduler-ledger.ts` — missed-window scan carries per-expr zones.
- `packages/automation/src/index.ts` — exports the helpers + `cronMatches`.

### Zone-aware `cronMatches` / cursor paths; host≠trigger covered by tests

- `packages/automation/src/fire/cron-match.ts` + `packages/automation/src/fire/cron-match.test.ts` — zone wall-clock match; host≠trigger assertion for `America/New_York`.
- `packages/automation/src/fire/cron-cursor.test.ts` — zone schedule fires at 09:00 ET independent of host getters.

### Client next-run / describe / labels use the resolved zone

- `packages/client/src/cron.ts` — `cronNextRuns(expr, count, from, timeZone?)`, `describeCron(expr, timeZone?)`, `cronRunLabel`, `resolveCronTimezone`, `shortTimeZoneName`.
- `packages/client/src/cron.test.ts` — stable absolute instants under a fixed zone; label appends zone when viewer differs.
- `packages/client/src/react/shell/routes/automationsData.ts` — overview/hero next-run use resolved `tz` + `cronRunLabel`.

### Automation editor timezone control + Settings default timezone control

- `packages/client/src/react/screens/AutomationEditorScreen.tsx` — timezone input on cron triggers (`data-testid="cron-timezone"`), zone-aware preview.
- `packages/client/src/react/shell/routes/AutomationEditorRoute.tsx` — loads/saves `tz`; hydrates `defaultCronTimeZone` from prefs.
- `packages/client/src/react/screens/SettingsLayoutScreen.tsx` — Settings → Layout → Default cron timezone (`data-testid="settings-default-cron-timezone"`).
- **New** `packages/client/src/react/shell/routes/settingsCronTimezoneData.ts` and `packages/client/src/react/shell/routes/settingsCronTimezoneData.test.ts` — load/save/validate the pref; test uses `vi.hoisted` so oxlint `import/first` stays green under `check:pr`.
- `packages/client/src/react/screens/settings-controls.module.css` — `.input` for the Settings control.

### DST gap (skip) and overlap (once) documented and tested on real US transitions

- `docs/cron-timezone.md` — resolution tiers + gap=skip / overlap=once policy.
- `packages/automation/src/fire/cron-match.test.ts` — America/New_York 2026-03-08 gap and 2026-11-01 overlap.
- Cursor wall-clock dedupe in `packages/automation/src/fire/cron-cursor.ts` keeps one fire per zone wall-clock minute.

### `docs/cron-timezone.md` + this receipt; conventional commits with `(#570)`

- `docs/cron-timezone.md`, `AGENTS.md` docs-index row, this receipt (`receipts/issue-570-cron-timezone.md`), conventional commits with `(#570)`.

## Out of scope

- Backfill of missed fires during downtime (#149 unchanged).
- Temporal-style per-fire overlap policies; 6-field cron; non-cron trigger zones.
- Migration shim (absent `tz` is current behavior).

## Decisions

- **Host-local as tier 3, not a hardcoded geography** — avoids n8n's historical `America/New_York` surprise for personal gateways.
- **Gap = skip, overlap = once** — matching non-existent wall-clock minutes never fires; fall-back is deduped by zone wall-clock key in the cursor reader (same spirit as pre-#570 host-local dedupe).
- **Client duplicates pure timezone helpers** — `@centraid/client` does not depend on `@centraid/automation`; shared pure logic is intentionally duplicated rather than adding a client→automation dependency.
- **Gateway default lives in device prefs** (`automation.cron.defaultTimezone`) under Settings → Layout, same prefs store as runner/model prefs.

## Verification

```text
# Optional IANA tz validation (unknown rejected at write)
cd packages/automation && bun run test -- src/manifest/manifest.test.ts

# Absent tz / host-local regression + zone due-instants
cd packages/automation && bun run test -- src/fire/cron-cursor.test.ts

# Zone match host≠trigger + DST gap/overlap
cd packages/automation && bun run test -- src/fire/cron-match.test.ts

# Client preview + zone labels + Settings pref helpers
cd packages/client && bun run test -- src/cron.test.ts src/react/shell/routes/settingsCronTimezoneData.test.ts

# Full PR gates — bun run check:pr green; PR open
bun run check:pr
```

Editor exposes `data-testid="cron-timezone"`; Settings exposes `data-testid="settings-default-cron-timezone"`.
`bun run check:pr` green; PR open once gates pass.

## Audit

Fresh-context attestation against the receipt body, issue #570 acceptance criteria / scope, and the on-disk implementation (named paths, symbols, and tests). Accounting Steering table has header only (no data rows).

### 1. "What changed" faithfully describes the diff — **PASS**

Named files and symbols in `## What changed` are present and match the claims:

| Claim | Evidence |
| --- | --- |
| Optional `tz` on `CronTrigger` + IANA reject in `validateOneTrigger` | `packages/automation/src/manifest/manifest.ts` — `CronTrigger.tz?`; `isValidIanaTimeZone` reject path |
| Manifest tests accept `America/New_York`, reject `Not/A_Real_Zone` / blank | `packages/automation/src/manifest/manifest.test.ts` |
| Create/patch pass `tz` | `packages/gateway/src/routes/lifecycle-automation-routes.ts` |
| Client/mobile wire types | `packages/client/src/centraid-api.d.ts`, `gateway-client-automation-editing.ts`, `screen-contracts.ts`, `BuilderAutomationTriggers.tsx`, `apps/mobile/src/lib/automations.ts` |
| Host-local when no zone | `cron-match.ts` → `wallClockFields` without `timeZone` uses `Date` getters; `cron-timezone.ts` documents byte-identical absent-`tz` path |
| `resolveCronTimezone` / `isValidIanaTimeZone` / `wallClockFields` / `wallClockMinuteKey` / pref key | **New** `packages/automation/src/cron-timezone.ts`; re-exported from `packages/automation/src/index.ts` |
| `registrationsFor` + `defaultCronTimeZone` + `cronSchedules` | `cursor-engine-support.ts`, `cursor-engine.ts`, `build-gateway.ts` prefs read |
| Zone match + host≠trigger + DST | `cron-match.ts` / `cron-match.test.ts`; cursor zone due-instants in `cron-cursor.test.ts` |
| Client preview/labels | `packages/client/src/cron.ts` + `cron.test.ts`; `automationsData.ts` |
| Editor / Settings testids | `AutomationEditorScreen.tsx` `data-testid="cron-timezone"`; `SettingsLayoutScreen.tsx` `data-testid="settings-default-cron-timezone"` |
| Pref helpers | **New** `settingsCronTimezoneData.ts` (+ `.test.ts`) |
| Docs | `docs/cron-timezone.md`; `AGENTS.md` docs-index row |

No material mismatch between narrative and code.

### 2. Each `[x]` checklist item is realized — **PASS**

Spot-checks requested by the audit brief:

| Checklist item | Realization |
| --- | --- |
| Optional IANA `tz`; unknown rejected at validation | `CronTrigger.tz?`; `validateOneTrigger` + `isValidIanaTimeZone`; tests in `manifest.test.ts` |
| Absent `tz` → host-local (tier 3) | `resolveCronTimezone` returns `undefined`; `wallClockFields` host getters; host-local schedules remain string exprs in cursor path |
| Resolution tiers (no geographic hardcode) | `resolveCronTimezone(trigger, gatewayDefault)`; tests assert trigger → default → `undefined` |
| Zone-aware `cronMatches` / cursor; host≠trigger tests | `cronMatches(expr, date, timeZone?)`; `cron-match.test.ts` "matches an explicit IANA zone…"; `cron-cursor.test.ts` ET 09:00 |
| Client next-run / describe / labels | `cronNextRuns` / `describeCron` / `cronRunLabel` / `shortTimeZoneName` take zone; label when viewer differs |
| Editor + Settings controls | `data-testid="cron-timezone"`; `data-testid="settings-default-cron-timezone"`; Settings → Layout wiring via `settingsCronTimezoneData` |
| DST gap skip / overlap once, US transitions | `cron-match.test.ts` America/New_York **2026-03-08** gap + **2026-11-01** overlap; `wallClockMinuteKey` dedupe in `cron-cursor.ts`; policy in `docs/cron-timezone.md` |
| Docs + receipt + `(#570)` | `docs/cron-timezone.md`, this receipt, issue-linked commits claimed in What changed / Verification |

`bun run check:pr` green / PR open are process claims in Verification; code-level checklist items above are fully realized on disk.

### 3. Checklist mirrors issue #570 acceptance criteria — **PASS**

Issue AC → checklist mapping:

| Issue #570 acceptance criterion | Checklist coverage |
| --- | --- |
| Optional IANA `tz`; unknown rejected at manifest validation | Item 1 |
| No `tz` → host-local / existing behavior | Item 2 |
| With `tz`, fire in zone independent of host; host≠trigger test | Items 3–4 |
| Client preview in resolved zone; label when viewer differs | Item 5 |
| Gateway-wide default when trigger omits `tz` | Items 3 + 6 (Settings control) |
| DST gap/overlap documented + tests on real transitions | Item 7 |
| `bun run check:pr` green | Item 9 |

Editor timezone control and `docs/cron-timezone.md` also match the issue **Scope → In** bullets (not only AC). Out-of-scope in the receipt matches the issue (no #149 backfill, no Temporal per-fire policies, no 6-field cron, no migration shim).

## Steering

Session context (Grok Build goal implementing #570 end-to-end): **no human mid-task correction or interrupt** — only initial goal authorization, which is not steering.

### 1. Every genuine steering event has a row — **PASS**

Genuine steering events this session: **zero**. Accounting `### Steering` table has the header only and **no data rows**. Empty table correctly reflects zero events.

### 2. No non-steering message is recorded as steering — **PASS**

No spurious rows under Accounting Steering (no initial-goal or other non-steering noise recorded as steer-key rows).

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
