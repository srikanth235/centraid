# issue-930 — `main` is green at the pre-push rung

[#930](https://github.com/srikanth235/centraid/issues/930) is a bug issue, so it
carries no acceptance-criteria checkboxes. The checklist below is its
**Expected** section written as two items, plus the third the root added when
it granted the `check:ui-receipt` fix into this slice.

## Checklist

- [x] lint:ledgers and test:ratchet green on main
- [x] repo-hygiene file-size green on main
- [x] check:ui-receipt no longer demands a screenshot for a test-only change under packages/blueprints/apps

## What changed

**1. The spent rename marker (`lint:ledgers and test:ratchet green on main`).**
`tests/claims.json`'s `golden-vault-archaeology` flow carried
`replacesMinimumTestsFlow: "schema-migration-corpus"` and the
`approvedMinimumTestsDeviation` that authorized it. Both are one-shot claims
about the change set that *makes* a rename: `diffMinimumTests` reads the marker
against the merge base, and since [#916](https://github.com/srikanth235/centraid/issues/916)
landed the rename and the marker together, `schema-migration-corpus` exists at
no base any more — the marker could only ever report `flow replacement names
unknown predecessor`, so `bun run lint:ledgers` and `bun run test:ratchet` were
red on `main` itself and every branch's `git push` was blocked by the pre-push
hook. Both keys are removed and replaced by a `_comment` on the same row that
records the floor history (the predecessor's floor was taken over one-to-one and
RAISED 4 → 5) and points at `receipts/issue-916-vault-ontology-review.md`, which
holds #916's full rationale. The note is a pointer, not a waiver.

`minimumTests` does not move: the floor stays at 5 and
`tests/floors.json#minimumTests` needed no refresh —
`node scripts/check-ledgers.mjs --write` leaves the mirror byte-identical,
because only annotations left the row.

`tests/quality/classification-ratchet.json` fingerprints `tests/claims.json`
whole-file, so editing that file — even to delete two spent keys — makes the pin
stale and `lint:quality-knobs` red. The pin is refreshed
(`9fbdc028…` → `a3d830db…`) and `approvedDeviation` carries the reason,
superseding #916's note without contradicting it (quoted verbatim under
`## Decisions`, which is where `check-quality-knobs.mjs` requires it to appear).
`claimsGovernanceFingerprint` is unchanged — no claim row, severity, evidence
selector or demonstrated-red date moved.

**2. The over-length suite (`repo-hygiene file-size green on main`).**
`packages/blueprints/apps/locker/queries.test.ts` was 638 lines against the
625-line `FILE_SIZE_LIMIT`. It is split by subject, whole `describe` blocks
moved, following the Notes precedent (`logic.test.ts` + `logic-panes.test.ts` +
`logic.test-fixtures.ts`):

- `packages/blueprints/apps/locker/queries.test.ts` (336 lines) keeps the #872
  reads — the window total and alias read-back on `items`, and the sidecars,
  revision history and degradation rule on `item`.
- `packages/blueprints/apps/locker/queries-reveal-access.test.ts` (250 lines) is
  new and holds what the boundary hands out and what it records: the sealed
  sidecar reveal that spends the item's permit (#873) and the access history on
  `access` (#872).
- `packages/blueprints/apps/locker/queries.test-fixtures.ts` (84 lines) is new
  and holds the recording ctx (`ctxOf`, `ReadCall`) and the row fixtures
  (`LIVE_ITEM`, `OLD_CIPHERTEXT`, `OLDER_CIPHERTEXT`) both suites read. The ctx
  still deliberately does not apply `where`, so every narrowing assertion is
  still made against the recorded read requests.

No test was deleted and no assertion was weakened: **22 tests before, 22 tests
after** (14 in `queries.test.ts`, 8 in `queries-reveal-access.test.ts`), each
body moved verbatim. No claims flow owns `locker/queries.test.ts` — the Locker
flows in `tests/claims.json` own `states.test.tsx`, `totp.test.ts`,
`origin-matching.test.ts`, `locker-item-type.test.ts` and `format.test.ts` — so
no owner path had to move, and no `packages/blueprints` mutation seed or Stryker
config names the file. `packages/blueprints/manifest.json` is generated and
lists every app file, so the blueprints build regenerated it to register the two
new files; it is committed with them rather than left to drift.

**3. The gate that made defect 2 unfixable.** `check:ui-receipt` no longer
demands a screenshot for a test-only change under packages/blueprints/apps:
`scripts/validate-ui-receipt.mjs`'s `touchesUi` predicate now skips
`*.test.*` and `*.test-fixtures.*` paths under that tree, and
`scripts/validate-ui-receipt.test.mjs` gains the three cases that pin the new
line — a blueprint app's `.tsx` and its `.module.css` each still demand a
screenshot, a test-only change (a `states.test.tsx` among them) needs none. The
evidence rule itself is untouched; only the classification of what counts as a
surface moves. Scope granted by the root on the issue after this slice reported
the blocker; the full reasoning is under `## Verification`.

`receipts/issue-930-main-prepush-green.md` is this issue's own receipt.

## User impact

None. The gate fires because a file under `packages/blueprints/apps/` changed,
but the only Locker files touched are its query-handler *tests* and their new
fixtures module — no handler, component, stylesheet or copy string moves, and
the same 22 assertions run over the same code. Nothing a member sees in Locker
differs before and after this change set, so there is no screenshot to carry.

**First-run: unchanged.** A first run of Locker reaches the same handlers with
the same behaviour; this change set only repairs two repository gates that were
red on `main`.

## Out of scope

- **`design:gallery`.** Checked once, as the contract asks: it is
  **environment-only** here. The gate shells out to Playwright, and this
  container has no pinned browser binary (`bunx playwright install chromium` was
  never run in it), so the lane fails identically on a pristine `origin/main`
  checkout and on this branch. Nothing in this change set touches it and it is
  not evidence of a red `main`.
- **`commit-message-format`.** `.governance/run.sh` reports one violation
  against `HEAD` — `main`'s own #916 commit has a 105-character subject (max
  100). It is a property of a commit already on the trunk, not of this change
  set; rewriting a landed commit is not something this issue may do.
- **Wiring `scripts/validate-ui-receipt.test.mjs` into a runner.** It is an
  ORPHAN: it imports from `vitest`, and no vitest project includes `scripts/*`
  outside `scripts/release`, `scripts/fuzz` and `scripts/test-report`, while
  `scripts:test`'s `node --test` list does not name it — so neither its two
  original cases nor the three added here are executed by any lane. Wiring it
  means editing `package.json`'s `scripts:test` (toolchain config, a
  `governance: allow-toolchain-config` commit), which the root's grant does not
  cover. Reported as a finding; the three new cases were verified by calling
  `validateUiReceipt` directly (see `## Verification`) and by the real
  `bun run check:ui-receipt` over this change set.
- **Teaching `replacesMinimumTestsFlow` to no-op once its predecessor is gone.**
  The checker option, re-judged under `## Decisions` and left unbuilt.
- **`CHANGELOG.md`.** Not touched: this change set repairs two bookkeeping
  gates and moves no product behaviour, and the file is outside the slice's
  scope.

## Decisions

**Option (a), delete the spent marker — not option (b), teach the checker to
ignore it.** The contract offered both. `diffMinimumTests`'s own doc comment
says "An ID rename must name its exact predecessor with
`replacesMinimumTestsFlow`", and `scripts/test-report/ratchet-floors.test.mjs`
exercises the field only inside change sets that *contain* the rename (base has
`old-name`, head has `new-name`). The checker's contract is therefore
change-set scoped: the annotation describes the change set that makes the
rename, which is exactly the "prefer (a)" condition. The repo has ruled this way
three times before on the same footgun —
[#802](https://github.com/srikanth235/centraid/issues/802) (which explicitly put
"teaching `replacesMinimumTestsFlow` to no-op" out of scope),
[#836](https://github.com/srikanth235/centraid/issues/836) and
[#915](https://github.com/srikanth235/centraid/issues/915) — but a citation is
not a justification, so the property was re-judged here: the one-shot design is
what makes the base-side check able to say *which* removed floor a new flow
absorbed. Loosening it to "absent at base AND at head passes" would make a
marker permanently unfalsifiable, and a marker nobody can be wrong about is
bookkeeping, not a ratchet. The recurring cost is real but it is a *reminder to
delete a spent key*, which is one line, against a guard that is the only thing
standing between a floor transfer and a floor disappearance.

**The `approvedMinimumTestsDeviation` goes with the marker.** #802 and #836 kept
the paired prose as the durable record; #915 dropped it and gave the reason —
for `minimumTests`, presence alone waives (`diffMinimumTests` checks only that
the string is non-empty, with no `deviationChanged` test), so a note left behind
after its rename lands is a standing permission for any future PR to lower this
flow's floor unnoticed. That is a live weakening, so the newer ruling is the one
followed here: the prose leaves and the reasoning survives in #916's receipt,
cited from the row's `_comment`. The floor itself does not move.

**The classification-ratchet re-pin is a coupled edit, not a scope creep.**
`tests/quality/classification-ratchet.json` was not on the slice's file list,
but `tests/claims.json` cannot be edited without it: the whole-file fingerprint
goes stale in the same keystroke, exactly as in #802 and #836. It is re-pinned
rather than removed, and the deviation note is quoted here verbatim because
`scripts/check-quality-knobs.mjs` requires it to appear in a changed receipt's
`## Decisions`. The note replaces #916's text and names it as the prior pin, as
#802 and #836 did before it — #916's account of the `sealed.ts`, `manifest.ts`
and `route-security.ts` pins, none of which move here, stays whole in
`receipts/issue-916-vault-ontology-review.md`:

#930 re-pins the tests/claims.json whole-file fingerprint after removing the spent rename marker on the `golden-vault-archaeology` flow, superseding the #916 re-pin note rather than contradicting it — every sentence of #916's account of what that flow took over is kept, in receipts/issue-916-vault-ontology-review.md and in the flow's own `_comment`. `replacesMinimumTestsFlow` is a ONE-SHOT claim about the change set that makes a rename, checked against the merge base; once #916 landed, `schema-migration-corpus` existed at no base any more, so the marker could only ever report an unknown predecessor and `lint:ledgers` / `test:ratchet` were red on main itself. The marker and the `approvedMinimumTestsDeviation` that authorized it are removed together, because that note waives a future minimumTests drop on this flow by presence alone; the floor stays at 5, no claim row, severity, evidence selector or demonstrated-red date moves, and claimsGovernanceFingerprint is unchanged. Prior: #916.

**A suite is not a surface.** The `check:ui-receipt` narrowing changes what the
gate CLASSIFIES as user-facing, never what it demands once something is: the
screenshot-plus-emitter rule, the `packages/client/**` arm and the
`apps/*/**.{tsx,css}` arm are byte-identical, and a component, stylesheet or
handler beside an exempted suite still owes its photograph. The alternative
inside the old predicate — attaching a screenshot of a screen that did not move
to a test split — would have been evidence theatre, and the other alternative,
leaving `main` over the file-size limit, is the red this issue exists to clear.

**The split is by subject, and the fixtures move with it.** The alternative —
trimming comments or collapsing cases to get under 625 — would have been the
weakening this repo forbids. The seam chosen is the one the file already had:
the #872 reads on one side, the #873 permit-spending reveal and the receipts it
writes on the other, with the recording ctx shared rather than duplicated so a
handler that stops filtering still fails in both.

## Verification

```sh
# the two defects, before
bun run lint:ledgers   # ✗ tests/floors.json#minimumTests: flow replacement names unknown predecessor "schema-migration-corpus"
bun run test:ratchet   # ✗ flow replacement names unknown predecessor "schema-migration-corpus"
wc -l packages/blueprints/apps/locker/queries.test.ts   # 638 > 625

# after
bun run lint:ledgers          # ✓ ok — 19 sections across 4 ledgers hold against origin/main
bun run test:ratchet          # ✓ ok (no decreases vs origin/main)
bun run test:claims           # ✓ 45 claims, 48 lanes, 192 derived flows, 56 deliberate n/a cells
bun run lint:quality-knobs    # ✓ quality knob governance: no silent widening
bun run lint:law-registry     # ✓ 48 laws registered, 82 tag site(s)
node scripts/check-ledgers.mjs --write   # mirrors refreshed; tests/floors.json byte-identical
bun run format                # ✓ 5353 files
bun run lint                  # ✓
bun run --cwd packages/blueprints test        # ✓
bun run --cwd packages/blueprints typecheck   # ✓
bash .governance/run.sh       # ✓ repo-hygiene (see Out of scope for commit-message-format on HEAD)
bun run check:ui-receipt      # ✓ UI receipt gate: evidence verified
bun run scripts:test          # ✓ 584 passed (node --test lane) + the release vitest lane
bun run check:push            # ✗ 15/17 — design:gallery (environment) and test:qualities
                              #   (host contention, see below); every other gate green,
                              #   lint:product → check:ui-receipt among them
bun run design:gallery        # ✗ launch: Executable doesn't exist at
                              #   /opt/pw-browsers/chromium_headless_shell-1234/… — environment only
bun run test:qualities kill-mid-write   # ✓ 1 file, 5 passed, 66.9s
```

**The two reds, neither of them this change set.** `design:gallery` needs the
pinned Playwright browser, which this container does not have. `test:qualities`
failed on `tests/quality/kill-mid-write.integration.test.ts` (4 of 5 SIGKILL
crash-recovery cases timing out at 30s) in the same `check:push` run, and it is
host contention, not a product red: an earlier full `check:push` on this same
tree passed `test:qualities` in 141.5s, the failing run took 375.4s while three
sibling agents ran their own full suites on the same 4-core / 15 GB host (a
second attempt at the whole lane was SIGKILLed outright — the kernel, not an
assertion), and the file passes in 66.9s on its own. Nothing in this change set
reaches it: the diff is two ledger files, three Locker test files, a generated
manifest and the UI-receipt gate.

**The `check:ui-receipt` narrowing.** Before it, `scripts/validate-ui-receipt.mjs`
classified a change as user-facing when any changed path started with
`packages/blueprints/apps/` — `*.test.ts` and `*.test-fixtures.ts` included —
and the only exit from the gate is a screenshot path in the receipt that a
CHANGED e2e harness emits (`validateUiReceipt` returns `[]` only from inside its
screenshot loop; a receipt with `## User impact` and a `First-run:` note but no
screenshot still errors). So *every* repair of the 638-line file tripped it,
including one that only deleted comment lines, and no container without
Playwright's browser can photograph anything. A suite is not a surface: the
predicate now skips `*.test.*` and `*.test-fixtures.*` under
`packages/blueprints/apps/` and nothing else moves — `packages/client/**`, the
`apps/*/**.{tsx,css}` rule, the handler, component and stylesheet files beside
the suites, and the screenshot/emitter rule itself are all untouched.
`scripts/validate-ui-receipt.test.mjs` gains three cases: a blueprint app's
`.tsx` and its `.module.css` each still demand a screenshot, and a test-only
change (including a `states.test.tsx`, so the exemption is read off the FILENAME
and not the extension) passes with none.

Those three cases do not execute in any lane — `scripts/validate-ui-receipt.test.mjs`
is an orphan (see `## Out of scope`) — so the new predicate was exercised
directly instead, five cases, all passing: the `.tsx` and the `.module.css`
still error, the test-only set returns `[]`, and `packages/client/src/react/Shell.tsx`
and `packages/blueprints/apps/locker/queries/item.ts` still error:

```sh
node -e "import('./scripts/validate-ui-receipt.mjs').then(({validateUiReceipt}) => { /* the five cases */ })"
# PASS tsx demands screenshot / PASS module.css demands screenshot
# PASS test-only passes / PASS client still demands / PASS handler still demands
bun run check:ui-receipt   # ✓ UI receipt gate: evidence verified (over this real change set)
```

- `bun run --cwd packages/blueprints test -- locker/queries` — 2 files, **22
  passed**, against **22** on `origin/main` for the single pre-split file
  (`grep -c "^  it(" ` on the `origin/main` copy: 22; after the split: 14 + 8).
- File sizes after the split, all under the 625-line `FILE_SIZE_LIMIT`:
  `queries.test.ts` 336, `queries-reveal-access.test.ts` 250,
  `queries.test-fixtures.ts` 84.
- Host: 4-core Linux container, Bun 1.3.11, worktree
  `/home/user/centraid-wt/claude/930-main-prepush-green` off `origin/main` at
  `cf616a09`.

## Session

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-09-03 | claude-code | 60f9e86b-149f-5fc9-84c0-f2160b6b6f3c |
