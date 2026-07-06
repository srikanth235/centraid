# Receipt — issue #308: audit follow-ups — consent gaps in the outbox + install-grant flip, grounding drift in the assistant/builder

GitHub issue: https://github.com/srikanth235/centraid/issues/308
Gap-closing pass over **#306** (consent for a market of one) and **#304** (broker OAuth) —
the same relationship to #306 that #298 had to #293. Two root causes closed: risk→salience
shrank the park set further than intended (Part A), and the model grounding never followed
the write-path rewrite (Part B).

## Checklist (issue parts)

- [x] **A1 — confirm-gate the credential-touching commands**: `sync.configure_credential`
      and `sync.store_tokens` carry `confirm: true`; a non-owner (the `_assistant`'s
      all-schema grant included) proposing either PARKS. The broker's ceremony/refresh and
      the connections routes ride the owner plane and never park — no legitimate path
      changed. Stale "an agent proposing it parks" docstrings corrected everywhere the flip
      falsified them (`sync.ts`, `assistant-context.ts` park annotation).
- [x] **A2 — the sweep**: every medium/high-risk command's park status decided and recorded
      (table below).
- [x] **A3 — publish scope-widening parks**: the install-grant top-up auto-grants only the
      FIRST consent (no grant history). A manifest widening beyond the last owner consent
      opens a `consent_scope_request` (one open request per plane+app; re-publishes replace
      its scope set) surfaced in `GET /_vault/blocking` and decided via
      `POST /_vault/scope-requests/<id> {approve}` — approve mints exactly the asked scopes,
      deny tombstones them (no re-nag).
- [x] **A4 — owner narrowing is durable**: the revocation cascade writes one
      `consent_scope_tombstone` per revoked scope triple (receipted, `tombstoned` count in
      the detail); the top-up neither re-grants nor re-requests tombstoned triples; explicit
      owner approval clears them; uninstall wipes the memory (reinstall = fresh consent).
      Regression test: revoke → ensure ×2 → no re-mint, no request.
- [x] **A5 — artifact/request atomicity**: `outbox.decide` refuses an edit supplying only
      one half — approve-A-send-B is structurally closed.
- [x] **A6 — undo exists**: `knowledge.delete_note` → trash (30-day pair, edges kept, body
      released only when no live row rents it); new `knowledge.restore_note` restores row +
      placement + body; trashed notes are frozen and leave the FTS index; the lifecycle
      sweep purges lapsed notes before the content purge (FK order). v15 is a re-runnable
      v8-style rebuild re-arming the FTS triggers (v9 precedent).
- [x] **A7 — approvals expire**: new owner-plane `outbox.repark`; the executor reparks any
      approved item older than the staleness window (24h default, configurable) instead of
      draining — zero egress, fresh decision required, delay named in the note.
- [x] **A8 — bounded, cycle-free drains + retro-invalidation**: per-pass total cap (25) and
      per-actor cap (10), surplus deferred (never dropped, logged); data triggers REFUSE
      `outbox.*` entities at manifest validation (drain receipts can't re-fire the stager);
      `outbox.revoke_grant` reparks approved-but-undrained riders (postcondition-enforced;
      drained items stay history).
- [x] **B1 — builder grounding**: `build-extra-prompt.ts` gains an always-rendered
      external-world section (connection reads via `{{connection:…}}`/GET-only/host-pin,
      writes via `outbox.stage` with the artifact+request contract, least-scope manifests →
      A3 tie-in); the read-only-ceiling error names `outbox.stage` with the exact call shape.
- [x] **B2 — assistant grounding**: the prompt teaches stage→owner-approve ("say staged,
      never sent") and where connections live; SQL conventions gain the sync + outbox
      schemas.
- [x] **B3 — assistant grant written down + narrowable**: documented at the mint point; the
      self-heal respects A4 tombstones, so the owner can durably narrow the assistant
      (receipted deny, not silent re-mint) until an explicit re-approval.
- [x] **B4 — catalog invalidation**: app publish/install/delete and connection configure
      kick a tools re-warm for the active runner (fire-and-forget, warmer-deduped).
- [x] **B5 — connection health**: assistant conventions + prompt teach
      `sync_connection.status` / `sync_connection_health.auth_note` / `sync_connection_run`
      triage; sealed cells stay masked.
- [x] **B6 — lint steers to the outbox**: `no-raw-fetch` names `outbox.stage` as the
      external-write path and exempts `ctx.fetch` (the audited rail the rule steers toward —
      previously a false positive on every connector handler; `globalThis.fetch` etc. stay
      flagged).

## The A2 sweep — park decisions of record

`confirm: true` (parks for every non-owner): `social.send_message`, `business.send_invoice`,
`sync.publish_batch`, `sync.set_connection_trust`, `core.merge_party` (the #306 five), plus
**`sync.configure_credential`** and **`sync.store_tokens`** (this issue — A1/A2).

Deliberately open, with reasons:

| command | risk | decision |
|---|---|---|
| `sync.set_connection_status` | medium | open — the fire path's needs-auth honesty flip rides the agent plane and must land unparked; no status value moves credentials or hosts. Docstring corrected. |
| `outbox.decide` / `record_result` / `repark` / `revoke_grant` | medium/low | structurally owner-only in the handler — stronger than confirm. |
| `business.create_draft_invoice`, `business.mark_invoice_paid` | medium | internal, reversible bookkeeping (Tier 1). |
| `core.set_extracted_text` | medium | owner-terminal derived data (#299), reversible by re-run. |
| `finance.split_txn`, `health.void_vital`, `health.adjust_course` | medium | internal + reversible (void keeps the row; splits re-validate). |
| `schedule.propose_event` / `reschedule_event` / `cancel_event` | medium | internal calendar rows; external egress rides the outbox. |
| `social.draft_message` | medium | a draft is inert; release-to-send is the gated act. |
| `locker.purge_item` | medium | open-with-note: purge requires a prior trash (owner-visible window) and the Locker UI is the only caller today; revisit if an agent path to purge appears. |

Destructive-verb undo inventory (A6): documents, media assets, locker items already trash;
**notes** (the audit's example) gained trash+restore here. Left hard-delete deliberately:
notebooks/albums/folders/circles (pure curation — members survive, nothing orphans, per
#274's "entries are curation, not history"), tally rows (mutual ledger — deletion is itself
the correction act), ext-band rows (app-owned shape). Recorded, not forgotten.

## Verified intact (issue's "do not re-litigate" list)

`vault_sql` sealed masking, exact-triple standing grants, host-pin re-assertion on the
substituted URL, owner-only outbox decide/drain — all covered by existing tests that still
pass unchanged.

## Out-of-scope

- Re-introducing the risk-ceiling (issue non-goal): the fix was the correct confirm set.
- `ctx.blob` / `ctx.outbox` primitives (non-seam per the issue).
- Desktop UI renders of the new surfaces (scope-request card, note-trash affordance) — the
  routes and commands are complete; the shell work is a follow-up.
- Multi-party/sharing consent (dormant until the sharing design is filed).
- The three pre-existing `format:check` failures on files this change touched only
  incidentally (`runner.ts`, `connections-routes.ts`, `sync.test.ts` fail on main too);
  the 23 oxlint errors are main's recorded baseline, none added.

## Verification

```
bun run test        # full battery: 21/21 tasks green
bun run typecheck   # 21/21 green
bun run build       # green
bun run lint        # 23 errors = main's baseline (0 on changed files)
```

- `packages/vault`: 386/386 (new: confirm-gate parking for the credential pair + the
  deliberately-open flip; decide-edit atomicity; revoke→repark incl. drained-stays-sent;
  `outbox.repark` owner-gating; note trash/restore round-trip incl. frozen-verb refusals;
  sweep purge of lapsed notes with edges; links/cards tests moved to purge-path semantics;
  migration ladder replay green — v14 IF-NOT-EXISTS, v15 rebuild).
- `packages/gateway`: 195/196 (1 pre-existing skip) (new: widen→park→approve/deny,
  revoke→top-up→no-re-mint, uninstall reset, agent-plane mirror, assistant narrowing
  round-trip, assistant credential-grab parks; executor stale-repark, batch cap, per-actor
  cap).
- `packages/automation`: 218 (new: outbox data-trigger refusal; ctx.fetch lint exemption +
  outbox steer; read-only ceiling test passes with the new error text).
- `packages/app-engine`: 225 (external-world block always taught; vault-primitive teaching
  still scoped to declared access).
- `packages/blueprints`: 123 (notes library/search filter live rows).
