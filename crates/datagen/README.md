# centraid-datagen

The chat model's training-data pipeline, in Rust ([#1166](https://github.com/srikanth235/centraid/issues/1166)). It drives the `centraid-assist` runtime as a library. Python stays only for the GPU trainer.

## State

Milestones M1 and M2 are built: stages 0 to 3, plus the ambiguity measure.

| Module | Stage | What it is |
| --- | --- | --- |
| `catalog` | 0 | `Catalog`: the only schema. 18 kinds, 18 `do` verbs with argument class, 48 fields, tools, compute ops, stock lists with their titles, sealed fields, and a BLAKE3 `hash()`. |
| `world`, `generate` | 1 | `World::generate(spec)`: a pure function of a `WorldSpec` (split, index, seed) and `Settings`. `plan(master)` makes the 60 specs: 48 train, 6 val, 6 test. |
| `ambiguity` | 1 | `measure(&World)`: shared-name groups, near-duplicate pairs, trashed rows and how many shadow a live name, per kind. |
| `persona`, `settings`, `pools`, `text`, `rng` | 1 | Who a world is about, its knobs, vocabulary, name arithmetic and the seeded stream. |
| `grid` | 2 | The coverage grid: primary cells (tool, kind, verb or op), each `Live`, `NotLive` or `Invalid`. |
| `intent` | 2 | The typed `Intent`, `TurnIntent` and `Scenario`, and the axes that are not cells (reference, outcome, span, dependency). |
| `facts` | 2 | A second, simpler reading of a world: its rows, fields, dates and links, and the set a selector selects. |
| `sample` | 2 | The intent sampler: a pure function of a seed and a world. |
| `plan` | 3 | The planner and execute: reference calls, run through the runtime, gold as its effect, and the drops. |
| `run` | 2 + 3 | Both stages over many worlds, the coverage report and the writer. |
| `source` | out | `DatagenSource`: the sessions as an `assist-eval` `EvalSource`. |

Everything after this (messages, verify, render, mix) is not built. New stages add modules beside these and read `Catalog`; none reads a schema from anywhere else.

### Where the catalog comes from

Nothing is copied by hand that the runtime states. Kinds, fields, fixed-list values, links and verbs come from `centraid_assist::native::meta` (generated from the app manifests); the owning app comes from the manifest that declares the kind; the stock `category` and `workout_kind` lists and their titles are read out of `contracts/migrations/001_baseline.sql`. Three things are written in `catalog.rs` because the runtime does not state them: the verb to argument-class table of the issue (a runtime verb it does not classify fails `Catalog::build`), the eight-tool surface and the compute ops. A tool or op is `live` when `meta::TOOLS` or `meta::OPS` has it, so merging a runtime change flips the flag and the hash with no edit here. `group` is the exception: the runtime runs it as the `group` argument of `compute` (a field, or `day`, `week`, `month`, `year`), not as an op, and is marked live on that ground.

### Worlds

A world is the seed document of `centraid_nativetools::seed`, so it seeds into a real vault through the vault's typed commands (`World::seed_into`) and the runtime reads it back. Settings: `shared_names` (people sharing a first name, other kinds repeating a title), `near_duplicates` (a row's name one typo, word or initial from another's), `trashed`, `history_days`. Each world draws its settings from the presets low, medium and high, jittered by its seed. The runtime reads three months of transactions and ninety days of health, so those two kinds hold at most that much whatever `history_days` says. Rows refer to living people only, because trashing a person trashes what is about them.

The owner's first name comes from a pool per split, so a val or test persona is a name no train world uses.

**Locker is presence only.** The world document names which secrets an item holds (`"sealed": ["password"]`) and never a value. `World::seed_document()` swaps in a placeholder so the vault holds something to reveal; the placeholder is never written to a world file, a prompt or a record. `reveal` is therefore not-live.

## The coverage grid (M2)

The full cross product of the issue's axes (tool, app/kind, verb, constraints, reference, outcome, span, turns) is tens of thousands of cells, and many are meaningless by construction (a `decline` with four constraints, a pronoun with nothing before it). "Every cell has a solvable intent" would be false or vacuous against it. So the grid is two things:

- **Primary cells**: (tool, kind, verb or op), derived from the catalog. Each is `Live` (the sampler draws it and the runtime serves it), `NotLive` (the runtime or the world cannot serve it; never faked) or `Invalid` (structurally meaningless, left out of every denominator). The coverage claim, and the test, are about live primary cells.
- **The other axes, as marginals** counted over every solved turn: constraints (0, 1, 2, 3, 4+, bucketed exactly as `assist-eval` does), reference (select, name, nickname, pronoun, handle, misspelling), outcome (done, empty, ask, decline, repair), span (single, across) and turns (1, 2, 3+). Declared pairs are counted too, so the places two axes interact are watched: outcome x tool, reference x tool, constraints x app (Money and Health) and span x turns. **Minimal pairs** are an axis, not a corpus: about one session in several is the twin of another that differs in one argument (a threshold, a period, an op, a date) and in its answer, tagged `pair:<id>` on both.

Constraints are weighted toward three and more in the draw; what is realised depends on the world, because a kind that carries few facets (a list, an album) cannot carry four constraints. The report prints the realised shares. Sessions are weighted toward several turns, and every follow-up leans on a turn before it.

### What is not live, and why

| Cell | Why |
| --- | --- |
| `find/budget/read`, `find/daily figure/read` | The seed document keys no budget or daily figure, so an eval cannot name the rows an answer shows. (Their values, through `compute`, are all live.) |
| `create/workout`, `create/daily figure`, `edit/workout`, `edit/daily figure` | Read-only on the runtime this was built against. The owner approved Health writes; they are not on `claude/assist-tool-regroup-d53912` yet, so these cells are live-pending and no intent is drawn for them (there is nothing to verify one against). |
| `create/photo`, `create/transaction`, `create/budget`, `create/rule`; `edit/budget`, `edit/category` | The runtime has no such write. |
| `edit/rule` | The runtime answers `edit does not apply to rule`. |
| `do/*/reveal` | Reveal opens a sealed value; a world carries only a placeholder, which must not reach a prompt. |
| `do/*/tag`, `do/*/untag` | A tag is a label row; no world seeds one, and `tag` of an unknown label changes nothing. |
| `do/*/archive`, `do/*/unarchive` | `archive` changes no field the diff can show, so a gold effect would be empty; no world seeds an archived row to bring back. |
| `do/album/restore` | No world puts an album in the trash. |
| `decline/-/never_mind` | The runtime ends that turn from the user's own words, and the placeholder has none. |
| `compute/{account,rule}/{sum,avg,min,max}` | The world document does not carry those number fields. |
| `compute/{transaction,workout,daily figure}/compare` | Live now (the merged regroup has `compare`); the catalog reads this from `meta::OPS`, so a runtime without it marks them not live. |

## Intents (stage 2)

An `Intent` is the meaning of one turn in the vocabulary of the vault, not text: `Read`, `Count`, `Measure` (sum, avg, min or max of a number field, optionally grouped by a field or a period), `Compare` (two measures set side by side), `Write` (a `do` verb on a row), `Edit`, `Create`, `Recall` (an earlier result shown again), `Ask` (a name more than one row answers to) and `Decline`. A `Scenario` is a session's turns; each turn records how it points at rows (`Reference`), how it ends (`Outcome`), and which earlier turn it leans on and how (`Dep`: pronoun, handle, narrow, carry, undo).

The sampler is a pure function of the seed and the world, and is target-first: it picks a row the world holds, reads constraints off it (its status, a threshold it clears, the period it falls in, the container it sits in) and only then writes the selector, so a selector always selects at least its target. Money and Health get real depth: sums, grouping by category, account, month or week, budget against spent, trends in daily figures (average by week), comparing workouts (two kinds of workout over one month, or one week against the last), and date ranges. Across-app means one turn that joins two apps (a selector linked to a row of another app, a period read off an event) or a turn that leans on a turn of another app; two unrelated questions in two apps are not across. Cross-app intents take the days around an event as their period (the workouts, spend or photos "around the dentist"), link rows across apps (tasks linked to a person), or hop a follow-up to another app over the days the rows of the turn before fall in. A follow-up always leans on an earlier turn: by pronoun ("complete it"), by handle (an earlier result, not the turn before's), by narrowing the rows just shown, by carrying the question to another period or another app, or by undoing the write.

## Planner and execute (stage 3)

The planner writes the reference calls in the decided shapes: a read is `find` then `answer rows=@k`, a count is `compute` then `answer value=@k`, a by-name write is `find` then `do`/`edit rows=@k`, a comparison is two `compute`s then `compute op=compare rows=@a,@b` then `answer value=@k`. `answer` takes no selector or `op`. Calls use names, `@k` handles read back from each response, compact date expressions (`{"unit":"month","rel":-1}`, or an explicit span) and a lookup of any container, person or event they link to. They never use a prompt's `#n`, a `dates[i]` or a `$key`: the user's text is not written yet, and M3 writes it from the scenario.

Each call goes through `Session::call_text`, the path the eval uses, on a private copy of the world's vault. Gold is the runtime's effect (`assist_eval::effect::turn_effect`): rows by world key (`+N` for a row the session created), values by currency, a group's values by key, an ask's options, a decline's reason, a write's net diff.

**Solvable** means three things at once. The reference calls run without an unplanned error. The rows or value the runtime returns are what `facts` says the constraints select, so a runtime misreading is never recorded as gold. And a by-name write found exactly the row it meant. An intent that fails is dropped and counted by reason:

| Drop | Meaning |
| --- | --- |
| `overmatch` / `undermatch` | The runtime returned more or fewer rows than the constraints select. |
| `value` | The runtime and the index disagree on a figure, or on how a turn is ordered. |
| `ambiguous` | A name that should find one row found several. |
| `not_found` | A name or lookup that should find a row found none. |
| `not_unique` | A write selected more or fewer rows than one. |
| `too_many` | More rows than an answer shows. |
| `error` | A call the plan did not expect to fail failed. |
| `noop` | The write changed nothing. |
| `ending` | The turn ended some other way than planned. |
| `no_target` | The world has nothing to draw the intent from. |

A turn that cannot be solved ends its session there: the turns before it are kept as a shorter session tagged `truncated`.

## Output

`datagen intents` writes `<out>/<split>/sessions.jsonl` (one session a line), `<out>/worlds/<id>.json` (the world, presence-only), `report.txt` and `manifest.json` (catalog hash, master seed, counts, the grid and the per-cell numbers).

A line is a session in the shape `assist_eval::gold::Session` reads, with more beside it:

```json
{"id": "train-00-0042", "world": "train-00", "today": "2026-10-12T09:00", "me": "Alex Park",
 "tags": [],
 "turns": [{"user": "⟨m3:train-00-0042:t1⟩", "gold": [{"type": "rows", "rows": ["t7"]}],
            "ref": [{"tool": "find", "args": {…}}, {"tool": "answer", "args": {"rows": "@1"}}],
            "tags": ["outcome:done", "reference:select"], "constraints": 3}],
 "scenario": {…}}
```

- **`user` is a placeholder**: `⟨m3:<session>:t<n>⟩`. It matches no name in any vault and reads as no retraction, so the runtime's grounding sees an empty message and the calls do not depend on it. `plan::is_placeholder` tells a placeholder from a real message; M3 replaces it. The eval ignores `scenario` and `constraints`.
- **`scenario`** is the typed scenario, kept next to the session for M3 to write the user text from.
- `ref` lists every reference call in order; a call the runtime was expected to refuse (the first half of an error-then-repair turn) carries `"bad": true`.
- A world is read back from `worlds/<id>.json` with its sealed placeholders put back in memory by `DatagenSource`, so the vault the eval seeds is the one gold was recorded against; the placeholder document is never written.

`DatagenSource` implements `assist_eval::source::EvalSource`, so a run plugs straight into the eval. `DatagenSource::open(dir, split)` reads a written run; `DatagenSource::new` takes records and world documents in memory.

## Commands

```sh
cargo run -p centraid-datagen -- catalog [--out catalog.json]
cargo run -p centraid-datagen -- worlds --seed 1 --out out/ [--counts 48,6,6] [--vaults]
cargo run -p centraid-datagen -- ambiguity --seed 1 [--counts 48,6,6] [--json]
cargo run --release -p centraid-datagen -- intents --seed 1 --out out/ [--counts 48,6,6] [--sessions 18000,1000,1000 | --per-world N[,N,N]]
```

`worlds` writes `<out>/<split>/<id>.json` (and `.vault` with `--vaults`) and `manifest.json`. `intents` runs stages 2 and 3 over the worlds of the run and prints the coverage report (also `report.txt`): the grid's size and its not-live cells, solvable intents per live cell (kept / drawn, with drop reasons), the shares along each axis, and the multi-turn share. Each world visits every live cell once as the first turn of a session, then keeps drawing until it has `--per-world` sessions (default: one per live cell); `--sessions train,val,test` derives it from the targets. Use `--release` for a long run: the first run's 20,010 sessions over 60 worlds take about an hour and a half in release. `DATAGEN_DEBUG=1` prints every drop with the intents that led to it. The package is `centraid-datagen`; the binary is `datagen`.

## What the runtime and the worlds showed (open questions)

Found while making the intents solvable; each is either a product call or a runtime item, not decided here.

- **`edit category` on a transaction is refused** (`category cannot be edited; transaction editable fields: name`), although the issue's own example of re-categorising is `edit category`. Transaction edits are drawn as renames.
- **A money threshold in `where` passes no row in another currency than the vault's.** Seen as a transaction in a second currency matching no `amount <= -9`. Sums keep the currencies apart (one figure per currency).
- **`when` never selects budgets**: `compute kind=budget when=<month>` is 0 for every month. Budgets are selected by name (`Groceries 2026-09`).
- **`undo` after `log` or `cancel` changes nothing.** The undo pairs are drawn after the other writes.
- **`tag` and `archive` produce no diff** (`no field changed`).
- **Subtasks hide with a trashed parent**, but are not completed with a completed one; the seeder runs the second before the children exist.
- **An empty `find` by filters issues an `@k`** on the regrouped runtime (991924658, merged), so an empty read is `find` then `answer rows=@k`. A by-name miss (`name=` matching nothing) issues none, so an empty read is drawn from a period or a threshold, not a name. `WorldRun::empty_reads` probes this once per world; the sampler draws no empty read on a runtime without it. Empty counts are drawn either way.
- **A `where` on a transaction's category reads the title** (`Clothes and household`), not the leaf notation (`shopping.general`), which selects nothing. The facts and the filters use the title.
- **`create` and `edit` carry fields flat** in commit 5005b1afb, which is on `claude/vibrant-yalow-a14a45` (the per-step grammar), not on the regroup branch. Reference calls here send fields as `args` lines, the shape the merged runtime reads; if the flat shape reaches the base, the planner's `change_lines` changes with it.
- **`judge_args` in `assist-eval` compares a write's verb as `act`**, so per-argument blame is off for regrouped calls (the effect-based pass/fail is not).
- No world puts an album in the trash, so `do/album/restore` is not live.
- `find` shows 6 of more than 12 matches; reads here are drawn with 12 rows or fewer.

## Tests

`cargo test -p centraid-datagen`. The intents tests run three worlds with more rows in the trash than a preset puts there (a `restore` needs one) and hold: a run is a pure function of its seed; every live cell has a solvable intent; the shares (multi-turn, three or more turns, across-app, three or more constraints among the turns that select by constraints); each follow-up leans on an earlier turn; each minimal pair differs in its answer; **replaying every session's reference calls through `assist_eval::run::Runner` passes every turn**, so gold is the runtime's effect reproduced and the eval loads what datagen writes; and a written run opens as an `EvalSource` with its worlds. `-- --ignored` also seeds all 60 worlds (about two minutes).
