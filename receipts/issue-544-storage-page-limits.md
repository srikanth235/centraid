# Receipt — issue #544: Storage page — local footprint, disk budget, size-triggered ledger archive

The Operations sidebar had a **Backups** page that answered one question: is my
data safe offsite? It said nothing about the other half of the storage story —
how much of this machine's disk Centraid is eating, and where it went. The only
local signal anywhere was one line of `disk` health detail: free space plus
per-vault *DB* size. The blob CAS and the app code store, the two largest
consumers on a real machine, appeared nowhere.

This renames the page **Storage** and grows it into the whole story: local
footprint by component, a disk budget that warns, and a ledger limit that makes
archival run early. Owner request; direction taken as given (rename, split by
component, warn on the disk limit, archive on the ledger limit).

## Checklist

- [x] Sidebar Operations reads **Storage**, not Backups; palette, `routeKey`, and diagnostics label agree
- [x] `GET _gateway/storage/local` reports per-component bytes per vault plus the gateway-level dirs, and the volume free/total
- [x] Repeat calls inside the TTL do not re-walk the filesystem
- [x] `GET|PUT _gateway/storage/limits` round-trips both limits; `null` clears
- [x] With `totalLimitBytes` set, the `storage-limit` health component reports ok / degraded / error, and no write path is blocked in any of the three
- [x] With `journalLimitBytes` set and `journal.db` over it, a sweep archives immediately and narrows the window until the file is under the limit or the 7-day floor is reached
- [x] With `journalLimitBytes` unset, archival cadence is byte-for-byte today's behaviour
- [x] The Storage page renders the footprint breakdown, both limit controls, and the existing backup card

## What changed

- **Local footprint accounting.**
  `packages/gateway/src/serve/local-usage.ts` (new) walks the real directories
  behind `GatewayPaths` into named components — per vault `ledger` (`journal.db`
  + `-wal` + `-shm`), `vault-db`, `attachments` (`blobs/`), `apps`, `code`, and
  `cache` (runner scratch, billed to the vault it belongs to though it lives
  outside the tree); gateway-wide `backup`, `logs`, `templates`, `storage` —
  plus the volume's `statfs`. `LocalUsageScanner` wraps it in the same
  cache-with-TTL + stale-while-refresh contract `StorageUsagePoller` uses for
  the provider's metered endpoint: first read awaits, later reads are instant,
  a stale read kicks a detached refresh, and a failed refresh keeps serving
  last-known-good with an `error` note rather than blanking figures that were
  true a moment ago. `walkDirBytes` never follows symlinks (a link into the
  user's home would otherwise bill their whole disk to Centraid) and never
  throws — an unreadable subtree contributes what it could read and names
  itself, so the number reads as a floor instead of a silently smaller lie.

- **The owner's two limits.**
  `packages/gateway/src/serve/storage-limits.ts` (new) persists
  `<storageDir>/storage-limits.json` beside the storage connections and the
  recovery-kit flag, same atomic-write shape. `totalLimitBytes` is **warn-only**
  — `evaluateStorageLimit` classifies ok / degraded (past `warnAtPercent`,
  default 80) / error (past the limit) and nothing consults it on a write path.
  A soft budget that silently failed a save would trade a number the owner can
  act on for data loss they cannot. `journalLimitBytes` **actuates**, and safely,
  because what it triggers is archival rather than deletion. Both default to
  `null`; `applyLimitsPatch` refuses a limit below a usable floor (256 MiB
  budget, 64 MiB ledger) so a limit nothing can ever satisfy cannot be set, and
  a malformed stored value coerces to "unset" rather than becoming a real limit.

- **Size-triggered ledger archive.**
  `packages/gateway/src/serve/journal-limit.ts` (new) holds the whole policy as
  one pure function. `packages/gateway/src/serve/vault-plane.ts` measures
  `journal.db` + `-wal` each sweep and calls it: under the limit (or with no
  limit) the decision is exactly today's — run on the daily gate at 90 days.
  Over it, the daily gate is bypassed and the window narrows one rung per sweep,
  90 → 30 → 14 → 7, with **7 a hard floor**: archival must never eat the window
  the owner is working in, so a limit set too low surfaces as "still over at the
  floor" rather than as this morning's conversation being sealed away. The rung
  resets the moment the file is back under, so a spike never permanently narrows
  the window. The window is forwarded to BOTH engines (`runJournalArchival`,
  `runConversationArchival`) since they share the file. The limit reaches every
  mounted plane through `VaultPlaneOptions.journalLimitBytes`, forwarded by
  `packages/gateway/src/serve/vault-registry.ts` and bound in
  `packages/gateway/src/serve/build-gateway.ts` to the shared store's
  synchronous `current()` — a limit change applies on the next sweep without a
  remount, and the sweep never awaits a file read inside its synchronous block.

- **Routes + health.**
  `packages/gateway/src/routes/storage-local-routes.ts` (new) serves `GET
  storage/local` (TTL-cached; `?refresh=1` re-walks inline, for the page's
  Rescan and nothing else) and `GET|PUT storage/limits` (partial patch, `null`
  clears, typed 400 on a refused value). It is a separate module rather than
  more of `storage-routes.ts` for two reasons: that file is about provider
  CONNECTIONS and these two are about this machine's disk, and inlining them
  pushed it to 511 lines, past the repo's 500-line cap.
  `packages/gateway/src/routes/storage-routes.ts` delegates to it before its
  own connection paths. Both deps are optional — a gateway built without them
  answers 503, not 404, because "not wired" and "no such route" are different
  facts. `packages/gateway/src/serve/build-gateway.ts` constructs the
  one `LocalUsageScanner` and `StorageLimitsStore`, wires them into the route
  handler, and registers a `storage-limit` health probe reading the SAME scanner
  the page reads — so the badge and the page can never disagree. With no budget
  set the probe is a permanent `ok`: an owner who never opted in gains no noise.

- **Backups → Storage.**
  The `backups` shell route is now `storage` across
  `packages/client/src/app-shell-context.ts`,
  `packages/client/src/react/shell/router.ts`,
  `packages/client/src/react/shell/App.tsx`,
  `packages/client/src/react/shell/Sidebar.tsx` (`onBackups` → `onStorage`), and
  `packages/client/src/react/shell/routes/paletteData.ts`.
  `packages/client/src/react/shell/routes/StorageRoute.tsx` (was
  `BackupsRoute.tsx`), `packages/client/src/react/screens/StorageScreen.tsx`
  (was `BackupsScreen.tsx`),
  `packages/client/src/react/screens/StorageScreen.module.css` (was
  `packages/client/src/react/screens/BackupsScreen.module.css`) and
  `packages/client/src/react/screens/StorageScreen.test.tsx` (was
  `packages/client/src/react/screens/BackupsScreen.test.tsx`) are git-mv renames,
  so history follows. `packages/client/src/react/shell/Sidebar.test.tsx` follows
  the prop and label rename. Settings → Storage is relabelled **Storage
  provider** (`packages/client/src/react/shell/routes/SettingsRoute.tsx`) — it
  still owns the provider connection and the hosted/local choice, and the backup
  card's "Manage" link still lands there; two destinations reading "Storage" was
  a coin toss. The `backups` label in
  `packages/client/src/react/screens/SettingsDiagnosticsScreen.tsx` is
  deliberately UNCHANGED — that map keys the gateway's health-component
  namespace, not the shell's — and gains `storage-limit: 'Disk budget'`.
  `packages/client/src/react/screens/BackupsScreen.tsx` no longer exists.

- **The Storage page.**
  `packages/client/src/react/screens/StorageScreen.tsx` stacks three cards in
  the order the question is actually asked: what am I using → what ceiling have
  I set → is any of it safe elsewhere.
  `packages/client/src/react/screens/LocalFootprintCard.tsx` leads with one
  display figure and one occupancy rail — a single continuous band of component
  hues, because a disk is one contiguous thing — drawn against the budget when
  set and the disk total otherwise (never against free space, which moves
  whenever anything else on the machine writes). Over budget the fill takes a
  diagonal hatch, so crossing a line the owner drew looks like crossing it and
  the state does not rest on colour alone;
  `packages/client/src/react/screens/LocalFootprintCard.module.css` owns that
  rail, the hatch, and the staggered legend reveal.
  `packages/client/src/react/screens/StorageLimitsPanel.tsx` with
  `packages/client/src/react/screens/StorageLimitsPanel.module.css` renders the
  two limits as deliberately symmetrical blocks — the form is the same (preset
  chips or a typed size), the copy carries the difference between warning and
  acting. `packages/client/src/react/screens/localUsageView.ts` holds every
  presentation decision as pure functions: components keep a fixed hue so the
  bar does not reshuffle its palette between polls, and `parseBytes` refuses
  rather than guessing a unit.
  `packages/client/src/gateway-client-local-storage.ts` (new) is the wire
  client, re-exported from the `packages/client/src/gateway-client.ts` barrel.

- **Tests.**
  `packages/gateway/src/serve/local-usage.test.ts` (attribution, symlink
  containment, TTL no-re-walk, forced rescan, last-known-good on failure),
  `packages/gateway/src/serve/storage-limits.test.ts` (independent set/clear,
  floors, the ok / degraded / error boundaries, malformed-file coercion, the
  synchronous `current()` seam),
  `packages/gateway/src/serve/journal-limit.test.ts` (no-limit ≡ prior
  behaviour, gate bypass, the ladder never passing the floor over ten
  consecutive over-limit sweeps, reset on recovery, corrupt-rung clamping),
  `packages/gateway/src/routes/storage-local-routes.test.ts` (both endpoints
  end-to-end over real HTTP against a real tree and a real limits file),
  `packages/client/src/react/screens/localUsageView.test.ts`, and the rewritten
  `packages/client/src/react/screens/StorageScreen.test.tsx`.

- **Docs.** `ARCHITECTURE.md` gains the component vocabulary and the
  size-gated archival rule beside the on-disk layout and the #438 digest →
  archive → prune paragraph; `CHANGELOG.md` gains the Added and Changed entries.
  This receipt is `receipts/issue-544-storage-page-limits.md`.

### Checklist crosswalk

Each `[x]` above, cited verbatim against the bullet that realizes it:

- **Sidebar Operations reads **Storage**, not Backups; palette, `routeKey`, and diagnostics label agree** — *Backups → Storage*: `Sidebar.tsx`'s label and `paletteData.ts`'s entry both read Storage, `router.ts`'s `routeKey` case is `storage`, and the diagnostics map keeps the gateway's own `backups` component name while gaining `storage-limit`.
- **`GET _gateway/storage/local` reports per-component bytes per vault plus the gateway-level dirs, and the volume free/total** — *Local footprint accounting* + *Routes + health*; asserted end-to-end in `packages/gateway/src/routes/storage-local-routes.test.ts` and live-checked against a real `centraid-gateway serve`.
- **Repeat calls inside the TTL do not re-walk the filesystem** — *Local footprint accounting* (stale-while-refresh); asserted by the walk counter in `packages/gateway/src/serve/local-usage.test.ts`.
- **`GET|PUT _gateway/storage/limits` round-trips both limits; `null` clears** — *The owner's two limits* + *Routes + health*; asserted in `packages/gateway/src/routes/storage-local-routes.test.ts` (clearing one leaves the other set).
- **With `totalLimitBytes` set, the `storage-limit` health component reports ok / degraded / error, and no write path is blocked in any of the three** — *Routes + health*; `evaluateStorageLimit` is the only consumer and nothing on a write path reads it. Boundaries asserted in `packages/gateway/src/serve/storage-limits.test.ts`; the degraded state and an unaffected 200 write were confirmed against a live gateway.
- **With `journalLimitBytes` set and `journal.db` over it, a sweep archives immediately and narrows the window until the file is under the limit or the 7-day floor is reached** — *Size-triggered ledger archive*; asserted in `packages/gateway/src/serve/journal-limit.test.ts` over ten consecutive over-limit sweeps.
- **With `journalLimitBytes` unset, archival cadence is byte-for-byte today's behaviour** — *Size-triggered ledger archive*; `decideJournalArchive` with a `null` limit returns the daily gate at the 90-day window, asserted directly.
- **The Storage page renders the footprint breakdown, both limit controls, and the existing backup card** — *The Storage page*; asserted in `packages/client/src/react/screens/StorageScreen.test.tsx` (three `h2`s, the legend, both limit controls, the recovery-kit gate).


## Decisions

- **The disk budget warns; it does not enforce.** The issue specified warn-only
  and this kept it, but it is worth recording as a real choice rather than an
  omission: a budget that refused writes would convert a number the owner can
  act on into data loss they cannot, and the hard floor already exists in
  `disk-health.ts`, keyed to actual free space — a fact about the machine
  rather than a preference. The health detail says so out loud ("over budget;
  nothing is being blocked") so nobody reads red as "Centraid stopped saving".
- **Both limits carry a floor.** Not in the issue. `applyLimitsPatch` refuses a
  budget under 256 MiB or a ledger limit under 64 MiB. Without a floor an owner
  could set a ledger limit no amount of archival can satisfy, and the plane
  would narrow to the 7-day floor and stay there, re-VACUUMing on every sweep
  forever. Refusing at write time turns that into one clear error instead of a
  quiet permanent state.
- **The window ladder is in memory, not persisted.** A restart re-derives it
  from the file size on the next sweep, which is the only input that matters;
  persisting it would add a migration and a stale-state failure mode for a value
  that is recomputable in one measurement.
- **The `-shm` sibling counts toward the ledger.** It is a fixed-size
  shared-memory index rather than data, so counting it slightly overstates what
  archival can reclaim. Counted anyway: the owner asked how much disk is in use,
  and a file on their disk is in use.
- **Local usage got its own route module and its own client module.** Inlining
  the two handlers pushed `storage-routes.ts` to 511 lines, past the 500-line
  cap; rather than take a waiver, the local half moved to
  `packages/gateway/src/routes/storage-local-routes.ts`, which also matches the
  split in meaning (provider bytes vs. this machine's bytes). The same split on
  the client side gave `packages/client/src/gateway-client-local-storage.ts`.
- **Settings → Storage was relabelled rather than moved or merged.** The
  alternative — folding provider connection into the new page — would have made
  one very long page and broken the existing `{kind: 'settings', page:
  'storage'}` deep link. Renaming to "Storage provider" resolves the collision
  at the cost of one label change.
- **No "clear this" action.** The page names the reclaimable components but
  offers no delete button; deciding what deletion means per component (and what
  it costs) is its own change. Recorded here so the absence reads as a decision.
- **`LOCAL_COMPONENT_CLASS` was written and then removed.** A data / derived /
  plumbing classification on the gateway side turned out to be dead — the client
  carries that distinction in its own copy — and knip is enforced with zero
  suppressions, so it went rather than gaining an ignore entry.

## Out of scope

- **Hard enforcement of the disk budget.** Warn-only by decision; refusing a
  write to honour a soft preference is the wrong trade. Free-space pressure
  remains `disk-health.ts`'s job, because that is a fact about the machine.
- **Per-vault limits.** One gateway-wide budget for v0.
- **Provider-side quota.** `storage/usage` and the five-metric Cost readout are
  untouched.
- **What archival selects.** Only *when* it runs and how far back its window
  reaches is new; eligibility, the custody latch, and the prune half are #438's
  and #367's, unchanged.
- **A "clear this" action.** The page names the reclaimable components (runner
  cache, logs, templates) but offers no delete button — deciding what a delete
  means per component is its own change.

## Verification

```bash
# The new gateway units + the two new routes
bun run --filter '@centraid/gateway' test -- local-usage storage-limits journal-limit storage-local-routes
# Whole gateway suite — proves the archival cadence change broke nothing
bun run --filter '@centraid/gateway' test
# Client screens + the pure view derivation
bun run --filter '@centraid/client' test
# Full pre-push gate (format, oxlint, knip, lint:css, typecheck, matrix, ratchets)
bun run check:pr
```

## Audit

**Audit verdict: PASS**

- "What changed faithfully describes the diff" — PASS. The staged diff comprehensively realizes the feature as described: new gateway modules `local-usage.ts`, `storage-limits.ts`, `journal-limit.ts`, and routes `storage-local-routes.ts` all present with tests; sidebar/route rename from `backups` → `storage` throughout `app-shell-context.ts`, `router.ts`, `App.tsx`, `Sidebar.tsx`, and `paletteData.ts`; `BackupsRoute.tsx` renamed to `StorageRoute.tsx` (git-mv); `BackupsScreen` replaced by new `StorageScreen.tsx` with `LocalFootprintCard.tsx` and `StorageLimitsPanel.tsx` components; vault-plane size-triggered archival integrated via `journal-limit.ts`; gateway health component `storage-limit` registered in `build-gateway.ts`; ARCHITECTURE.md and CHANGELOG.md documentation updated; `gateway-client-local-storage.ts` wire client created; no misrepresentation or omission detected.

- "Each [x] item realized in the diff" — PASS. All eight checklist items confirmed: (1) Sidebar/palette/route/diagnostics agree on Storage via Sidebar.tsx, router.ts, SettingsDiagnosticsScreen.tsx; (2) `GET storage/local` endpoint in storage-local-routes.ts returns per-component bytes and volume statfs; (3) TTL caching implemented in `LocalUsageScanner` with stale-while-refresh contract; (4) `GET|PUT storage/limits` round-trip with `null` clear logic in storage-local-routes.ts and StorageLimitsStore; (5) `storage-limit` health component registered with ok/degraded/error states in build-gateway.ts, `evaluateStorageLimit` classifier in storage-limits.ts, no write-path blocks confirmed in receipt prose; (6) Size-triggered archival integrated in vault-plane.ts calling `decideJournalArchive` with narrowing window ladder 90→30→14→7; (7) No-limit path preserves prior daily-gate cadence per journal-limit.ts design; (8) StorageScreen.tsx stacks LocalFootprintCard + StorageLimitsPanel + BackupCard.

- "Checklist mirrors the issue scope" — PASS. Receipt's eight [x] items map exactly to the eight acceptance criteria in `gh issue view 544`: sidebar labeling, local endpoint, TTL caching, limits endpoint, health states and write safety, size-triggered window narrowing, unset cadence preservation, and page rendering all present and accounted for.

_Audited by fresh-context sub-agent against `git diff --cached`, the receipt, and `gh issue view 544`._

## Steering

**Check 1 — every human-steering event is recorded in ### Steering under ## Accounting** — PASS. Transcript review found zero steering events (redirects, corrections, or interrupts): only one user message in the entire session, the initial task request. No `[Request interrupted` markers, no user corrections during implementation. The empty steering table below is correct.

**Check 2 — no non-steering message is recorded as a steering event** — PASS. All tool-result entries in the transcript are replies to prior agent tool calls, not user-initiated redirects or feedback. No false-positive steering events detected.

### Steering

| steer-key | session | issue | interrupt-class | category | reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| (none — no steering events) | c59f3bec-4a0f-44a3-a718-7aefa490020c | 544 | N/A | N/A | Single task request, no mid-task user corrections or redirects | N/A | N/A | N/A |

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-c59f3bec-4a0-1784945352-1 | claude-code | c59f3bec-4a0f-44a3-a718-7aefa490020c | 544 | claude-opus-5 | 1182 | 602022 | 62339499 | 201544 | 804748 | 39.9769 | 1182 | 602022 | 62339499 | 201544 | feat(storage): local footprint by component, a disk budget, and a size-triggered |
| claude-code-c59f3bec-4a0-1784945845-1 | claude-code | c59f3bec-4a0f-44a3-a718-7aefa490020c | 544 | claude-opus-5 | 30 | 29289 | 5100330 | 11655 | 40974 | 3.0247 | 1212 | 631311 | 67439829 | 213199 | feat(storage): local footprint by component, a disk budget, and a size-triggered |
| claude-code-c59f3bec-4a0-1784945945-1 | claude-code | c59f3bec-4a0f-44a3-a718-7aefa490020c | 544 | claude-opus-5 | 12 | 10584 | 2110606 | 4574 | 15170 | 1.2359 | 1224 | 641895 | 69550435 | 217773 | feat(storage): local footprint by component, a disk budget, and a size-triggered |
| claude-code-c59f3bec-4a0-1784946038-1 | claude-code | c59f3bec-4a0f-44a3-a718-7aefa490020c | 544 | claude-opus-5 | 10 | 7893 | 1791513 | 4510 | 12413 | 1.0579 | 1234 | 649788 | 71341948 | 222283 | feat(storage): local footprint by component, a disk budget, and a size-triggered |
| claude-code-c59f3bec-4a0-1784946090-1 | claude-code | c59f3bec-4a0f-44a3-a718-7aefa490020c | 544 | claude-opus-5 | 2 | 1046 | 361366 | 161 | 1209 | 0.1913 | 1236 | 650834 | 71703314 | 222444 | wip |
| claude-code-c59f3bec-4a0-1784946179-1 | claude-code | c59f3bec-4a0f-44a3-a718-7aefa490020c | 544 | claude-opus-5 | 10 | 5204 | 1817195 | 3735 | 8949 | 1.0345 | 1246 | 656038 | 73520509 | 226179 | feat(storage): local footprint by component, a disk budget, and a size-triggered |
| claude-code-c59f3bec-4a0-1784946248-1 | claude-code | c59f3bec-4a0f-44a3-a718-7aefa490020c | 544 | claude-opus-5 | 2 | 1012 | 365691 | 165 | 1179 | 0.1933 | 1248 | 657050 | 73886200 | 226344 | wip |
