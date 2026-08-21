# Issue #750 — desktop-e2e evidence frame

<!-- governance: allow-receipt-per-issue — #750's main receipt (receipts/issue-750-sharing-hardening.md) is frozen now that it is on the default branch. This follow-up ships its own receipt rather than editing that record, which is what doc-integrity's frozen-files rule asks for. No recorded fact in the main receipt is altered; the one line it carries that this change makes stale is corrected here instead. -->

Follow-up to the merge of #757. Repairs `client-e2e / desktop-e2e` on `main`.

## Checklist

- [x] Remove journey 2.12, which cannot pass against the e2e mock gateway
- [x] Emit `issue-750-vault-sharing.png` from a journey that does pass
- [x] Correct the one line the frozen receipt carries about that frame
- [x] Confirm the web-e2e failure on the same commit is not this change set's

## What changed

### Why main was red

`main` at `ff77bb4c` carries journey 2.12, which opens Household and asserts on
a `Devices` heading. The Household route does not render against the e2e mock
gateway — its roster and owner-scope reads fail — so that assertion can never
pass, and a screenshot taken there would have pictured an error state rather
than #750's change. The journey was written and reverted while #757 was in
review; the squash-merge captured a commit from before the revert, so the
version that landed is not the version the branch ended on.

### Files touched, by full path

- `apps/desktop/tests/e2e/onboarding-home.spec.ts` — drops journey 2.12 and its
  now-unused `gotoNav` import. Journey 1.2 (first-run Home) instead emits one
  more frame, `artifacts/e2e/ui-impact/issue-750-vault-sharing.png`, alongside
  the ones #726, #731 and #747 already take there. This is the frame every
  sharing-plane issue before this one used, including #726, #750's direct
  predecessor. Net effect against the pre-#757 file: nine added lines inside a
  journey that was already green.

### Correction to the frozen receipt

`receipts/issue-750-sharing-hardening.md` says the evidence PNG is emitted
"with Household open" (under `## User impact`). That is no longer true and is
corrected here: the frame is first-run Home, for the reason above. The frozen
receipt is left byte-for-byte as merged.

## Out of scope

- **The `client-e2e / web-e2e` failure on the same commit.** Not this change
  set's, and deliberately not "fixed" by touching code. The identical
  `apps/web` and `packages/gateway` trees passed that lane in 66s on the #757
  PR run (`ffe6512b`, job 94339233130) and failed on `main` an hour later, where
  the one failing journey — `pending-overlay.spec.ts:229` — burned its whole
  180s budget waiting for the command palette after an offline reload. Fifteen
  of sixteen tests passed on both runs, at normal speed. That is a slow-runner
  flake in one long journey, not a regression; the retry then failed differently
  (`prepareTally` got no `party_id`) because the suite reuses a fixed `intentId`
  against a gateway that had already executed it in attempt 1. Recorded rather
  than patched: changing a timeout to quiet a flake would hide the retry
  fragility underneath it.
- Journey 2.12's intent — a Household-open evidence frame. Getting one needs the
  e2e mock gateway to serve the roster and owner-scope reads Household mounts
  against, which is its own change.

## Verification

Desktop suite, the lane that was red:

```sh
cd apps/desktop
xvfb-run --auto-servernum bun run test:e2e -- onboarding-home
```

18 journeys, no 2.12; journey 1.2 passes in 35.2s and writes
`artifacts/e2e/ui-impact/issue-750-vault-sharing.png` (57,628 bytes).

Evidence gate and full directive set:

```sh
bun run lint
bun run check:ui-receipt      # UI receipt gate: evidence verified
.governance/run.sh            # governance: all 25 directive(s) passed
```

Web suite on this same tree, for the out-of-scope claim above — 16 passed in
1.0m locally, including the journey that failed on `main`:

```sh
cd apps/web && bun run e2e
```

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-13 | claude-code | aea2eb6c-dd0d-5e48-9a97-e2b937667112 |
