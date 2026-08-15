# Issue #776 — Track B: ShareSheet person quick-add

Track B is the ShareSheet quick-add slice of umbrella issue #776. Track A,
the machine-migration kit, remains out of scope and is not claimed here.

## User impact

From the web/desktop and mobile ShareSheets, a user can add someone who is not
yet in People, select that settled person, and share in one flow. The new
person is the ordinary People identity and profile, while near-name matches
ask before minting another identity and offline/pending rows remain ineligible
for submission.

First-run: onboarding and the initial home are unchanged. The existing desktop
first-run harness emits the evidence image below; quick-add is a post-onboarding
ShareSheet surface covered by the focused real-React and mobile tests.

![Unchanged desktop first-run shell for the ShareSheet quick-add change](artifacts/e2e/ui-impact/issue-776-sharesheet-quick-add.png)

## Checklist

- [x] From the ShareSheet on both the web/desktop and mobile seats, a user can add a person not in People and select them as a member in one flow
- [x] The created person is a normal core_party (kind=person) + people_profile visible in the People app with no duplicate mechanism; cadence_days defaults without asking the user (B2)
- [x] The write does not require widening Photos/Docs/Tally consent grants, or the widening is explicit, minimal, documented, and argued in the receipt (Q2)
- [x] selectedShareMembers semantics unchanged: no synthetic vault id minted for the invitation target; the destination id is party:<partyId>
- [x] A share can never be submitted against a pending: synthetic party id (C1) — asserted by a test, on mobile specifically
- [x] The new person reaches the destination list through the existing shareTargets() read path, not a second one (C5)
- [x] Quick-adding a name that closely matches an existing person warns before committing (C4)
- [x] Face-region axis untouched — no writes to media_face_region
- [x] The pure destination-shaping law is imported by mobile rather than re-implemented (B3), and handler-reachability passes without a surface marking (C6)

## What changed

### Acceptance crosswalk

The web/desktop and mobile ShareSheets now each expose a one-field quick-add
and select the settled person in the same flow. The bridge writes the normal
People representation (core_party plus people_profile) with cadence_days
defaulting to 30, and the mobile component writes through the People session
without widening the embedding app's grants. selectedShareMembers continues
to omit a synthetic vault id and uses party:<partyId>; the shared law drops
every pending: party id before submission. The existing shareTargets() roster
path supplies the new destination on the web seat, while the native adapter
keeps its structurally different link/scope inputs. Near-name matches require
an explicit second press before a write. No media_face_region write or
face-region linkage was added. Mobile imports the shared destination-shaping
law, and the existing handler-reachability gate remains unchanged.

### Acceptance evidence

- From the ShareSheet on both the web/desktop and mobile seats, a user can add a person not in People and select them as a member in one flow.
- The created person is a normal core_party (kind=person) + people_profile visible in the People app with no duplicate mechanism; cadence_days defaults without asking the user (B2).
- The write does not require widening Photos/Docs/Tally consent grants, or the widening is explicit, minimal, documented, and argued in the receipt (Q2).
- selectedShareMembers semantics unchanged: no synthetic vault id minted for the invitation target; the destination id is party:<partyId>.
- A share can never be submitted against a pending: synthetic party id (C1) — asserted by a test, on mobile specifically.
- The new person reaches the destination list through the existing shareTargets() read path, not a second one (C5).
- Quick-adding a name that closely matches an existing person warns before committing (C4).
- Face-region axis untouched — no writes to media_face_region.
- The pure destination-shaping law is imported by mobile rather than re-implemented (B3), and handler-reachability passes without a surface marking (C6).

### Foundation and bridge

- packages/client/src/react/blueprints/centraid-inline.ts adds the online,
  settled-only window.centraid.quickAddPerson verb, dispatching the People
  add-person action under the People identity and rejecting blank, offline,
  or non-executed writes.
- packages/client/src/react/blueprints/centraid-inline.test.ts pins invalid
  input, settled-party-id, and pending-id behavior.
- packages/blueprints/apps/_shared/share-kit.ts owns quickAddedDestination,
  withQuickAddedPerson, nearNameMatches, and isPendingPartyId; the shared
  selectedShareMembers law filters pending overlay ids.
- packages/blueprints/src/share-kit.test.ts covers the shared laws and the
  deliberately updated empty-roster copy.
- packages/blueprints/types/centraid.d.ts declares the optional host-bridge
  quick-add contract.

### Web/desktop seat

- packages/blueprints/apps/_shared/ShareSheet.tsx adds feature-detected
  quick-add UI, the near-name confirmation gate, local post-write selection,
  named-circle detachment, and the updated empty state.
- packages/blueprints/apps/_shared/ShareSheet.module.css styles the
  quick-add field and action.
- packages/blueprints/src/share-sheet-quick-add.test.tsx covers the
  real-React flow, including the exact submitted member shape.

### Mobile seat

- apps/mobile/src/kit/share/ShareSheet.tsx keeps native links, scopes,
  circles, sharing, and invitation handoffs in the native sheet while
  delegating quick-add rendering to QuickAddPerson.
- apps/mobile/src/kit/share/QuickAddPerson.tsx owns the native quick-add
  draft, near-match confirmation, settled/queued outcomes, and selection
  callback.
- apps/mobile/src/kit/share/share-targets.ts stamps pending overlay rows and
  delegates member selection to the shared laws.
- apps/mobile/src/kit/share/share-targets.test.ts pins native pending
  destination and selection behavior.
- apps/mobile/src/kit/share/ShareSheet.test.tsx exercises settled selection,
  queued offline refusal, and duplicate-name confirmation.
- apps/mobile/tsconfig.json includes the shared ambient bridge contract and
  preserves the served-extension import convention required by the shared
  laws.
- packages/blueprints/tsconfig.test.json includes .tsx source tests plus the
  DOM libs needed for the browser-side React test program. The test
  reaches the shared app component through the repository's file-URL dynamic
  import convention so the test program remains rooted at src.

### Changed-file inventory

The implementation files covered by this receipt are:

apps/mobile/src/kit/share/ShareSheet.test.tsx,
apps/mobile/src/kit/share/ShareSheet.tsx,
apps/mobile/src/kit/share/QuickAddPerson.tsx,
apps/mobile/src/kit/share/share-targets.test.ts,
apps/mobile/src/kit/share/share-targets.ts,
apps/mobile/tsconfig.json,
packages/blueprints/apps/_shared/ShareSheet.module.css,
packages/blueprints/apps/_shared/ShareSheet.tsx,
packages/blueprints/apps/_shared/share-kit.ts,
packages/blueprints/src/share-kit.test.ts,
packages/blueprints/src/share-sheet-quick-add.test.tsx,
packages/blueprints/tsconfig.test.json,
packages/blueprints/types/centraid.d.ts,
apps/desktop/tests/e2e/onboarding-home.spec.ts,
packages/client/src/react/blueprints/centraid-inline.test.ts, and
packages/client/src/react/blueprints/centraid-inline.ts.

## Decisions

- Track B stays online-only on the bridge because a share needs a settled
  party id immediately; native mobile still shows queued people as visible
  but unselectable until the gateway settles them.
- The mobile quick-add logic moved into QuickAddPerson.tsx after the native
  sheet exceeded the repository's 625-line hygiene limit. The parent retains
  all native share and invitation behavior and receives only the computed
  selection update.
- apps/mobile/tsconfig.json remains a narrowly scoped accommodation for the
  shared served-extension module and ambient bridge contract; it does not
  relax strictness. The commit carrying it records the required governance
  waiver in its message.

## Out of scope

- Track A's machine-migration key export/import kit and all related gateway
  ownership, custody, and recovery work.
- Face regions and media_face_region, contact details, automatic event-driven
  person creation, named-circle schema changes, vault linking, and
  merge/dedupe machinery beyond the pre-commit near-name warning.
- New vault commands or manifest grant widening for Photos, Docs, or Tally.

## Verification

The relevant gates and focused tests are reproducible with:

```sh
bun run lint:tsconfigs
bun run --cwd packages/blueprints typecheck
bun run --cwd apps/mobile typecheck
bun run --cwd apps/mobile test -- ShareSheet.test.tsx
bun run test -- packages/blueprints/src/share-kit.test.ts packages/blueprints/src/share-sheet-quick-add.test.tsx
bun run check:ui-receipt
bun run check:pr
bash .governance/run.sh
```

The original slice validation also covered client and blueprint tests,
mobile typecheck/lint, root typecheck, root test, formatting, linting,
placement-registry, handler-reachability, and the native pending-id guard.
The only deliberate test-program change is the .tsx include plus DOM options
in packages/blueprints/tsconfig.test.json; no gate budget or policy was
weakened.

## Audit

- `## What changed` — **PASS**. Before this receipt-only edit, `git diff HEAD` and `git diff --cached` were byte-identical; all 16 non-receipt paths are named in the inventory, including `apps/desktop/tests/e2e/onboarding-home.spec.ts` (the UI-evidence harness). The bridge, shared laws, both seats, tests, CSS, type contract, and tsconfig changes are each described.
- Checked `## Checklist` — **PASS**. The implementation delegates to `people.add_person` with `cadence_days: 30`, keeps grants and face-region code untouched, preserves `party:<partyId>` invitation semantics, uses the existing roster path, imports the shared mobile laws, and blocks pending ids. Focused tests passed: blueprints 28/28, client bridge 21/21, mobile share 11/11; blueprints, client, and mobile typechecks also passed.
- Track B issue checklist mirroring — **PASS**. `gh issue view 776` shows the same nine Track B acceptance criteria, in the same order and wording apart from Markdown formatting; the receipt marks only those Track B items checked and explicitly keeps Track A out of scope. `check:ui-receipt` and share reachability both pass.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-14 | codex | 01a00118-da74-7480-8cb6-45f2880bcc3a |
