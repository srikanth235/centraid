# tasks-board

**Goal:** prove the phone's Tasks board against the real seeded week — Today separates overdue work into its own group with its own verb, and Upcoming carries a project's family (parent plus its subtasks) rather than a flat list of top-level rows.

**Setup:** `ctx.ensureDemo("tasks")` runs before pairing, so the initial replica clone holds the deterministic board (`packages/blueprints/apps/tasks/seed.js`: nine tasks — one overdue errand, one due today, a project with three subtasks, two completed rows, and one undated someday idea). The flow then pairs via `ctx.configureGateway()`.

**Steps:** open Tasks from Home's launcher tile, observe the Overdue group's header, its count-with-reassurance meta and its own verb, observe the overdue row itself, switch to **Upcoming**, and observe both a dated top-level task and a nested subtask.

**Expectations:**

1. **Overdue is its own group with its own verb.** `Move all to today` (`GROUPS.moveAll`, rendered at `apps/mobile/src/apps/tasks/TasksHome.tsx:190`) is drawn only on a group whose `attention` flag is set, and `todayGroups()` sets that on the overdue group alone (`packages/blueprints/apps/tasks/logic.ts:56-59`).
2. **The meta is a count and a reassurance, never a scold.** `overdueMeta()` (`view-copy.ts:96`) renders `N · nothing was deleted`; a non-zero digit is the assertion, because an empty overdue group would not draw the header at all.
3. **The row is the vault's row.** `Rotate the tires before the drive` is the task row's accessible name (`TasksHome.tsx:227`, `:236`).
4. **A family travels with its parent.** `useTasks.ts:69-87` nests subtasks under their parent and drops them from the top level, so `Compare cabins — South Lake vs Truckee` can only render on Upcoming as a CHILD of `Plan the Tahoe trip`. A projection that dropped the nesting shows the parent and loses the child; a projection that never nested shows the child as a top-level undated row that Upcoming filters out entirely. Either way this assertion goes red.

**Verdict:** PASS only if the Overdue group draws with its verb and its meta AND Upcoming renders a nested subtask under its parent. A board that lists every seeded title flat, with no Overdue header, is passing arithmetic it never ran.
