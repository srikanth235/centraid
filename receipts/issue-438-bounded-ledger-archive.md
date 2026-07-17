# Receipt — Issue #438: Bounded ledger: digest → archive idle conversations to cas → custody-gated prune

Issue: https://github.com/srikanth235/centraid/issues/438

## Checklist

- [x] Verify auto_vacuum mode on vault.db + journal.db; migrate to INCREMENTAL if NONE
- [x] conversation_digest materialized table + Insights/list reads move from run_summary VIEW to digests
- [x] Conversation archive serializer (sealed blob per idle conversation through the blob door)
- [x] conversation_archive index table; archive references added as CAS GC roots (shared rule with the snapshot-pinning invariant)
- [x] Custody-gated prune + incremental_vacuum in the bounded maintenance pass
- [ ] Lazy rehydration path (read-only render of archived conversations)
- [ ] Tests: prune-before-custody is impossible; digest parity with pre-archive rollups; rehydrate round-trip; vacuum reclaims pages

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

## Out of scope

- The audit band (consent/agent tables) — append-only forever; its #367 archival engine is untouched except doc-comment corrections.
- User-facing retention settings — internal constants only (five-metric discipline, #436 §6).
- True deletion of history — existing consent/delete paths remain the only deletion.
- automation_state and in-flight conversations/turns.
- Direct-to-IA storage-class extension for archive blobs (they ride the cas class as-is in v1).

## Decisions

None yet.

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

Wave 2 test files: `packages/app-engine/src/conversation/archive/archive.test.ts` (prune-before-custody impossible across repeated runs, then flips with custody and latches idempotently; segment round-trip byte-identical; incremental_vacuum drops page_count after prune; selector edges — live automation head and unfinished turns kept, pinned turns block/split ranges, non-idle chat untouched, in-flight retry protects its target, re-runs idempotent, automation_state untouched; referencedHashes unions archived hashes), `packages/app-engine/src/conversation/archive/digest-parity.test.ts` (real InsightsStore: kpis/byAutomation/byModel identical before archive vs after prune), `packages/vault/src/conversation-archive-roots.test.ts` (archive sha is a GC root, stays a root after prune, missing-table guard), `packages/vault/src/blob/custody-proven.test.ts` (local-only presence; s3 replica gate; outbox row blocks even with a replica), `packages/gateway/src/serve/vault-plane-conversation-archival.test.ts` (daily block archives + prunes + rolls exactly one generation).

## Audit

**Check 1 — "What changed" faithfully describes the diff:** PASS. Receipt exactly enumerates the eight file changes; spot-reads of `db.ts` (auto_vacuum ordering + legacy conversion), `gateway-db.ts` (pragma reordering + schema DDL + governance waiver), and `insights-store.ts` (live/digest union for kpis/appsTouched/daily/byAutomation/byModel + fresh kpisDigest/appsTouchedDigest statements) all align with the 812-insertion diff. No omissions.

**Check 2 — Checked items realized in diff:** PASS. Both `[x]` items (auto_vacuum mode verification and conversation_digest materialized table + Insights union) are fully implemented: `db.ts`/`gateway-db.ts` both set `PRAGMA auto_vacuum = INCREMENTAL` before WAL and run the legacy-file VACUUM conversion; two new tables and five digest-union aggregates appear in `gateway-db.ts` and `insights-store.ts`; test coverage confirms incremental mode and digest parity.

**Check 3 — Checklist mirrors issue:** PASS. Receipt's checklist (seven items, first two checked) is character-identical to the issue's `## Checklist` section.

## Steering

**Zero steering events.** Session started 2026-07-17T13:37:48Z with a single `/goal` command; transcript contains one genuine human-directed user message (the goal itself). 91 total "user" type events in the JSONL are system notifications, tool results, and subagent spawning—no interrupts ("[Request interrupted") or mid-task user corrections/redirects. Orchestrator spawned background agents (Opus analysis + Haiku subagent for attestation); work proceeded autonomously without user redirection. **No steering rows to record. PASS.**

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
