# Receipt — issue #552: Approvals Recent activity legibility

GitHub issue: [#552](https://github.com/srikanth235/centraid/issues/552)

Bring the Approvals **Recent activity** feed up to the legibility of Outbox/Parked rows: decision badge/icon/accent, risk rail, actor KindBadge, standing-grant attribution + revoke, humanized verbs, adjacent collapse, expand/filter/see-all.

## Checklist

- [x] Each activity row renders its `decision` as a distinct badge + icon + accent
- [x] Non-null `risk` renders a left-rail salience marker; `risk: null` shows none
- [x] Detail shows `objectType · truncated objectId` when present; full id in expanded panel
- [x] Actor display name + App/Automation/Assistant KindBadge; wire carries refined `actorKind`
- [x] Standing-grant rows say so and offer inline Revoke (`onRevokeGrant`); owner-approved rows say so
- [x] Relative time remains visible; absolute time via `title` and expanded detail
- [x] Unmapped verbs sentence-case English; Locker reveal/fill copy unchanged
- [x] Adjacent same verb+object+decision collapse with `×N`; non-adjacent do not
- [x] Expandable rows; Denied-only / All filter; "See all" raises in-place cap
- [x] `context` stays `{ kind: 'fill'; origin }` only — no secret/artifact bodies
- [x] Unit tests for mapping helpers + screen cases; gateway review feed widening
- [x] Receipt written; Conventional Commit with `(#552)`

## What changed

Each activity row renders its `decision` as a distinct badge + icon + accent.
Non-null `risk` renders a left-rail salience marker; `risk: null` shows none.
Detail shows `objectType · truncated objectId` when present; full id in expanded panel.
Actor display name + App/Automation/Assistant KindBadge; wire carries refined `actorKind`.
Standing-grant rows say so and offer inline Revoke (`onRevokeGrant`); owner-approved rows say so.
Relative time remains visible; absolute time via `title` and expanded detail.
Unmapped verbs sentence-case English; Locker reveal/fill copy unchanged.
Adjacent same verb+object+decision collapse with `×N`; non-adjacent do not.
Expandable rows; Denied-only / All filter; "See all" raises in-place cap.
`context` stays `{ kind: 'fill'; origin }` only — no secret/artifact bodies.
Unit tests for mapping helpers + screen cases; gateway review feed widening.
Receipt written; Conventional Commit with `(#552)`.

### Gateway / wire (`ReviewEntry`)

- `packages/gateway/src/serve/vault-plane.ts` — `ReviewEntry` gains `actorKind`, `actor`, `grantId`. `reviewFeed` resolves actor kind via table membership + existing `refineActorKind`/`actorName`, and extracts standing outbox `grantId` from receipt `detail_json` output / outbox item writes.
- `packages/client/src/gateway-client-outbox.ts` — client `ReviewEntry` mirrors the widened wire (`actorKind`, `actor`, `grantId`).
- `packages/gateway/src/serve/outbox-executor.test.ts` — null-actor reveal fields + standing-grant `grantId` / `actorKind` coverage on the review feed.

### Client data helpers

- `packages/client/src/react/shell/routes/approvalsData.ts` — `humanizeActivityLabel`, `formatActivityDetail`, `truncateObjectId`, extended `buildActivityRow` (risk, actor, grant attribution, absolute `occurredAt`, object fields), `collapseAdjacentActivity`.
- `packages/client/src/react/shell/routes/approvalsData.test.ts` — pure mapping tests for humanize, detail, collapse adjacent vs non-adjacent, grant vs owner attribution, null actor.
- Pure mapping only; collapse is adjacency-based (no time window).

### Approvals screen UI

- `packages/client/src/react/screens/ApprovalsScreen.tsx` — decision badge/icon/accent, risk marker, actor KindBadge, grant/owner attribution + Revoke grant, expand detail with full object id and absolute time, Denied/All filter, See all. Decision accent CSS-module classes coerced for `noUncheckedIndexedAccess` (web typecheck).
- `packages/client/src/react/screens/ApprovalsScreen.module.css` — decision accents, risk rail, `×N` marker, filter chips, attribution copy.
- `packages/client/src/react/screens/ApprovalsScreen.test.tsx` — decision badge, risk present/absent, actor KindBadge per kind, standing-grant revoke click, collapse marker, filter/expand/see-all.
- `packages/client/src/react/shell/routes/ApprovalsRoute.tsx` — review limit 20 → 200 on See all; `collapseAdjacentActivity` after map; wires `onSeeAllActivity` / `activityTruncated`.

## Out of scope

- Redesign of Outbox / Parked / Needs-auth / Scope / Standing-grants sections beyond reusing KindBadge and `onRevokeGrant`.
- Dedicated full-history audit-log screen (See all = in-place higher cap only).
- Changing which receipts the vault writes or re-ranking risk salience.
- Mobile Insights activity list.

## Decisions

- **Adjacency-only collapse** (no fixed time window) — matches the issue screenshot of consecutive duplicates and avoids hiding a meaningful gap between non-adjacent repeats.
- **See all = raise in-place cap** (20 → 200), not a dedicated audit-log screen — issue open question resolved per plan non-goal.
- **Standing `grantId` from outbox stage/decide output** (and outbox_item fallback), not `consent_receipt.grant_id` — the latter is consent.access_grant and cannot drive Standing-grants Revoke.
- **Actor display name joined on the review path** via the existing single-row `actorName` lookup (same as outbox) — not deferred; cost is one prepared query per actor id.
- **Owner attribution** for every allow without a standing outbox grant — simpler binary than trying to distinguish Tier-1 auto-consent from explicit owner approve; only grant-backed rows offer Revoke.

## Verification

```sh
bun run --filter @centraid/client test -- src/react/shell/routes/approvalsData.test.ts src/react/screens/ApprovalsScreen.test.tsx
bun run --filter @centraid/gateway test -- src/serve/outbox-executor.test.ts
bun run check:pr
```

Manual (when a local gateway is available): approve / deny / auto-grant and confirm the three activity rows read differently; Revoke from an auto-allowed row removes the standing grant above.

## Audit

Fresh-context sub-agent (session `019fa1fe-fbad-7571-b288-30f2f1a12de6`). Ground truth: working tree on branch `feat/approvals-recent-activity-552` vs receipt + `gh issue view 552` (issue body from session artifact). Touched surfaces: `vault-plane.ts` ReviewEntry/`reviewFeed`, `gateway-client-outbox.ts` ReviewEntry, `approvalsData.ts`(+test), `ApprovalsScreen.tsx`(+module.css,+test), `ApprovalsRoute.tsx`, `outbox-executor.test.ts`, this receipt.

**Check 1 — What changed faithfully describes the diff**
PASS – Every What-changed bullet maps to real code: gateway `ReviewEntry` gains `actorKind`/`actor`/`grantId` and `reviewFeed` resolves them via `refineActorKind`/`actorName` plus grant extraction from `detail_json` output / outbox_item (`vault-plane.ts` ~1324–1434); client `ReviewEntry` mirrors the same three fields (`gateway-client-outbox.ts` 161–184); helpers `humanizeActivityLabel` / `formatActivityDetail` / `truncateObjectId` / extended `buildActivityRow` / `collapseAdjacentActivity` (adjacency-only) live in `approvalsData.ts`; UI decision badge/icon/accent, risk marker, KindBadge, grant/owner attribution + Revoke grant, expand/filter/See all land in `ApprovalsScreen.tsx` + CSS; route raises review limit 20→200 and collapses after map (`ApprovalsRoute.tsx` 26–28, 184–205); gateway tests cover null-actor reveal fields and standing-grant `grantId`/`actorKind` (`outbox-executor.test.ts` 376–491). No phantom files or claims of unrelated surfaces.

**Check 2 — All checked checklist items are realized in the diff**
PASS – Each `[x]` item has concrete realization: decision badge/icon/accent (`activityDecisionVisual` + `decisionBadge`/`activityIcon`/accent classes); risk rail only when non-null (`riskMarker` gated on `row.risk`); detail `objectType · truncated objectId` + full id in expand; actor name + App/Automation/Assistant KindBadge via `outboxKindBadge`; grant/owner attribution + `onRevokeGrant`; relative `occurredAgo` + absolute via `title`/`formatAbsoluteTime`; humanize + Locker specials unchanged; adjacent collapse `×N` / non-adjacent leave separate; expand + Denied/All filter + See all; `context` remains `{ kind: 'fill'; origin }` only on wire/DTO; unit tests in `approvalsData.test.ts` + `ApprovalsScreen.test.tsx` + gateway review-feed widening; this receipt is present for the Conventional Commit `(#552)` closeout.

**Check 3 — Checklist mirrors the issue**
PASS – Checklist is a 1:1 restatement of issue #552 acceptance criteria (decision badge/icon/accent; risk marker null-safe; objectId truncated + full in expand; actor KindBadge + refined `actorKind`; standing-grant copy + Revoke / owner-approved copy; relative+absolute time; humanize + Locker copy; adjacent collapse only; expand/filter/See all; no secret bodies in `context`) plus the issue’s validation slice (client mapping/screen tests, gateway `ReviewEntry` widening including null actor) and receipt/commit process. Out of scope / Decisions match the issue’s Out + open questions (adjacency-only collapse; See all = in-place cap not audit screen; grantId from outbox not consent_receipt).

## Steering

**Check 1 — Every human-steering event is recorded in ### Steering under ## Accounting**
PASS – Session `019fa1fe-fbad-7571-b288-30f2f1a12de6` has a single human-authored goal (pre-authorized plan: work #552, open PR, green CI). No mid-task user interrupts, redirects, or corrections appear in `chat_history.jsonl` after the initial goal (remaining `user` entries are system-reminder / harness injection). No ### Steering table is required when no steering events occurred; Accounting is left to hooks.

**Check 2 — No non-steering message is recorded as a steering event**
PASS – Receipt records no fabricated steering rows. Ordinary agent progress, tool results, and externalEditOnAgentFile hunks are not treated as human steering.
