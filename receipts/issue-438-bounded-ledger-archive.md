# Receipt — Issue #438: Bounded ledger: digest → archive idle conversations to cas → custody-gated prune

Issue: https://github.com/srikanth235/centraid/issues/438

## Checklist

- [x] Verify auto_vacuum mode on vault.db + journal.db; migrate to INCREMENTAL if NONE
- [x] conversation_digest materialized table + Insights/list reads move from run_summary VIEW to digests
- [x] Conversation archive serializer (sealed blob per idle conversation through the blob door)
- [x] conversation_archive index table; archive references added as CAS GC roots (shared rule with the snapshot-pinning invariant)
- [x] Custody-gated prune + incremental_vacuum in the bounded maintenance pass
- [x] Lazy rehydration path (read-only render of archived conversations)
- [x] Tests: prune-before-custody is impossible; digest parity with pre-archive rollups; rehydrate round-trip; vacuum reclaims pages

## What changed

### Verify auto_vacuum mode on vault.db + journal.db; migrate to INCREMENTAL if NONE

Neither opener set `auto_vacuum`, so every fleet file ran in freelist mode and no prune could ever shrink a file. Both openers now set `PRAGMA auto_vacuum=INCREMENTAL` — ordered BEFORE `journal_mode=WAL`, which is mandatory (once WAL writes page 1 the header is fixed and the pragma no longer applies at table-create time) — and run a one-time full `VACUUM` conversion when they open a pre-#438 non-empty file that still reads `auto_vacuum=0`. The WAL shipper treats that rewrite as a foreign checkpoint and heals with a generation break, a one-time cost taken now while fleet files are small.

- `packages/vault/src/db.ts` — `openFile()` pragma ordering + legacy conversion (vault.db and journal.db).
- `packages/app-engine/src/stores/gateway-db.ts` — `openJournalDb()` mirrors the same, so a journal reached only through app-engine (worker subprocess, standalone daemon) also converges.
- `packages/vault/src/journal-archive.ts` — `reclaimSpace()` doc comment updated: incremental is now the normal path; full VACUUM remains the legacy-file fallback.
- `packages/vault/src/db.test.ts`, `packages/app-engine/src/stores/gateway-db.test.ts` — fresh files report incremental; legacy freelist files convert on reopen; `incremental_vacuum` reclaims pages after bulk deletes.

### conversation_digest materialized table + Insights/list reads move from run_summary VIEW to digests

Two cold-state tables added to `CONVERSATION_LEDGER_DDL` in `packages/app-engine/src/stores/gateway-db.ts` (IF NOT EXISTS, STRICT, `user_version` untouched; file gained a line-1 repo-hygiene waiver — the band DDL is one indivisible template-literal schema hub):

- `conversation_archive` — one row per archived turn-range segment (seq/time span, turn/item counts, `segment_sha256` len-64 CHECK, segment/plaintext byte sizes, `attachment_hashes_json`, `pruned_at` custody latch, CASCADE off `conversations`), with (conversation_id, seq_from) + sha + partial unpruned indexes.
- `conversation_digest` — one row per conversation, upserted at archive time, covering the ARCHIVED portion only: run/ok/err/retry counts, four token totals, cost, step/tool counts, `models_json` per-model rollup, first/last archived timestamps, kind/app_id/automation_ref/automation_name snapshot.

`packages/app-engine/src/insights/insights-store.ts` unions every aggregate (kpis, appsTouched, daily, byAutomation, byModel via `json_each(models_json)`) across live `run_summary` and `conversation_digest`; digests join a window when `last_ended_at >= since`; day-grain series attribute a digest to its last-archived day (coarse only beyond the ≥90d archive horizon, documented per query); `recent` stays live-only. `packages/app-engine/src/insights/analytics-store.ts` documents the row-grain Executions feed as live-only (no fabricated per-run rows). Zero-digest results are byte-identical to the pre-#438 behavior — existing insights tests run unmodified.

- `packages/app-engine/src/insights/insights-store.test.ts` — digest union across kpis/byAutomation/byModel/daily; out-of-window digest excluded; digest parity with pre-archive rollups (rollups before archive == digest+live after a simulated prune).

### Conversation archive serializer (sealed blob per idle conversation through the blob door)

New engine `packages/app-engine/src/conversation/archive/` (app-engine owns the ledger band; the vault blob door and custody latch are injected seams, so layering stays one-way):

- `packages/app-engine/src/conversation/archive/types.ts` — `BlobSink`/`CustodyProven` seams, segment shape, internal constants (90-day window, per-run caps; no user-facing knobs).
- `packages/app-engine/src/conversation/archive/selector.ts` — eligibility → contiguous seq-ranges. Automation threads (one eternal conversation per automation) archive aged finished ranges but never the newest turn, never pinned/unfinished/retry-protected/already-archived turns; chat/build conversations archive only when the whole conversation is idle past the window with no unfinished or pinned turn.
- `packages/app-engine/src/conversation/archive/segment.ts` — gzip(JSON) segment of verbatim turn/item/attachment rows through the blob door (`blobSink.ingestSync`), `conversation_archive` row insert, `conversation_digest` UPSERT adding the range's deltas; `models_json` uses the exact `run_summary.model` dominant-model pick (the Wave 1 union contract). Exports `readArchivedConversationSegment` for the rehydration wave.
- `packages/app-engine/src/conversation/archive/engine.ts` + `packages/app-engine/src/conversation/archive/index.ts` — `runConversationArchival` entry: phase A archive (one transaction per range), then phase B prune each call; barrel export wired into `packages/app-engine/src/index.ts`.
- `packages/app-engine/src/conversation/store-sql.ts` — `referencedHashes()` unions live `attachments.hash` with `json_each(conversation_archive.attachment_hashes_json)` (pruned and unpruned) so the app-engine blob GC keeps archived attachment bytes pinned; conversation deletion CASCADE-drops archive rows and releases them (true deletion stays the consent path).

### conversation_archive index table; archive references added as CAS GC roots (shared rule with the snapshot-pinning invariant)

The index table itself landed in the Wave 1 schema; this wave makes its references live GC roots. `packages/vault/src/conversation-archive-roots.ts` — `conversationArchiveShas(journal)` (SQL over the same journal.db file the vault holds open, `sqlite_master`-guarded for a journal whose ledger band is not yet ensured), exported via `packages/vault/src/index.ts`. Unioned into the live-root set at every reconcile/GC site where #367's `archivedSegmentShas` already is: `packages/vault/src/gateway/gateway.ts`, `packages/gateway/src/backup/backup-cas-reconciliation.ts`, `packages/gateway/src/backup/backup-reconciliation.ts`, `packages/gateway/src/backup/backup-sources.ts` — one reachability rule, three root sets, fail-safe contract unchanged (unavailable roots still skip orphan-delete).

### Custody-gated prune + incremental_vacuum in the bounded maintenance pass

- `packages/app-engine/src/conversation/archive/prune.ts` — the raw-row DELETE exists only behind the `custodyProven(segment_sha256)` latch in one code path (prune-before-custody is structurally impossible); each segment prunes in one transaction and latches `pruned_at`; `conversations.turn_count` stays a lifetime counter; `reclaimJournalPages` mirrors the freelist → `incremental_vacuum` pattern.
- `packages/vault/src/blob/custody-proven.ts` — `blobCustodyProven(db, sha)`: remote tier configured ⇒ `blob_replica` has the sha AND no `blob_outbox` row remains; local-only vault ⇒ durable local CAS presence. Fail-closed. Exported from the vault index.
- `packages/gateway/src/serve/vault-plane.ts` — the daily archival block now runs both engines: `walTick()` → `runJournalArchival` → `ensureConversationLedger` → `runConversationArchival` (seams composed from `db.blobs` + `blobCustodyProven`), then ONE shared `rollGeneration('journal','journal-archival',{captureFirst:false})` if either engine wrote or pruned — vault and journal generations still break together.

### Lazy rehydration path (read-only render of archived conversations)

Opening a conversation whose cold ranges were custody-gated-pruned now serves the live rows AND merges the archived turns back, read-only, marked "from the archive". The vault blob CAS is the source; app-engine never imports vault, so the read-back crosses one injected seam.

- `packages/app-engine/src/conversation/rehydrate.ts` — new module. `ArchiveBlobReader = (sha) => Promise<Uint8Array | null>` seam (the gateway supplies `db.blobs.open`); `collectArchivedRows(reader, prunedRefs)` fetches each PRUNED segment blob, gunzips + parses via `readArchivedConversationSegment`, and re-maps the verbatim rows through `turnFromRaw`/`itemFromRaw`/`attachmentFromRaw`. A missing reader, a throwing fetch, a null blob, or corrupt bytes are collected into `unavailable` and skipped — never thrown — so the read degrades to live-rows + a marker.
- `packages/app-engine/src/conversation/history.ts` — new `getSessionRehydrated(appId, id)` async read: fast-paths to the live-only `getSession` when nothing is pruned, else merges archived + live turns by seq and folds them through one shared, pure `foldTranscript` (extracted from `getSession`) that stamps `fromArchive: true` on each rehydrated payload. Returns `SessionTranscript` with `hasArchivedHistory` / `archivedTurnCount` / `archiveUnavailable`. Constructor takes an optional `archiveBlobReader`. `setTurnFeedback` documents the read-only invariant: a pruned turn's raw row is gone, so the UPDATE matches nothing and the route 404s — mutating sealed history is structurally impossible; an archived-but-unpruned turn keeps its row and stays mutable.
- `packages/app-engine/src/conversation/store.ts` — `listArchiveSegments(conversationId)` returns each archive row's seq-range + sha + `pruned` flag; imports the `ArchiveSegmentRef` type.
- `packages/app-engine/src/conversation/store-sql.ts` — `listArchiveSegments` prepared statement + interface field.
- `packages/app-engine/src/http/conversation-routes.ts` — the GET session route awaits `getSessionRehydrated`, so the markers ride the wire.
- `packages/app-engine/src/index.ts` — exports the `SessionTranscript` type and the `ArchiveBlobReader` seam type.
- `packages/gateway/src/serve/build-gateway.ts` — wires `archiveBlobReader: (sha) => vaultRegistry.current().db.blobs.open(sha)` when constructing `ConversationHistoryStore`, resolving the ACTIVE vault per call (the same resolution `currentWorkspace` uses) so a vault switch reads the right file. The standalone `packages/app-engine/src/http/http-server.ts` host wires no reader (no blob custody), so rehydration there degrades to `archiveUnavailable` — no code change needed (the constructor arg is optional).
- `packages/client/src/centraid-api.d.ts` — `fromArchive?: boolean` added to every `CentraidConversationHistoryMessage` variant (both declaration blocks).
- `packages/client/src/gateway-client-conversation.ts` — `loadConversation` return type carries `hasArchivedHistory` / `archivedTurnCount` / `archiveUnavailable`.
- `packages/client/src/react/shell/routes/assistantTranscript.ts` — `hydrateMessages` prepends a subtle info notice above rehydrated history (a warn notice when `archiveUnavailable`) and threads `fromArchive` onto the AI model; `msgToDTO` drops the feedback/regenerate target for a `fromArchive` answer so the surface renders no control the server would reject.
- `packages/client/src/react/shell/routes/AssistantRoute.tsx` — both `hydrateMessages` call sites pass the archive markers through. The automation thread screen (`automationThreadData.ts`) reads the run feed, not this session payload, so it is untouched.

### Tests: prune-before-custody is impossible; digest parity with pre-archive rollups; rehydrate round-trip; vacuum reclaims pages

The rehydrate round-trip half of this item landed this wave (the other three were Wave 1/2, above and in Verification):

- `packages/app-engine/src/conversation/rehydrate.test.ts` — new. Archives + prunes a seeded conversation through the real engine + an in-memory CAS sink shared with the reader, then: rehydrated `getSessionRehydrated` merges archived + live turns in seq order, byte-equal (ignoring the `fromArchive` marker) to the pre-archive transcript, with the attachment surviving the prune; feedback on a pruned turn no-ops while a live turn still updates; a throwing reader yields live rows + `archiveUnavailable` and no crash; an unpruned archive row serves from live rows without ever calling the reader; the GET session route surfaces the markers in its JSON body.
- `packages/client/src/react/shell/routes/assistantTranscript.test.ts` — extended: `hydrateMessages` prepends the from-the-archive notice and marks rehydrated answers; the warn notice appears when history is unavailable; `msgToDTO` suppresses feedback/regenerate on a read-only archived answer.

## Out of scope

- The audit band (consent/agent tables) — append-only forever; its #367 archival engine is untouched except doc-comment corrections.
- User-facing retention settings — internal constants only (five-metric discipline, #436 §6).
- True deletion of history — existing consent/delete paths remain the only deletion.
- automation_state and in-flight conversations/turns.
- Direct-to-IA storage-class extension for archive blobs (they ride the cas class as-is in v1).

## Decisions

- **Archive unit is a turn-range segment, not strictly a whole conversation.** An automation is ONE eternal conversation (`ensureAutomationConversation` reuses `id = automationRef`), so the issue's "conversations idle > N days" selector alone would never touch the very threads that drive machine-speed growth. Whole idle conversations archive as complete segments (the issue's stated shape); live automation threads archive aged contiguous finished ranges, never the newest turn, never in-flight/pinned/retry-protected turns. `conversation_archive` naturally supports both (one or many rows per conversation).
- **`conversation_digest` covers only the archived portion.** Live turns keep flowing through the `run_summary` view; Insights unions the two. This avoids double-counting for half-archived automation threads and keeps the digest write path exclusively inside the archival engine.
- **`custodyProven` reads settings-level intent (`blob_store.kind === 's3'`), not the resolved remote tier.** A vault that DECLARES a remote but cannot currently replicate stays un-pruned (fail-closed) instead of degrading to local-presence pruning.
- **Engine lives in app-engine** (it owns the ledger band) with injected `BlobSink`/`CustodyProven`/`ArchiveBlobReader` seams; vault and gateway supply the blob door and custody primitives. Layering stays one-way (app-engine never imports vault).
- **`conversations.turn_count` stays a lifetime counter** after prune (every existing post-delete path leaves it too); archived-portion counts live in the digest.
- **Read-only enforcement is structural**: a pruned turn's raw row no longer exists, so turn-grain mutations (feedback) 404 naturally; the client hides those controls for `fromArchive` turns instead of rendering an always-erroring button.

## Verification

Wave 1 (schema + vacuum + insights union):

```
bunx turbo run typecheck --filter=@centraid/vault --filter=@centraid/app-engine
  Tasks: 6 successful, 6 total
packages/vault full suite:            85 files, 761 passed | 1 skipped
packages/app-engine (insights + gateway-db targeted): 34 passed
packages/vault (db + journal-archive targeted):       15 passed
oxlint over the 8 changed files:      0 warnings, 0 errors
```

Pre-existing failure, unrelated and untouched: `packages/app-engine/src/http/app-bundle.test.ts` ("collapses the real photos app to 2 requests", after=51) fails identically on the branch head without these changes (verified via `git stash`).

Wave 2 (archive engine + GC roots + custody-gated prune):

```
bunx turbo run typecheck --filter=@centraid/vault --filter=@centraid/app-engine --filter=@centraid/gateway
  Tasks: 25 successful, 25 total
packages/vault full suite:                    767 passed | 1 skipped (87 files)
packages/app-engine conversation+insights+stores: 160 passed (10 files)
packages/gateway vault-plane*/backup-* targeted:   43 passed (6 files)
oxlint (29 changed files):                    0 warnings, 0 errors
```

Wave 2 test files (later split under the 500-line repo-hygiene cap into `packages/app-engine/src/conversation/archive/archive.test.ts` + `packages/app-engine/src/conversation/archive/selector.test.ts` with shared fixtures in `packages/app-engine/src/conversation/archive/test-fixtures.ts`): `packages/app-engine/src/conversation/archive/archive.test.ts` (prune-before-custody impossible across repeated runs, then flips with custody and latches idempotently; segment round-trip byte-identical; incremental_vacuum drops page_count after prune; selector edges — live automation head and unfinished turns kept, pinned turns block/split ranges, non-idle chat untouched, in-flight retry protects its target, re-runs idempotent, automation_state untouched; referencedHashes unions archived hashes), `packages/app-engine/src/conversation/archive/digest-parity.test.ts` (real InsightsStore: kpis/byAutomation/byModel identical before archive vs after prune), `packages/vault/src/conversation-archive-roots.test.ts` (archive sha is a GC root, stays a root after prune, missing-table guard), `packages/vault/src/blob/custody-proven.test.ts` (local-only presence; s3 replica gate; outbox row blocks even with a replica), `packages/gateway/src/serve/vault-plane-conversation-archival.test.ts` (daily block archives + prunes + rolls exactly one generation).

Wave 3 (lazy rehydration — read-only render of archived conversations):

```
bunx turbo run typecheck --filter=@centraid/vault --filter=@centraid/app-engine --filter=@centraid/gateway --filter=@centraid/client
  Tasks: 25 successful, 25 total
packages/app-engine conversation + http:      276 passed (17 files)
packages/gateway  vault-plane*:                 27 passed (3 files)
packages/client   gateway-client-conversation + assistantTranscript: 11 passed (2 files)
oxlint (12 changed source files):               0 warnings, 0 errors
```

Wave 3 rehydrate round-trip lives in `packages/app-engine/src/conversation/rehydrate.test.ts` (5 tests) and the client affordance in `packages/client/src/react/shell/routes/assistantTranscript.test.ts` (3 added tests).

Final whole-branch gate (all three waves together):

```
bun run ci                              → exit 0 (oxfmt, oxlint, turbo typecheck, lint:types, lint:css)
bunx turbo run test --concurrency=2 --force
  Tasks: 27 successful, 27 total       → exit 0
```

(The app-bundle pre-existing failure noted under Wave 1 did not reproduce in the final full run; one earlier full run hit a vault/mobile load flake that a clean isolated run — 87 files, 767 passed — and this final `--force` run both disprove.)

## Audit

**Check 1 — "What changed" faithfully describes the diff:** PASS. Whole-branch diff `git diff 08eb9d79` spans three waves (commits f567697e + b1dd2bf2 + uncommitted Wave 3) with 39 files changed, 3,465 insertions. Receipt enumerates: auto_vacuum pragma ordering + legacy conversion (packages/vault/src/db.ts), conversation_archive + conversation_digest schema DDL with governance waiver (packages/app-engine/src/stores/gateway-db.ts), eight archive engine modules (selector/segment/prune/engine/index/types + two test files in packages/app-engine/src/conversation/archive/), custody-gated prune (packages/vault/src/blob/custody-proven.ts + prune.ts), GC roots unioned into vault/gateway reconciliation (packages/vault/src/conversation-archive-roots.ts + vault-plane.ts integration), lazy rehydration path (packages/app-engine/src/conversation/rehydrate.ts + rehydrate.test.ts), client surface markers (packages/client/*), and Insights union logic (insights-store.ts). Spot-reads confirm: db.ts sets PRAGMA auto_vacuum = INCREMENTAL before WAL with legacy freelist → VACUUM conversion; gateway-db.ts defines both conversation_archive and conversation_digest tables with governance waiver on schema band; insights-store.ts header documents the union of live run_summary with conversation_digest rollups across kpis/appsTouched/daily/byAutomation/byModel. No omissions.

**Check 2 — All 7 checked items realized in diff:** PASS. Receipt's checklist (all seven marked [x]) are fully implemented: (1) auto_vacuum INCREMENTAL pragma set first (before WAL), legacy freelist migration via VACUUM on reopen; (2) conversation_digest materialized table DDL + Insights union logic across five aggregates; (3) archive serializer modules (selector for idle ranges, segment for gzip(JSON) sealing through blob door, prune for raw-row DELETE behind custodyProven latch); (4) conversation_archive index table (conversation_id + seq_from composite, sha index, unpruned partial index) with GC roots reachability exported and unioned into backup-cas-reconciliation/backup-reconciliation/backup-sources/gateway.ts; (5) custody-gated prune + incremental_vacuum (prune.ts executes DELETE only after blobCustodyProven(sha) latch, reclaimJournalPages mirrors the pattern); (6) lazy rehydration (rehydrate.ts fetches archived blob, gunzips, parses, re-maps rows through turnFromRaw/itemFromRaw/attachmentFromRaw, returns SessionTranscript with fromArchive markers + archiveUnavailable fallback); (7) test coverage (archive.test.ts prune-before-custody impossible across runs, digest-parity.test.ts rolls before/after archive, rehydrate.test.ts round-trip byte-equal + unavailable reader, assistantTranscript.test.ts surface marks + read-only affordance, custody-proven.test.ts local/s3 gates, conversation-archive-roots.test.ts GC root lifecycle, vault-plane-conversation-archival.test.ts daily block generation roll).

**Check 3 — Checklist mirrors issue:** PASS. Receipt's seven-item checklist (all [x]) exactly matches issue #438's `## Checklist` section verbatim, including all wording and item order.

## Steering

**Check 1 — Every human-steering event recorded (or zero stated explicitly):** PASS. Session transcript (`b10ad6d8-505e-4365-920b-2e2d106dc673.jsonl`, 643 events) started 2026-07-17T13:37:48.517Z with a single `/goal` command: "please work on the entire scope of https://github.com/srikanth235/centraid/issues/438 and create PR. act as orchestrator and spawn opus subagents". That single user directive is the entry point, not a steering event (steering would be mid-task corrections/redirects). The 15 distinct promptIds in the transcript represent the orchestrator (promptId 56f91446) and 14 spawned subagents (via `Agent()` tool); no mid-task interrupts ("[Request interrupted") or user corrections found. Session ran autonomously from 13:37:48 to 15:16:59 (97.5 minutes) with no user redirection. **Zero steering events; none to record.**

**Check 2 — No non-steering message recorded as steering:** PASS. The Accounting table contains only cost rows (no steering section), correctly reflecting zero steering events. No false positives.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-b10ad6d8-505-1784297195-1 | claude-code | b10ad6d8-505e-4365-920b-2e2d106dc673 | #438 | claude-fable-5 | 413 | 440270 | 17990021 | 118737 | 559420 | 29.4344 | 413 | 440270 | 17990021 | 118737 | feat(ledger): auto_vacuum=INCREMENTAL + digest/archive cold-state schema + insig |
| claude-code-b10ad6d8-505-1784297399-1 | claude-code | b10ad6d8-505e-4365-920b-2e2d106dc673 | #438 | claude-fable-5 | 12 | 21606 | 1013994 | 7425 | 29043 | 1.6554 | 425 | 461876 | 19004015 | 126162 | feat(ledger): auto_vacuum=INCREMENTAL + digest/archive cold-state schema + insig |
| claude-code-b10ad6d8-505-1784299254-1 | claude-code | b10ad6d8-505e-4365-920b-2e2d106dc673 | #438 | claude-fable-5 | 66 | 43084 | 6014902 | 19829 | 62979 | 7.5456 | 491 | 504960 | 25018917 | 145991 | feat(ledger): conversation archival engine — segments, GC roots, custody-gated p |
| claude-code-b10ad6d8-505-1784299299-1 | claude-code | b10ad6d8-505e-4365-920b-2e2d106dc673 | #438 | claude-fable-5 | 6 | 11499 | 584469 | 1647 | 13152 | 0.8106 | 497 | 516459 | 25603386 | 147638 | feat(ledger): conversation archival engine — segments, GC roots, custody-gated p |
| claude-code-b10ad6d8-505-1784299357-1 | claude-code | b10ad6d8-505e-4365-920b-2e2d106dc673 | #438 | claude-fable-5 | 4 | 1070 | 398207 | 370 | 1444 | 0.4301 | 501 | 517529 | 26001593 | 148008 | feat(ledger): conversation archival engine — segments, GC roots, custody-gated p |
| claude-code-b10ad6d8-505-1784299406-1 | claude-code | b10ad6d8-505e-4365-920b-2e2d106dc673 | #438 | claude-fable-5 | 8 | 5936 | 800618 | 2439 | 8383 | 0.9968 | 509 | 523465 | 26802211 | 150447 | feat(ledger): conversation archival engine — segments, GC roots, custody-gated p |
| claude-code-b10ad6d8-505-1784301694-1 | claude-code | b10ad6d8-505e-4365-920b-2e2d106dc673 | #438 | claude-fable-5 | 146 | 86709 | 15934240 | 23459 | 110314 | 18.1925 | 655 | 610174 | 42736451 | 173906 | feat(ledger): lazy rehydration — read-only render of archived conversations (#43 |
| claude-code-b10ad6d8-505-1784301734-1 | claude-code | b10ad6d8-505e-4365-920b-2e2d106dc673 | #438 | claude-fable-5 | 2 | 931 | 235641 | 212 | 1145 | 0.2579 | 657 | 611105 | 42972092 | 174118 | feat(ledger): lazy rehydration — read-only render of archived conversations (#43 |
| claude-code-b10ad6d8-505-1784301900-1 | claude-code | b10ad6d8-505e-4365-920b-2e2d106dc673 | #438 | claude-fable-5 | 44 | 21572 | 5340178 | 12411 | 34027 | 6.2308 | 701 | 632677 | 48312270 | 186529 | feat(ledger): lazy rehydration — read-only render of archived conversations (#43 |
