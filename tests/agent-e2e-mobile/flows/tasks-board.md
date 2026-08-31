# tasks-board

**Goal:** prove the phone's Tasks board against the real seeded week — Today separates overdue work into its own group with its own verb, and Upcoming carries a project's family (parent plus its subtasks) rather than a flat list of top-level rows.

**Setup:** `ctx.ensureDemo("tasks")` runs before pairing, so the initial replica clone holds the deterministic board (`packages/blueprints/apps/tasks/seed.js`: nine tasks — one overdue errand, one due today, a project with three subtasks, two completed rows, and one undated someday idea). The flow then pairs via `ctx.configureGateway()`.

**Steps:** open Tasks from Home's launcher tile, observe the Overdue group's header, its count-with-reassurance meta and its own verb, observe the overdue row itself, **capture a task through the quick-add bar and find it in the Inbox**, switch to **Upcoming**, and observe both a dated top-level task and a nested subtask.

**Expectations:**

1. **Overdue is its own group with its own verb.** `Move all to today` (`GROUPS.moveAll`, rendered at `apps/mobile/src/apps/tasks/TasksHome.tsx:190`) is drawn only on a group whose `attention` flag is set, and `todayGroups()` sets that on the overdue group alone (`packages/blueprints/apps/tasks/logic.ts:56-59`).
2. **The meta is a count and a reassurance, never a scold.** `overdueMeta()` (`view-copy.ts:96`) renders `N · nothing was deleted`; a non-zero digit is the assertion, because an empty overdue group would not draw the header at all.
3. **The row is the vault's row.** `Rotate the tires before the drive` is the task row's accessible name (`TasksHome.tsx:227`, `:236`).
4. **Quick add writes into the group the screen draws** ([#890](https://github.com/srikanth235/centraid/issues/890) W5). Tasks had no `inputText` anywhere in this layer, so every claim above read a corpus the gateway seeded. `tasks-capture` **is** the capture `TextInput`; a title carrying `ctx.state.runId` is typed and asserted at the field, and the bar's own foot (`quickAddLandsIn()` → `Inbox · <vault>`) is asserted **before** the tap — so the Inbox is not the flow's guess about the grouping, it is the destination the bar itself names. `Add` fires `add_task` and `capture()` resets the draft to `QUICK_ADD_EMPTY`, so the chips pane folding away is the draft being consumed and the typed title leaving the field. The task is then found on the Inbox destination by its own title (a `TaskRow`'s accessible name), and asserted _absent_ from Today: `QUICK_ADD_EMPTY` files with no date, and `todayGroups()` draws only overdue and today (`logic.ts:58-78`), so an undated row is honestly in neither.

   The run id matters because `ctx.ensureDemo` seeds only when the scenario is absent — on a long-lived gateway a task left by an earlier run would otherwise satisfy the assertion without this run writing anything.

5. **A family travels with its parent.** `useTasks.ts:69-87` nests subtasks under their parent and drops them from the top level, so `Compare cabins — South Lake vs Truckee` can only render on Upcoming as a CHILD of `Plan the Tahoe trip`. A projection that dropped the nesting shows the parent and loses the child; a projection that never nested shows the child as a top-level undated row that Upcoming filters out entirely. Either way this assertion goes red.

**Selectors.** Chrome by handle (`tasks-group-attention`, `tasks-move-all`, `tasks-capture`, `tasks-band-inbox`, `tasks-band-upcoming`), content by its own words — seeded titles, the typed title, and the two sentences the board publishes about itself. The verb's copy stays asserted beside its handle: the handle proves a control was drawn, the words are what it promises.

**Marginal cost:** ~30 s on a journey that has already paid the boot, the pairing and the seed — the capture bar is already drawn at the foot of the board the flow is standing on, so the cost is one field, one tap, one band switch and one assertion.

**Verdict:** PASS only if the Overdue group draws with its verb and its meta AND the captured task lands in the Inbox the bar named AND Upcoming renders a nested subtask under its parent. A board that lists every seeded title flat, with no Overdue header, is passing arithmetic it never ran.
