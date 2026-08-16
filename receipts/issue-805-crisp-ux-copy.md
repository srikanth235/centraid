# issue-805 — Crisp UX copy: rulebook, ratchet, shared seam, full audit

GitHub issue: [#805](https://github.com/srikanth235/centraid/issues/805)

One umbrella, one receipt, orchestrated slices. The app's copy was verbose in
one systemic way — state the fact, then reassure about what was NOT lost. This
umbrella lands the binding rulebook (DESIGN.md § Copy), a tighten-only
length/sentence/filler ratchet, one canonical home per shared string, and a
full audit of every user-facing string. Slices execute per
[docs/multi-agent.md](../docs/multi-agent.md): the root agent holds the plan
and cross-slice invariants; sub-agents work file-disjoint slices.

## Checklist

- [x] A — the rulebook
- [x] B — the ratchet
- [x] C — the shared copy seam
- [ ] D1 — audit: client shell + Settings + Onboarding
- [ ] D2 — audit: blueprints Photos
- [ ] D3 — audit: blueprints Docs + Notes + remaining apps
- [ ] D4 — audit: mobile screens + kit
- [ ] D5 — audit: server-surfaced strings + desktop/web/extension shells
- [ ] design-divergences register updated for any slice-kept divergence

## What changed

### Slice A — the rulebook (2026-08-16)

- `DESIGN.md` — new `## Copy` section between `## Components` and
  `## Responsive Behavior`: voice definition, per-surface budget table,
  reassurance placement rule, banned filler, four worked before/after pairs
  drawn from real strings. Copy guidance folded into `## Agent Prompt Guide`
  and `## Do's and Don'ts`; issue + ratchet paths added to References.
- `docs/decisions.md` — new `## Copy governance (#805)` section with rulings
  U-voice / U-ratchet / U-scope / U-reassurance / U-umbrella.
- `docs/glossary.md` — the "broader prose and dynamic copy remain judgment"
  concession now splits word choice (glossary) from length (DESIGN.md § Copy).
- `AGENTS.md` — umbrella bullet now states: one umbrella issue, no child
  issues — slices are sub-agents and PR waves under it, one receipt.
  (`CLAUDE.md` is a symlink to `AGENTS.md`.)
- `packages/design/src/design-md.test.ts` — canonical `##` section list gains
  `Copy` (the test pins DESIGN.md's section inventory).

### Slice B — the ratchet (2026-08-16)

- `tests/quality/user-facing-qualities.test.ts` — new U4 test: walks
  user-facing sources (`packages/client/src`, `packages/blueprints/apps`,
  `apps/mobile/src`, `apps/desktop/src`, `apps/web/src`, `apps/extension/src`,
  `packages/design/src` minus `roles.ts`, `packages/server/src/routes`),
  extracts prose string literals, and flags any that exceed ~120 chars,
  contain ≥ 2 sentences, or match the banned-filler regex. Stale allowlist
  entries are themselves violations, so seeds cannot outlive the copy they
  excuse.
- `tests/quality/copy-allowlist.json` — new `copyRatchet` key seeded with 255
  current offenders (D1 83 · D2 21 · D3 40 · D4 95 · D5 16), each with a
  slice-tagged reason; consent-surface seeds carry a consent reason so the
  disclosure survives its rewrite. Tighten-only: `maxEntries` in the JSON and
  a matching ceiling constant in the owning test both cap growth; audit
  slices lower them together as they drain seeds.

### Slice C — the shared copy seam (2026-08-16)

One canonical home per shared string, on the `home-copy.ts` precedent. 10
modules, 60 promoted constants; 21 strings rewritten to budget in the same
move, ~25 kept byte-identical (already compliant), 40 allowlist seeds drained
(`maxEntries` 255 → 216, in-test ceiling lowered to match, 1 real
destructive-confirm entry added for the Approvals deny sheet).

- `packages/client/src` gains nine copy modules, exported as package
  subpaths in `packages/client/package.json`: `surface-copy.ts` (the
  ops-state words all six operational pages share), `approvals-copy.ts`,
  `automations-copy.ts`, `connectors-copy.ts`, `data-copy.ts`,
  `devices-copy.ts`, `insights-copy.ts`, `notifications-copy.ts`,
  `sharing-copy.ts`. Client call sites re-point: `routeVitals.ts`,
  `approvalsData.ts`, `notifications-model.ts`, `gateway-client-push.ts`,
  `insights-model.ts`, `App.tsx`, and screens `ApprovalsScreen.tsx`,
  `AtlasScreen.tsx`, `AtlasKindsSection.tsx`,
  `AutomationsOverviewScreen.tsx`, `HouseholdScreen.tsx`,
  `InsightsScreen.tsx`, `LinkRow.tsx`, `SettingsConnectionsScreen.tsx`,
  `SharingCard.tsx`, `SharingRecoveryRows.tsx`, routes
  `ApprovalsRoute.tsx`, `InsightsRoute.tsx`, `SettingsRoute.tsx`.
- The drifted `App.tsx`/`SettingsRoute.tsx` near-twin is now one
  `forgetDeviceMessage(surface)` in `devices-copy.ts` — full sentences kept:
  destructive confirm, the one home the rulebook gives reassurance.
- `packages/blueprints`: `apps/photos/shared-copy.ts` extended (11
  constants); new `apps/_shared/shared-copy.ts` (cross-app machinery copy)
  and `pendingChangeLabel()` in `apps/_shared/pending-overlay.ts`.
  Blueprint call sites re-point: `apps/photos/view-copy.ts`, `viewer.ts`,
  `components/Editor.tsx`, `components/FaceReview.tsx`,
  `components/Lightbox.tsx`, `components/PlaceMap.tsx`,
  `components/Timeline.tsx`, `apps/docs/app-root.tsx`,
  `apps/docs/components/Details.tsx`, `apps/locker/app-root.tsx`,
  `apps/_shared/PendingWriteActions.tsx`, `apps/_shared/ShareSheet.tsx`.
- Mobile imports the constants the way it already imports `home-copy`
  (package subpaths; deep path for blueprints, which has no exports map).
  Re-pointed: `apps/mobile/src/screens/approvals/approvals-model.ts`,
  `screens/connectors/connectors-model.ts`, `screens/connectors/Connectors.tsx`,
  `screens/data/Data.tsx`, `screens/devices/Devices.tsx`,
  `screens/Sharing.tsx`, `screens/SharingLinkRow.tsx`,
  `apps/automations/automations-model.ts`, `apps/automations/Automations.tsx`,
  `apps/insights/insights-model.ts`, `apps/insights/Insights.tsx`,
  `apps/photos/AlbumDetail.tsx`, `apps/photos/DuplicatesShelf.tsx`,
  `apps/photos/FaceReview.tsx`, `apps/photos/PhotoLightbox.tsx`,
  `apps/photos/PhotoStateView.tsx`, `apps/photos/PhotosSearch.tsx`,
  `apps/photos/photo-edit-model.ts`, `apps/photos/places-model.ts`,
  `apps/photos/tile-overlays.ts`, `apps/photos/viewer-model.ts`,
  `apps/docs/DocsHome.tsx`, `apps/docs/DocumentViewer.tsx`,
  `apps/locker/LockerHome.tsx`, `kit/replica/PendingRowStatus.tsx`,
  `kit/share/ShareSheet.tsx`, `lib/notification-model.ts`,
  `lib/notifications-plan.ts`.
- Pinned-copy tests updated in the same move:
  `packages/client/src/react/screens/ApprovalsScreen.test.tsx`,
  `AtlasScreen.test.tsx`, `AutomationsOverviewScreen.test.tsx`,
  `HouseholdScreen.test.tsx`, `SettingsConnectionsScreen.test.tsx`,
  `packages/client/src/react/shell/routeVitals.test.ts`,
  `routes/ApprovalsRoute.test.tsx`, `routes/InsightsRoute.test.tsx`,
  `routes/approvalsData.test.ts`, `packages/blueprints/src/one-computation.test.ts`
  (LEGACY_COLLISIONS ratchet tightened 16 → 14),
  `apps/mobile/src/screens/approvals/Approvals.test.tsx`,
  `approvals-model.test.ts`, `screens/connectors/Connectors.test.tsx`,
  `connectors-model.test.ts`, `apps/automations/Automations.test.tsx`,
  `automations-model.test.ts`, `apps/insights/Insights.test.tsx`,
  `insights-model.health.test.ts`, `apps/photos/photo-edit-model.test.ts`,
  `kit/components/HealthLine.test.tsx`.
- Ratchet bookkeeping: `tests/quality/copy-allowlist.json` (−40 seeds, +1
  reasoned entry) and `tests/quality/user-facing-qualities.test.ts` (ceiling).

### Slice C file inventory

Every file the slice touched (generated from the diff):

```
apps/mobile/src/apps/automations/Automations.test.tsx
apps/mobile/src/apps/automations/Automations.tsx
apps/mobile/src/apps/automations/automations-model.test.ts
apps/mobile/src/apps/automations/automations-model.ts
apps/mobile/src/apps/docs/DocsHome.tsx
apps/mobile/src/apps/docs/DocumentViewer.tsx
apps/mobile/src/apps/insights/Insights.test.tsx
apps/mobile/src/apps/insights/Insights.tsx
apps/mobile/src/apps/insights/insights-model.health.test.ts
apps/mobile/src/apps/insights/insights-model.ts
apps/mobile/src/apps/locker/LockerHome.tsx
apps/mobile/src/apps/photos/AlbumDetail.tsx
apps/mobile/src/apps/photos/DuplicatesShelf.tsx
apps/mobile/src/apps/photos/FaceReview.tsx
apps/mobile/src/apps/photos/PhotoLightbox.tsx
apps/mobile/src/apps/photos/PhotoStateView.tsx
apps/mobile/src/apps/photos/PhotosSearch.tsx
apps/mobile/src/apps/photos/photo-edit-model.test.ts
apps/mobile/src/apps/photos/photo-edit-model.ts
apps/mobile/src/apps/photos/places-model.ts
apps/mobile/src/apps/photos/tile-overlays.ts
apps/mobile/src/apps/photos/viewer-model.ts
apps/mobile/src/kit/components/HealthLine.test.tsx
apps/mobile/src/kit/replica/PendingRowStatus.tsx
apps/mobile/src/kit/share/ShareSheet.tsx
apps/mobile/src/lib/notification-model.ts
apps/mobile/src/lib/notifications-plan.ts
apps/mobile/src/screens/Sharing.tsx
apps/mobile/src/screens/SharingLinkRow.tsx
apps/mobile/src/screens/approvals/Approvals.test.tsx
apps/mobile/src/screens/approvals/approvals-model.test.ts
apps/mobile/src/screens/approvals/approvals-model.ts
apps/mobile/src/screens/connectors/Connectors.test.tsx
apps/mobile/src/screens/connectors/Connectors.tsx
apps/mobile/src/screens/connectors/connectors-model.test.ts
apps/mobile/src/screens/connectors/connectors-model.ts
apps/mobile/src/screens/data/Data.tsx
apps/mobile/src/screens/devices/Devices.tsx
packages/blueprints/apps/_shared/PendingWriteActions.tsx
packages/blueprints/apps/_shared/ShareSheet.tsx
packages/blueprints/apps/_shared/pending-overlay.ts
packages/blueprints/apps/_shared/shared-copy.ts
packages/blueprints/apps/docs/app-root.tsx
packages/blueprints/apps/docs/components/Details.tsx
packages/blueprints/apps/locker/app-root.tsx
packages/blueprints/apps/photos/components/Editor.tsx
packages/blueprints/apps/photos/components/FaceReview.tsx
packages/blueprints/apps/photos/components/Lightbox.tsx
packages/blueprints/apps/photos/components/PlaceMap.tsx
packages/blueprints/apps/photos/components/Timeline.tsx
packages/blueprints/apps/photos/shared-copy.ts
packages/blueprints/apps/photos/view-copy.ts
packages/blueprints/apps/photos/viewer.ts
packages/blueprints/src/one-computation.test.ts
packages/client/package.json
packages/client/src/approvals-copy.ts
packages/client/src/automations-copy.ts
packages/client/src/connectors-copy.ts
packages/client/src/data-copy.ts
packages/client/src/devices-copy.ts
packages/client/src/gateway-client-push.ts
packages/client/src/insights-copy.ts
packages/client/src/notifications-copy.ts
packages/client/src/notifications-model.ts
packages/client/src/react/screens/ApprovalsScreen.test.tsx
packages/client/src/react/screens/ApprovalsScreen.tsx
packages/client/src/react/screens/AtlasKindsSection.tsx
packages/client/src/react/screens/AtlasScreen.test.tsx
packages/client/src/react/screens/AtlasScreen.tsx
packages/client/src/react/screens/AutomationsOverviewScreen.test.tsx
packages/client/src/react/screens/AutomationsOverviewScreen.tsx
packages/client/src/react/screens/HouseholdScreen.test.tsx
packages/client/src/react/screens/HouseholdScreen.tsx
packages/client/src/react/screens/InsightsScreen.tsx
packages/client/src/react/screens/LinkRow.tsx
packages/client/src/react/screens/SettingsConnectionsScreen.test.tsx
packages/client/src/react/screens/SettingsConnectionsScreen.tsx
packages/client/src/react/screens/SharingCard.tsx
packages/client/src/react/screens/SharingRecoveryRows.tsx
packages/client/src/react/screens/insights-model.ts
packages/client/src/react/shell/App.tsx
packages/client/src/react/shell/routeVitals.test.ts
packages/client/src/react/shell/routeVitals.ts
packages/client/src/react/shell/routes/ApprovalsRoute.test.tsx
packages/client/src/react/shell/routes/ApprovalsRoute.tsx
packages/client/src/react/shell/routes/InsightsRoute.test.tsx
packages/client/src/react/shell/routes/InsightsRoute.tsx
packages/client/src/react/shell/routes/SettingsRoute.tsx
packages/client/src/react/shell/routes/approvalsData.test.ts
packages/client/src/react/shell/routes/approvalsData.ts
packages/client/src/sharing-copy.ts
packages/client/src/surface-copy.ts
tests/quality/copy-allowlist.json
tests/quality/user-facing-qualities.test.ts
```

## Decisions

- The U4 scanner skips template literals containing `${…}` — a spliced value
  cannot be length-judged from source. Interpolated verbose strings are still
  caught by the audit slices (judgment pass), just not mechanically.
- `packages/server/src` is walked only at `src/routes/**` — the route layer is
  where the gateway mints strings the shell renders verbatim. The rest of the
  server tree (engine, automation, acp, serve, cli, …) is logs, protocol and
  internal diagnostics this literal-level walk cannot distinguish from
  member-facing copy; widening would trade precision for noise. Boundary
  stated here per issue B3.
- U4 is not registered as a `tests/matrix.json` gate in this wave: the A1
  gate-registry test validates declared gates but does not require every test
  to declare one, and registering would ripple into
  `classification-ratchet.json` fingerprints. Can be promoted later without
  changing the test's behavior.
- `packages/design/src/roles.ts` token rationales are developer-facing
  (per the issue's non-goals) and excluded from the walk.
- Slice C left five twin groups in place as not-UI: the change-feed HTTP
  error, the intent-store reuse invariant, the replica indexed-column
  invariant, the `ReplicaProtocolError` message + intent reason code, and
  the harness preflight text — replica-protocol and harness plumbing
  vocabulary, not screen copy. The `"s columns: SPEND per day…"` inventory
  item is a doc-comment fragment, a false twin.
- Slice C found one pre-existing failure unrelated to copy:
  `apps/mobile/src/apps/tally/PendingRestartJourney.test.tsx` cannot bundle
  `node:sqlite`; it fails identically on the base tree.

## Out of scope

Per the issue's non-goals: no i18n framework, no new lint infrastructure, no
churn on compliant strings, no tone flattening of consent/destructive/security
copy, no copy changes to developer-facing prose.

## Verification

Slice A + B (root re-ran after integration):

```sh
bun run lint:design-md               # errors: 0 (87 pre-existing orphaned-token warnings)
bunx vitest run packages/design/src/design-md.test.ts   # 15 passed
bun run test:qualities               # 24 passed, incl. new U4 (green, seeded)
bunx tsc -p tests                    # clean
```

Demonstrated red for U4: appending a >120-char two-sentence "Please…" string
to `packages/client/src/home-copy.ts` fails U4 with
`unallowed length+sentences+filler …`; suffixing an allowlist literal fails
with `stale … (no longer in the source)`. Both reverted.

Slice C:

```sh
bun run test:qualities                          # 24 passed (U4 green at 216)
bunx turbo run typecheck --filter=@centraid/client --filter=@centraid/blueprints  # 14/14
cd apps/mobile && bun run typecheck && bun run lint   # clean
bun run lint && bun run format:check            # clean
# package-filtered vitest green for client, blueprints, mobile (norms: no full
# suite mid-orchestration); the one failure is the pre-existing node:sqlite
# bundling break in PendingRestartJourney.test.tsx, identical on base.
```

## Audit counts (workstream D contract)

Per-slice audited / rewritten / allowlisted counts land here as D slices
complete.

| Slice | Audited | Rewritten | Allowlisted (reason) |
| --- | --- | --- | --- |
| D1 | — | — | — |
| D2 | — | — | — |
| D3 | — | — | — |
| D4 | — | — | — |
| D5 | — | — | — |

## Audit

Slice A and B (rulebook and ratchet) verified by an independent fresh-context
sub-agent against `git diff --cached`, this receipt, and issue #805. All three
audit criteria pass.

### 1. "What changed" describes the diff faithfully — **PASS**

Slice A files present:

```sh
git diff --cached --stat | grep -E "AGENTS.md|DESIGN.md|decisions.md|glossary.md|design-md.test.ts"
# AGENTS.md 2 ± · DESIGN.md 45 ± · docs/decisions.md +14 · docs/glossary.md 2 ±
# packages/design/src/design-md.test.ts +1
```

- DESIGN.md: Copy section present between Components and Responsive Behavior;
  budget table, reassurance rule, banned-filler list, and 4 worked pairs
  verified.
- docs/decisions.md: Copy governance section with 5 U-rulings verified.
- docs/glossary.md: concession split — judgment on **word choice**, not on
  **length** — cross-linked to DESIGN.md § Copy.
- AGENTS.md: umbrella bullet carries the one-issue/no-child-issues sentence.
- design-md.test.ts: Copy added to the canonical section list.

Slice B files present; seed breakdown re-measured from the staged tree:

```sh
git diff --cached tests/quality/copy-allowlist.json | grep '"reason":' | grep -o 'D[1-5]' | sort | uniq -c
#  83 D1 · 21 D2 · 40 D3 · 95 D4 · 16 D5   (total 255 — matches receipt)
```

U4 walks the COPY_SCOPE paths, flags >120 chars / ≥2 sentences / banned
filler, prunes stale entries, and caps growth via maxEntries + in-test
ceiling.

### 2. Each `[x]` Checklist item is realized in the diff — **PASS**

A (rulebook): all five components present as described. B (ratchet): U4 test +
255 slice-tagged seeds + tighten-only ceiling + stale-entry detection
verified.

### 3. Checklist mirrors the issue's checklist — **PASS**

Issue #805 execution-order checkboxes map to the receipt checklist: A and B
checked; C and D1–D5 unchecked as expected for the first wave; the
design-divergences item mirrors the issue's final checkbox.

## Session

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-16 | claude-code | dbac2544-ca99-517e-8544-865eb760845c |
