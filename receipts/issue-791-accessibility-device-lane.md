# Receipt — issue #791: accessibility runtime-tree ownership

## Checklist

- [x] Mobile has a cheapest-falsifying RN accessibility-tree assertion for
      roles, accessible names, and selected/busy state.
- [x] Web scans the connect screen, connected Home shell, and a shipped
      first-party blueprint with axe WCAG A/AA in a real browser.
- [x] Desktop's axe decision is explicit: it reuses the web owner because both
      hosts compile the same `packages/client/src/react/boot.tsx` DOM.
- [x] No `*.accessibility` cell is owned by
      `scripts/accessibility-contract.test.mjs`.
- [x] The nightly expected-grey accessibility registration is empty.
- [x] Demonstrated red was seeded and restored.

## What changed

`PhotosHome.test.tsx` consolidates the native assertion into the existing RNTL
renderer file: the library grain tabs expose role + selected state, the scrub
rail exposes its accessible name + adjustable trait, and the loading grid
exposes progressbar + busy state. That test surfaced a real missing state;
`PhotosGridSkeleton.tsx` now publishes `accessibilityState={{ busy: true }}`.

`apps/web/tests/e2e/accessibility.spec.ts` keeps its connect/Home scans and adds
the shipped Docs blueprint in its real inline renderer. `tests/matrix.json`
moves all fifteen accessibility cell owners off the static source contract,
adds canonical blueprint and mobile flows, and records the desktop reuse
decision. `scripts/accessibility-contract.test.mjs` remains a fast PR tripwire,
but is no longer runtime evidence. With real Playwright/RNTL owners available,
`EXPECTED_GREY` has no current registration.

Checklist crosswalk: Mobile has a cheapest-falsifying RN accessibility-tree
assertion for roles, accessible names, and selected/busy state. Web scans the
connect screen, connected Home shell, and a shipped first-party blueprint with
axe WCAG A/AA in a real browser. Desktop's axe decision is explicit: it reuses
the web owner because both hosts compile the same
`packages/client/src/react/boot.tsx` DOM. No `*.accessibility` cell is owned by
`scripts/accessibility-contract.test.mjs`. The nightly expected-grey
accessibility registration is empty. Demonstrated red was seeded and restored.

Changed paths for this issue:

```text
TESTING.md
apps/mobile/src/apps/photos/PhotosGridSkeleton.tsx
apps/mobile/src/apps/photos/PhotosHome.test.tsx
apps/web/tests/e2e/accessibility.spec.ts
scripts/test-report/expected-grey.mjs
scripts/test-report/generate-nightly-semantics.test.mjs
tests/matrix.json
tests/hygiene-budgets.json
tests/quality/classification-ratchet.json
receipts/issue-791-accessibility-device-lane.md
```

## Out of scope

Maestro remains the device/runtime integration layer; it cannot observe RN
roles and traits and is not duplicated here. A second Electron axe pass is not
added because it would scan the same compiled DOM with the same rule engine.
Broader per-route negative-state accessibility depth remains tracked under the
open #781 matrix notes.

## Decisions

- RNTL is the cheapest layer that can falsify native role/trait/state contracts;
  the assertion is consolidated in the existing renderer file to avoid another
  cold RN renderer startup.
- Desktop deliberately shares the web axe owner because desktop Vite and the
  web host both execute `packages/client/src/react/boot.tsx`; desktop-specific
  keyboard/focus behavior stays in Electron Playwright journeys.
- First-party Docs renders inline, not in the custom-app iframe, so the
  blueprint scan targets the actual inline tree and the surrounding shell.
- Quality-knob approval: `#791 moves every accessibility cell from the static contract to real Playwright or RNTL runtime-tree owners, adds blueprint/mobile evidence flows while retaining the four-test static tripwire floor, and corrects the web owner wording to the actual inline renderer; no quality grade, budget, or demonstrated-red claim is weakened.`
- Four truthy assertions and seven call-only assertions in the touched mobile
  suite now use exact values or call ledgers. Together with two exact
  shell-session call ledgers and one explicit never-called assertion in #795,
  this tightens the shared
  `tests/hygiene-budgets.json` call-matcher ceiling from 845 to 844.

## Verification

```sh
bun run --cwd apps/mobile test -- src/apps/photos/PhotosHome.test.tsx
# 1 file / 13 tests passed
bun run --cwd apps/mobile typecheck
# clean
bun run test:accessibility:web
# 3 Playwright axe tests passed
bun run --cwd apps/web typecheck
# clean
bun run test:accessibility
# 5/5 static tripwire tests passed
bun run test:matrix
# green: 15 surfaces × 11 dimensions; 127 canonical flows
bun run test:ratchet:unit
# 21 files / 314 tests passed; coverage floors met
```

Demonstrated red (2026-08-15): before the product fix, the new RNTL assertion
failed because `Opening your library` exposed `progressbar` without busy state.
For the browser half, an unlabelled `<img>` was temporarily injected into the
rendered Docs tree; axe failed `image-alt (critical)` and named target `img`.
The seed was removed and the full three-test browser file returned green.

## Audit

PASS — `/root/receipt_audit_790_791` verified the receipt against issue #791
and the current diff: every checked accessibility owner, runtime-tree claim,
desktop decision, expected-grey removal, and demonstrated-red record is
substantiated. The touched mobile test's stronger assertions and the shared
413/844 hygiene ratchet are also accurately attributed and green.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-15 | codex | 01a003d7-1e6b-7d00-86a3-4831e330af63 |
