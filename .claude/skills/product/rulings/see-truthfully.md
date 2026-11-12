# See truthfully

Page states, permissions, units and performance at scale.

## Page states

A read that failed, a refusal, a partial read and a check not run each say so ([principle 7](../SKILL.md#governing-principles)). The states and their words are the kit's: [status line and controls](../../design/behaviour.md#status-line), [how a screen reads](../../change/screen.md).

## Units and amounts

Every number is a quantity with its unit, in the member's one units choice (metric or imperial) ([promises](../promises.md)).

- **Money keeps its currency.** An amount has no meaning without one. A base-currency total is an explicit valuation with a rate and a source, and says "unavailable" when the rate is missing.

## Permissions

- **Ask for permissions at the moment of need, never at launch,** and leave an actionable path to Settings after a denial. Quick add routes unambiguous input deterministically; ambiguous input shows a preview and commits nothing until confirmed.

## Performance and scale

- **Declare year-3 volume and measure at it.** A feature is fast on an empty vault by accident. Reads page by keyset, never offset; bounds must be exercised by their scale profile or they are unproven. Search is bounded by construction at year-3 scale (title matches, then the newest 500 others) and its plans are checked, not its seconds.
- **A performance design is adopted only on evidence** from the journey ledger at the owner's volume on the owner's hardware. An emulator number never becomes a ceiling.
- **A cap never names a size it cannot reach,** and a page never silently drops rows (undated photographs, nullable sort keys). If it cannot fit in a commit, it is owed and done when idle.
