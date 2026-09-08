# pre-push-gate

A push that moves a ref runs `bun run check:push` first.

AGENTS.md has told agents to run the gate before every push since #496. That
instruction is correct and it did not work: #568 shipped a red CI because the
diff-coverage gate lived in the `verify` job and nothing local ran it. A gate
enforced by attention is enforced only when attention holds.

The economics are measured, not assumed. A CI round trip is 12.3 minutes of
wall clock — `gateway-package` at 12m, `verify` at 10m, `mutation-pr` at 8.3m
running in parallel. A local gate pays for itself if it catches something more
often than its cost divided by that round trip.

Local gates do not make CI faster. A green PR takes 12.3 minutes regardless.
What they buy is not paying those 12.3 minutes a second time.

**The gate is `check:push`, not `check:pr` (#668).** Binding the hook to the
full CI mirror got the arithmetic backwards. `check:pr` ran 28 gates serially
for ~250s and stopped at the first failure, so unrelated problems cost a full
pass each; four gates accounted for 92% of that time and every one of them is
recomputed authoritatively in CI. Worse, `lint:node-version` sat third in the
chain demanding the exact pinned Node — a condition CI meets by construction
and a developer's default version manager usually does not — so pushes died
five seconds in for a reason unrelated to the diff.

The predictable result was universal `SKIP_CHECK_PR=1`, which enforces nothing
at all. A gate priced above its value is not a strict gate; it is an unused
one. `check:push` runs the same gates concurrently, reports every failure in
one pass, and costs what the affected tests cost.

**The list is 17 names, not 59 (#915 Wave 4).** The count had drifted to 59
while the docs still claimed 25. Three moves cut it back without dropping a
check: 38 sub-second contract gates collapsed into one `lint:product` bundle
(`scripts/lint-product.mjs`, one process at full parallelism, same per-gate
buffered failure output); seven tighten-only ratchets over the test suite's
own quality moved to the weekly `hygiene.yml` lane with one rolling issue; and
`check:mobile-native-state` (30.5s) dropped to rung 2, where ci.yml's
`mobile-smoke` job already ran it on exactly the diffs that matter. Every gate
carries its class and the reason for it in `scripts/ci/gate-classes.json`, and
`scripts/ci/gate-classes.test.mjs` fails if a gate is classified hygiene and
then enforced nowhere.

**Rung 1 also absorbed rung 0's repo-wide directives (#915 Wave 4).**
`receipt-per-issue` is vendored, digest-locked, and repo-wide by construction,
and its `hook:` field cannot be moved in-tree without failing
`managed-tree-integrity`. `.githooks/pre-commit` therefore skips the ids in
`.governance/conf/srikanth235/centraid/pre-commit-deferred.conf` and
`.githooks/pre-push` runs exactly those before `check:push`. `.governance/run.sh`
never changed, so CI's copy always runs every directive either way.

The deferral's original arithmetic no longer holds: `repo-hygiene` was retired
in governance-kit audit 0.11.0 and `receipt-per-issue` was rewritten to a much
cheaper check, so the whole 12-directive suite now runs in about 4s. Whether
anything still needs deferring is an open question, not a settled rule.

**Fix:** run `bun run check:push` and repair what it reports. Run
`bun run check:pr` when you want CI's full answer without waiting for CI.

**Waiver:** `SKIP_CHECK_PR=1 git push` opts out of this directive alone;
`SKIP_GOVERNANCE=1` opts out of every hook. Both are legitimate for a WIP
branch or a spike, and both leave CI as the enforcing copy. The escape hatch is
deliberate: a gate with no exit is a gate people disable permanently.
