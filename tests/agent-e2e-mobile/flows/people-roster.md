# people-roster

**Goal:** prove the phone's People seat against the real seeded circle — the roster draws the vault's people with their own profile roles, and the person screen carries the cadence arithmetic that is assembled from three separate replica tables.

**Setup:** `ctx.ensureDemo("people")` runs before pairing, so the initial replica clone holds the deterministic circle (`packages/blueprints/apps/people/seed.js`: four people with cadences of 30/45/7/60 days, three logged interactions, two important dates, two gifts and one debt). The flow then pairs via `ctx.configureGateway()`.

**Steps:** open People from Home's launcher tile, observe all four roster rows by their accessible names and two of their second lines, then open Grandpa Ray's row and observe the person screen's cadence line.

**Expectations:**

1. **The row is the vault's person.** `Open Grandpa Ray` is `LABELS.openPerson(name)` (`people-copy.ts:309`), set as the row's `accessibilityLabel` on the `PersonRow` press target (`apps/mobile/src/apps/people/PeopleKit.tsx:204`). All four seeded people are asserted rather than one: a projection that carried the first row of a replica query and stopped draws a roster that looks right until it is counted.
2. **The second line is the profile's role, per row.** `rosterSub()` (`packages/blueprints/apps/people/components/RosterRoute.tsx:47-50`) returns the role alone for a person the sharing plane reports no binding for, and leads with `Linked` where there is one. `Grandfather` and `Old roommate from Portland` are two different profiles' roles, so a single hard-coded sub-line cannot satisfy both.
3. **The cadence line is the join, and the digit is the assertion.** `Every 7 days · last …` comes from `cadenceLineLabel(person.cadence_days, person)` (`format.ts:125-137`, rendered at `apps/mobile/src/apps/people/PersonView.tsx:221`). The cadence lives on `people_profile`; the last contact is stamped by `people.log_interaction` and reaches the screen only through the `core.link` → `core.activity` chain the phone reassembles itself in `usePeople` (ten separate replica queries) and `projectPerson`. Drop the profile half of that join and the same screen renders `No cadence · last …` — every seeded name still present, the arithmetic gone. That is the failure no fixture-fed unit test sees, because a fixture hands the view a person already merged.

**Why nothing here asserts overdue.** `ctx.ensureDemo` seeds only when the scenario is absent, so on a long-lived gateway this corpus can be days old, and People's seed takes no `input.now` — every cadence and every `last_contacted_at` is stamped at seeding time. Whether Grandpa Ray (7-day cadence) is overdue therefore depends on the age of the demo vault, not on the code under test. An assertion either way would be a clock, not a claim; the `last …` half of the cadence line is left open (`.*`) for the same reason. If a seed that accepts an explicit `now` lands, the overdue band and its consequence tone become assertable here and should be added.

**Verdict:** PASS only if all four rows draw with their own roles AND the person screen prints the seeded cadence as a digit. A screen that lists four names under `No cadence` is drawing a roster it never joined.
