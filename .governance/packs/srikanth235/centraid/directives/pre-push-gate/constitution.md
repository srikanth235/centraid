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

**Rung 1 also absorbed rung 0's two repo-wide directives (#915 Wave 4).**
`repo-hygiene` and `receipt-per-issue` are vendored, digest-locked, and
repo-wide by construction — 86.3s between them against a rung-0 budget of 5s,
and their `hook:` field cannot be moved in-tree without failing
`managed-tree-integrity`. `.githooks/pre-commit` therefore skips the ids in
`.governance/conf/srikanth235/centraid/pre-commit-deferred.conf` and
`.githooks/pre-push` runs exactly those before `check:push`. A commit costs
6.2s instead of 88.7s; a push pays what a commit used to; `.governance/run.sh`
never changed, so CI's copy always ran all 22 either way.

**Fix:** run `bun run check:push` and repair what it reports. Run
`bun run check:pr` when you want CI's full answer without waiting for CI.

**Waiver:** `SKIP_CHECK_PR=1 git push` opts out of this directive alone;
`SKIP_GOVERNANCE=1` opts out of every hook. Both are legitimate for a WIP
branch or a spike, and both leave CI as the enforcing copy. The escape hatch is
deliberate: a gate with no exit is a gate people disable permanently.
