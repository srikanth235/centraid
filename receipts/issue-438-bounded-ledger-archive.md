# Receipt — Issue #438: Bounded ledger: digest → archive idle conversations to cas → custody-gated prune

Issue: https://github.com/srikanth235/centraid/issues/438

## Checklist

- [x] Verify auto_vacuum mode on vault.db + journal.db; migrate to INCREMENTAL if NONE
- [x] conversation_digest materialized table + Insights/list reads move from run_summary VIEW to digests
- [ ] Conversation archive serializer (sealed blob per idle conversation through the blob door)
- [ ] conversation_archive index table; archive references added as CAS GC roots (shared rule with the snapshot-pinning invariant)
- [ ] Custody-gated prune + incremental_vacuum in the bounded maintenance pass
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
