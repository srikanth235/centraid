# pre-push-gate

A push that moves a ref runs `bun run check:pr` first.

AGENTS.md has told agents to run `check:pr` before every push since #496. That
instruction is correct and it did not work: #568 shipped a red CI because the
diff-coverage gate lived in the `verify` job and nothing local ran it. A gate
enforced by attention is enforced only when attention holds.

The economics are measured, not assumed. The static gates cost ~90s locally.
A CI round trip is 12.3 minutes of wall clock — `gateway-package` at 12m,
`verify` at 10m, `mutation-pr` at 8.3m running in parallel. A local gate pays
for itself if it catches something more often than its cost divided by that
round trip, which for every gate in `check:pr` is a hit rate under 4%.

Local gates do not make CI faster. A green PR takes 12.3 minutes regardless.
What they buy is not paying those 12.3 minutes a second time.

**Fix:** run `bun run check:pr` and repair what it reports.

**Waiver:** `SKIP_CHECK_PR=1 git push` opts out of this directive alone;
`SKIP_GOVERNANCE=1` opts out of every hook. Both are legitimate for a WIP
branch or a spike, and both leave CI as the enforcing copy. The escape hatch is
deliberate: a gate with no exit is a gate people disable permanently.
