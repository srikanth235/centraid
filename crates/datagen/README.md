# centraid-datagen

The chat model's training-data pipeline, in Rust ([#1166](https://github.com/srikanth235/centraid/issues/1166)). It drives the `centraid-assist` runtime as a library. Python stays only for the GPU trainer.

## State

Stages 0 to 7 are built (the intents, the messages, the render and the mix), plus the ambiguity measure, the repair families, the style grid and `datagen publish`. `datagen build --version vN` makes a data version end to end; `datagen publish` puts it on the Hugging Face dataset repo. The data is for a LoRA adapter on the stock Qwen3.5-0.8B base handling vault turns of the chat assistant; it is all synthetic and English, and the correct answer of every turn is what the runtime does when the reference calls are run, never what a model says.

| Module | Stage | What it is |
| --- | --- | --- |
| `catalog` | 0 | `Catalog`: the only schema. 18 kinds, 18 `do` verbs with argument class, 48 fields, tools, compute ops, stock lists with their titles, sealed fields, and a BLAKE3 `hash()`. |
| `world`, `generate` | 1 | `World::generate(spec)`: a pure function of a `WorldSpec` (split, index, seed) and `Settings`. `plan(master)` makes the 68 specs: 48 train, 8 val, 12 test. |
| `ambiguity` | 1 | `measure(&World)`: shared-name groups, near-duplicate pairs, trashed rows and how many shadow a live name, per kind. |
| `persona`, `settings`, `pools`, `text`, `rng` | 1 | Who a world is about, its knobs, vocabulary, name arithmetic and the seeded stream. |
| `grid` | 2 | The coverage grid: primary cells (tool, kind, verb or op), each `Live`, `NotLive` or `Invalid`. |
| `intent` | 2 | The typed `Intent`, `TurnIntent` and `Scenario`, and the axes that are not cells (reference, outcome, span, dependency). |
| `facts` | 2 | A second, simpler reading of a world: its rows, fields, dates and links, and the set a selector selects. |
| `sample` | 2 | The intent sampler: a pure function of a seed and a world. |
| `plan` | 3 | The planner and execute: reference calls, run through the runtime, gold as its effect, and the drops. |
| `run` | 2 + 3 | Both stages over many worlds, the coverage report and the writer. |
| `brief`, `messages` | 4 | A typed turn put into English for the writer; the writer (batched JSON in, JSON out), the mechanical checks and the pipeline of stages 4 and 5, with a writer and a reader per split (`Models`). |
| `style` | 4 | The style grid (terse, dictated, typos, long and polite, correction), one style per session, with the test split's own wording. |
| `llm`, `rehearsal` | 4 + 5 | The `Llm` trait, a model through headless Claude Code (`ClaudeCli`, the model name is configuration), the prompt-hash cache, and the offline rehearsal model that makes no call. |
| `typos` | 4 | The seeded typo pass: light by default, heavy for the noise split. |
| `verify` | 5 | Runtime grounding (the session solved afresh against the real messages) and the read-back pass, slot by slot. |
| `fields` | 2 + 7 | The (kind, field) pairs `create` and `edit` can set through the tools, derived from the runtime's tables, each live or not live with the reason; the pairs a turn sets. |
| `labels` | 7 | What a typed turn is for the mix: outcome, action, how it points at a row, whether it asks for the impossible, the kinds it touches, the (kind, field) pairs it sets, the combinations it is an instance of. |
| `mistakes` | 3 | The refusal families a repair turn is built from, and `--mistakes` (refused calls read from a model's rollouts). |
| `source` | out | `DatagenSource`: the sessions as an `assist-eval` `EvalSource`, from a run (`open`) or from a data version (`open_version`). |
| `trace` | 6 | The v4 think of a reference call, and the round trip through the runtime's compiler. |
| `render` | 6 | A session rendered as the phone renders it, the model's tokenizer (`bpe.rs`), the loss weights of every token. |
| `mix` | 7 | Duplicates out, pairs together, the shares by what the model decides, the cell floor and the field floor, the ceilings on pronoun references and undo turns, the reserved combinations, nested subsets and the report of what could not be hit. |
| `bpe` | 6 | The model's byte-level BPE, read from its `tokenizer.json`. |
| `rollout` | 11 | M7's rollout records rendered by the M4 renderer (`datagen rollout-records`). |
| `version` | 6 + 7 | Render all, mix, write a data version (`manifest.json`, `data/`, `worlds/`, `build/`); pack and unpack its LLM cache. |
| `publish` | 8 | Check a built version and publish it to a Hugging Face dataset repo (a dry run unless told otherwise). |

New stages add modules beside these and read `Catalog`; none reads a schema from anywhere else.

### Where the catalog comes from

Nothing is copied by hand that the runtime states. Kinds, fields, fixed-list values, links and verbs come from `centraid_assist::native::meta` (generated from the app manifests); the owning app comes from the manifest that declares the kind; the stock `category` and `workout_kind` lists and their titles are read out of `contracts/migrations/001_baseline.sql`. Three things are written in `catalog.rs` because the runtime does not state them: the verb to argument-class table of the issue (a runtime verb it does not classify fails `Catalog::build`), the eight-tool surface and the compute ops. A tool or op is `live` when `meta::TOOLS` or `meta::OPS` has it, so merging a runtime change flips the flag and the hash with no edit here. `group` is the exception: the runtime runs it as the `group` argument of `compute` (a field, or `day`, `week`, `month`, `year`), not as an op, and is marked live on that ground.

### Worlds

A world is the seed document of `centraid_nativetools::seed`, so it seeds into a real vault through the vault's typed commands (`World::seed_into`) and the runtime reads it back. Settings: `shared_names` (people sharing a first name, other kinds repeating a title), `near_duplicates` (a row's name one typo, word or initial from another's), `trashed`, `history_days`. Each world draws its settings from the presets low, medium and high, jittered by its seed; every eighth world is a **very large vault** (`LARGE`: sixteen times the rows, a year of history, so a kind passes the runtime's window of the 500 newest rows and the runtime's own refusals show; gold is whatever the runtime does) and every eighth after it is a **new member's empty vault** (`EMPTY`: no rows at all). Each of the three splits holds both, and `Settings::scale` is the size knob. The runtime reads three months of transactions and ninety days of health, so those two kinds hold at most that much whatever `history_days` says. Rows refer to living people only, because trashing a person trashes what is about them.

The owner's first name comes from a pool per split, so a val or test persona is a name no train world uses. People, owners and new names include Indian names (the pools stay disjoint per split), and a share of worlds keep their money in rupees (`INR`, amounts scaled to rupee sizes). **Today** is spread over a year: every weekday, the month ends of a year (September 2026 to August 2027) and the year boundary (31 December to 2 January) each occur (`generate::today_of`; the splits use shifted calendars). **`lakh` and `crore` are not taught**: the runtime does not resolve them (a number in a message is read as written), so the writer is told to use plain numbers, `k` and `rupees`, never `lakh`, `crore` or the rupee sign.

**Locker is presence only.** The world document names which secrets an item holds (`"sealed": ["password"]`) and never a value. `World::seed_document()` swaps in a placeholder so the vault holds something to reveal; the placeholder is never written to a world file, a prompt or a record. `reveal` is therefore not-live.

**A secret the member types is the one secret a message may carry.** Chat is meant to create Locker secrets, so create and edit intents for a login's `password` and one-time `code`, a card's `card_number` and `cvv`, and the text of a secret `note` item carry a synthetic typed value, drawn from the lists of `pools::typed(split)` (`passwords`, `card_numbers`, `cvvs`, `codes`, `notes`, and the plain `usernames` and `urls`). Every value is fake on its face (`fake-heron-4417`, `0000 1111 2222 3333`), and a split never shares one with another: a test asserts it and that none holds a word the runtime reads as a date or a retraction. Nothing a vault stores is ever one of them: `messages::no_sealed` and the world placeholders are exactly as strict as before, the diff of gold records that a secret was set (`sealed`) and never the value, and a typed value appears in a prompt only as a `typed_secret` of the turn the member types it in. The runtime seals a typed value when the card is confirmed, and an undo cannot put an earlier sealed value back, so no undo follows an edit that types one.

## The coverage grid (M2)

The full cross product of the issue's axes (tool, app/kind, verb, constraints, reference, outcome, span, turns) is tens of thousands of cells, and many are meaningless by construction (a `decline` with four constraints, a pronoun with nothing before it). "Every cell has a solvable intent" would be false or vacuous against it. So the grid is two things:

- **Primary cells**: (tool, kind, verb or op), derived from the catalog. Each is `Live` (the sampler draws it and the runtime serves it), `NotLive` (the runtime or the world cannot serve it; never faked) or `Invalid` (structurally meaningless, left out of every denominator). The coverage claim, and the test, are about live primary cells.
- **The other axes, as marginals** counted over every solved turn: constraints (0, 1, 2, 3, 4+, bucketed exactly as `assist-eval` does), reference (select, name, nickname, pronoun, handle, misspelling), outcome (done, empty, ask, decline, repair), span (single, across) and turns (1, 2, 3+). Declared pairs are counted too, so the places two axes interact are watched: outcome x tool, reference x tool, constraints x app (Money and Health) and span x turns. **Minimal pairs** are an axis, not a corpus: about one session in several is the twin of another that differs in one argument (a threshold, a period, an op, a date) and in its answer, tagged `pair:<id>` on both.

Constraints are weighted toward three and more in the draw; what is realised depends on the world, because a kind that carries few facets (a list, an album) cannot carry four constraints. The report prints the realised shares. Sessions are weighted toward several turns, and every follow-up leans on a turn before it.

### What is not live, and why

| Cell | Why |
| --- | --- |
| `find/budget/read`, `find/daily figure/read` | The seed document keys no budget or daily figure, so an eval cannot name the rows an answer shows. (Their values, through `compute`, are all live.) |
| `create/photo`, `create/transaction`, `create/budget`, `create/rule`; `edit/budget`, `edit/category` | The runtime has no such write. |
| `create/daily figure` | A world follows a Health store, and the runtime answers a create with `These figures come from Health; change them there, not here`. A workout the member logs is made (`create/workout/create` is live). |
| `edit/rule` | The runtime answers `edit does not apply to rule`. |
| `do/*/reveal` | Reveal opens a sealed value; a world carries only a placeholder, which must not reach a prompt. |
| `do/*/tag`, `do/*/untag` | A tag is a label row; no world seeds one, and `tag` of an unknown label changes nothing. |
| `do/*/archive`, `do/*/unarchive` | `archive` changes no field the diff can show, so a gold effect would be empty; no world seeds an archived row to bring back. |
| `do/album/restore` | No world puts an album in the trash. |
| `decline/-/never_mind` | The runtime ends that turn from the user's own words, and the placeholder has none. |
| `compute/{account,rule}/{sum,avg,min,max}` | The world document does not carry those number fields. |
| a money field (`amount`, `opening`) on `create` or `edit` | The runtime sets none: a transaction and a budget are not created in chat, a new account's `opening` is dropped (`create_arg_dropped`), and `edit` answers `<field> cannot be edited`. No money amount is drawn on create or edit; `fields::pairs` lists each as not live with the runtime's reason and `proofs.rs` replays the runtime's answers. |
| `compute/{transaction,workout,daily figure}/compare` | Live now (the merged regroup has `compare`); the catalog reads this from `meta::OPS`, so a runtime without it marks them not live. |

### Fields are a balanced dimension

`fields::pairs` derives, from `meta::create_args`, `meta::edit_actions` and the kind's fields, every (kind, field) pair `create` and `edit` can be asked to set, written `create/task/priority`. A pair is live when the create or edit cell is live, the runtime sets it and the sampler draws a value for it (`sample::draws_field`); the rest are listed as not live with the reason: a field that names another row by `#n` (`task` `list` and `parent`, `note` `notebook`, `document` `folder`), a workout's `end` and `type` (the runtime shows no effect of them), a daily figure's `value` (a followed store states it) and every money field. The set is the tools' own, so a field added to a manifest appears as a pair that is not live until a draw is written for it.

The run draws target-first over the live pairs: each is a draw of its own in every world's sweep (`run::FIELD_DRAWS`), aimed at the pair (`sample::Aim.field`), and the sampler sets the aimed field and, now and then, others. A create sets any field the kind takes: a person's nickname, cadence and role, an event's duration and description, a task's priority, effort and description, a note's body, a list's area, a document's text, a workout's figures, a locker item's secrets and plain fields. An edit changes one field of a row by name, nickname, misspelling or filters (a second plain field a quarter of the time) to a value the row does not have; a Locker secret is edited only on an item whose type keeps it. The only workouts a member can edit are ones they logged, so an edit of a workout figure is a session of a create then the edit of the row just made. The mix reads the pairs a kept turn sets (`labels::fields`, an edit the runtime refused sets none), balances them like cells (an equal share of the turns that set one, and a floor of `--field-floor` turns per live pair in train, default 30) and reports `hit`, `supply` or `short` per pair.

### Intents beyond a plain draw

- **Locker secrets.** Described under Locker above: a password, a card number and security code, a one-time code and a secret note are created, and a password, card number, security code and one-time code edited, with typed values.
- **Measurements.** A workout the member logs carries its figures with their units (`moving` s, `distance` m, `energy` kcal, `heart_rate` bpm, `climb` m); the brief gives the unit (`distance (m) to 5000`) and the writer may say a natural unit that is exactly equal (5 km). The read-back asks for numbers in base units. A task's `effort` and an event's `duration` (min) and a person's `cadence` (days) are measurements too.
- **Options of `find`.** The tool takes `kind`, `name`, `where`, `when`, `order`, `limit`, `linked_to`, `within`, `rows`, `text`, `trashed`, `exclude`. A plain draw never used `text`, `trashed`, `rows`, `exclude`, a comma list of kinds, and the operators `!=`, `contains`, `in (...)`, `is empty` and `is set` of `where`. Drawn now: `text` (a fuzzy search by one word of a name), `trashed` (the rows in the trash) and `!=` (`status != open`). The brief says each in words, the word searched for is a verbatim span and the read-back is asked for the names and the values ruled out. Not drawn yet: `rows`, `exclude`, a comma list of kinds, `contains`, `in`, `is empty`, `is set`, and the forms of `when` that name a weekday, a month, a time or an open end.
- **Rare outcomes at the source.** Nothing found, ask, decline (and its impossible reasons) and a row said by a nickname or a misspelling are weighted in the sweep (`run::weight`, `EMPTY_DRAWS`, `NICKNAME_DRAWS`) so the supply holds at least each one's target share of the drawn turns; a unit test counts it.
- **Ceilings.** Pronoun and handle references are capped at their share of the turns that point at a row (20%) and undo turns at `mix::UNDO_CAP` (4% of the turns). The run stops drawing a capped share once its kept turns hold it (`sample::Room`, `run::Filled`), and the mix leaves out a unit that would take the share over, so the realised share never exceeds the cap. The one exception in the sampler is the edit of a workout the session logged, which is a pronoun turn by construction and the only way to reach the workout-figure pairs: it is drawn when aimed, and the mix's ceiling holds the share.

## Intents (stage 2)

An `Intent` is the meaning of one turn in the vocabulary of the vault, not text: `Read`, `Count`, `Measure` (sum, avg, min or max of a number field, optionally grouped by a field or a period), `Compare` (two measures set side by side), `Write` (a `do` verb on a row), `Edit`, `Create`, `Recall` (an earlier result shown again), `Ask` (a name more than one row answers to) and `Decline`. **Names a request gives** (`create`, and `edit` of a name) come from a pool per kind in `pools.rs` (`NEW_TASKS`, `NEW_EVENTS`, `NEW_LISTS`, `NEW_NOTES`, `NEW_NOTEBOOKS`, `NEW_LOCKER`, `NEW_ALBUMS`, `NEW_FOLDERS`, `NEW_DOCUMENTS`, `NEW_ACCOUNTS`, `NEW_CATEGORIES`, `NEW_PHOTOS`, `NEW_TRANSACTIONS`, `NEW_WORKOUTS`), so a person is never "Plan the weekend" and a notebook is never a chore. A new person is `first last` from `NEW_FIRST_*` and `NEW_LAST_*`, which share nothing with the names worlds give their people (`FIRST`, `LAST`, `ME_*`) and are split like the owner's: a val or test person is a name no train create uses. A locker item or account is made with the type its pool entry names. A name never carries a number. The sampler picks one that no row of the kind, live or trashed, already has (for a person, no row with the same first name or nickname either) and that differs from the current name on a rename and from the row the session just made; a pool spent in a world falls back on "Recipes 2", which `report.txt` counts (`names numbered because a kind's name pool was spent`, 0 in normal runs). Pool names hold letters and spaces only and none of the words the runtime reads as a date, a period, a turn's verb or a retraction, so the M3 span check and the typo pass keep them verbatim; `pools.rs` tests hold every pool to that.

A `Scenario` is a session's turns; each turn records how it points at rows (`Reference`), how it ends (`Outcome`), and which earlier turn it leans on and how (`Dep`: pronoun, handle, narrow, carry, undo).

The sampler is a pure function of the seed and the world, and is target-first: it picks a row the world holds, reads constraints off it (its status, a threshold it clears, the period it falls in, the container it sits in) and only then writes the selector, so a selector always selects at least its target. Money and Health get real depth: sums, grouping by category, account, month or week, budget against spent, trends in daily figures (average by week), comparing workouts (two kinds of workout over one month, or one week against the last), and date ranges. A session **touches two kinds** when one turn names two kinds (a selector linked to a row of another kind, a period read off an event) or a later turn leans on a turn of another kind (`labels::kinds`); the mix targets 20% of sessions. The app is a tag and a line in the report, not a target. Cross-app intents take the days around an event as their period (the workouts, spend or photos "around the dentist"), link rows across apps (tasks linked to a person), or hop a follow-up to another app over the days the rows of the turn before fall in. A follow-up always leans on an earlier turn: by pronoun ("complete it"), by handle (an earlier result, not the turn before's), by narrowing the rows just shown, by carrying the question to another period or another app, or by undoing the write.

## Planner and execute (stage 3)

The planner writes the reference calls in the decided shapes: a read is `find` then `answer rows=@k`, a count is `compute` then `answer value=@k`, a by-name write is `find` then `do`/`edit rows=@k`, a comparison is two `compute`s then `compute op=compare rows=@a,@b` then `answer value=@k`. `answer` takes no selector or `op`. Calls use names, `@k` handles read back from each response, compact date expressions (`{"unit":"month","rel":-1}`, or an explicit span) and a lookup of any container, person or event they link to. They never use a prompt's `#n`, a `dates[i]` or a `$key`: the user's text is not written yet, and M3 writes it from the scenario.

An `Edit` of a `workout` or a `daily figure` the world holds has the outcome `decline`: every seeded world follows a health store, which states those rows, so the runtime refuses the edit with the vault's sentence naming the store ("This workout comes from Health; change it there, not here.") and ends the turn on it. The reference is the one `edit` call; gold is a decline, and a turn that ends any other way is dropped. An edit of a workout the session logged is an edit like any other: it is drawn as the second turn of a session that creates the workout.

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

### Repairs (`mistakes.rs`)

A repair turn shows a call the runtime really refuses, the runtime's own refusal as its observation, and the reference call as the repair. The bad call is built from the catalogue (the kind's own fields, fixed lists and verbs) in one of eleven families that mirror the runtime's refusal catalogue (`contracts/assist/export/errors.json`, the nativetools errors): `wrong_field_for_kind`, `unknown_list_value`, `no_date_on_kind` (a `when` on a kind with no date), `unknown_kind`, `bad_order_field`, `limit_not_a_number`, `unknown_verb`, `missing_argument` (a `do` that needs an argument), `empty_edit`, `create_takes_no_rows` and `row_not_shown`. The family is chosen by a hash of the turn, so a rebuild chooses the same one, and is tagged `mistake:<family>` on the turn. The planner demands that the runtime refuses it (`Step.bad`); a family the runtime stops refusing shows as `error` drops, and `tests/mistakes.rs` runs every family on every kind it applies to against a real vault, and checks it is refused for the reason it names. The bad call stays at weight 0 in the loss.

Three things the runtime states differently from the issue's list, found by that test: **a verb the kind lacks** (`reschedule` on a document) and **an edit of a kind that cannot be edited** (a category, a budget; a daily figure or workout that Health keeps) end the turn on the runtime's `does_not_apply` or health-store decline, not on an error, so they are decline turns, never repairs; and **`create` does not validate a field**, so a create with the wrong field or an unknown list value is accepted and no repair is built from it.

`--mistakes <file>` (on `intents` and `build`) takes refused calls from a model's rollouts, in the format `assist-eval rollout` writes (`*.rollouts.jsonl`, one session a line): the calls of every turn with `error_steps > 0`. A repair turn that reads shows one of these, run through the runtime again, in place of a constructed read mistake. Only reads are taken, because a rejected read changes nothing and a write the runtime accepted would change the vault; a call that cannot be spelled as a reference call (an argument name outside `kind, name, where, when, order, limit, linked_to, within, rows, op, field`) is counted and left out, and one the runtime now accepts is a drop.

## Messages and verify (stages 4 and 5)

`datagen messages --in <intents out> --out <dir>` turns each typed turn into what a person types on a phone, then checks the text still means the intent. One command, five steps, each a pure function of its input, the seed and the cache:

1. **Write** (a model through headless Claude Code, `claude -p --model <name>`, no API key; the name is the `--writer` flag). Each session has a **style** ([Style grid](#style-grid)) and the batch is sent as JSON; sessions are batched (`--batch`, default 12) and sent as JSON; the answer is JSON. The prompt for a turn is its **brief** (`brief.rs`): what it asks in the vault's words (the rows, the filters with their units, the period resolved from `today`, the new values), the strings it must say verbatim (`say_verbatim`: the names, titles and notes the reference calls copy), and how it points at rows (the reference axis: say the name as quoted, say the nickname, copy the misspelling, use a pronoun and do not name the row again, point back at an earlier answer; and, for a follow-up, which turn it leans on and that it must be short). A turn that creates or edits a Locker secret also lists the typed value as `typed_secret` and the prompt then says it is the one exception to the rule about passwords (a prompt with no such turn is byte-for-byte as before). It never sees a tool call, a handle (`@k`, `#n`) or a world value that is sealed: a world is presence-only, `messages::no_sealed` refuses any prompt holding a sealed placeholder, and a test asserts that none reaches one. A session the answer does not cover is asked again in a later batch (a different prompt, so a different cache entry), up to three times, then dropped with reason `writer`.
2. **Check** (mechanical). No placeholder, ISO date, line break or text over 240 characters (`hygiene`); every `say_verbatim` string is in the message, compared without case (`span`); a pronoun or handle turn does not repeat a name an earlier turn said (`reference`).
3. **Typos** (`typos.rs`, `rng.rs`, seeded by session and turn). Light by default: about a third of messages carry one slip (a dropped, doubled, swapped or neighbouring-key letter, first letter kept). It never touches a span, a word with a digit, or a date word (`last`, `week`, `march`, `yesterday`). The **noise split** is a heavy-typo copy of every val session (`noise/`, ids end in `~noise`), grounded like the rest and not read back.
4. **Ground** (`verify::ground`). The session is solved again by the planner with the real message in place of the placeholder (`WorldRun::solve_with`). The runtime reads the message (names it finds, dates it reads, a retraction ends the turn), so this is what "the runtime finds the same rows and dates" means: gold must be unchanged, the reference calls are written afresh (what `#n` a row gets depends on what the message made the runtime show), the message must not read as a retraction (`grounding:retraction`), every row the turn points at by name must be listed in the runtime's `vault:` line (`grounding:name`; a trashed row is not looked for), and when the intent has a period the `dates:` line must read its first day (`grounding:dates`). Any change of gold or any other planner drop is `grounding:<drop>`.
5. **Read back** (the `--reader` model, again batched). A second pass sees only the messages, with no brief, and says per message: the act (read, count, sum, avg, min, max, compare, create, edit, recall, undo, decline, or one of the `do` verbs), the kind, the period as `from`/`to` dates, the numbers in base units, which earlier message it leans on, a decline reason, **every filter on a fixed-list or text field** (`{field, value}`, with the fixed lists in the prompt), **every name** and **every exclusion**. These slots are compared with the typed intent (`verify::slots`, `verify::agree`): `act`, `kind` (not asked when a row is named or the turn refers back), `period` (exact days), `number` (every number the intent carries, by absolute value), `leans` (only for a pronoun or handle turn), `decline`, `filter` (every equality filter the intent carries must be read back, field and value), `name` (every name the words carry: a named row, a row a selection is linked to or reads a period off) and `exclusion` (a turn that rules out no value has none, so a reader that reports one read something the words did not say; a `!=` filter must be read back as ruled out) and `typed` (a value the member types in to be stored, as written, with spaces and case ignored; the reader is asked for it only in a batch that has one, so a batch without one has the prompt it had). The share of read turns that agree is the **recovery rate**, and `report.txt` and `models.json` give it **per slot** (asked, recovered).

A turn that fails a step is dropped with a reason, and the turns after it are cut (they lean on it); the turns before it stay as a shorter session tagged `truncated`. The report counts a cut turn separately and never as a drop of its own cell.

**Cache.** `<out>/llm-cache/<hh>/<hash>.json` holds each model output under the BLAKE3 hash of the model name and the exact prompt (one file per prompt, written whole then renamed). A rebuild with a warm cache makes zero calls and writes byte-identical files (tested with a fake model, and by hand with `--offline` on the real run); `--offline` makes a miss an error instead of a call. Copy the cache with the data version. A model's name is part of every key, so each split's writer and reader keep their own entries in one cache directory.

**Output** (`<out>/`): `train|val|test|noise/sessions.jsonl` in the shape above with `user` filled and `reference calls` rewritten against the real message, plus `"verify": {"keep": true, "passed": [...], "reason": "ok"}` on each turn and `scenario` cut to the kept turns; `dropped.jsonl` (one row per session that lost a turn: split, session, turn, grid cell, reference, reason, detail, the message, how many turns were cut); `worlds/` (copied, so `DatagenSource::open(<out>)` and `open_named(<out>, &["noise"])` read the result unchanged); `manifest.json` and `report.txt` (drop rate per grid cell, per reference axis and per split with the reasons, the recovery rate and its disagreements by slot, the noise split, examples). Files hold no call counts; the command prints them to stderr.

### Writers, readers and the style grid

`--writer` and `--reader` take one model for every split (`haiku`) or one per split (`train=haiku,val=haiku,test=sonnet`); the defaults write train and val with one model and test with another, and read back with a third and with the first. **The build refuses** (`messages::Models::check`, before any call) a split whose reader is its own writer, and a test split written by train's writer: the test messages are in a voice the training messages are not. `rehearsal` and `rehearsal-b` are the library's offline stand-ins (`rehearsal.rs`): they make no call, write `show <words> q<number>` and read the number back from the intents, so a whole build runs offline to try the plumbing; a version either of them touched is marked not publishable. Every session record carries the tags `style:<name>` and `writer:<model>`, and `models.json` (copied to `build/`) lists the writers, the readers and the realised styles.

<a id="style-grid"></a>**Style grid** (`style.rs`): terse, dictated (lowercase, no punctuation), typos (the writer is told to type fast and the seeded pass uses its heavy level), long and polite, and correction (each message after the first takes back the one before it; never given to a one-turn session). `--style-shares terse,dictated,typos,long_polite,correction` (default 0.40,0.15,0.15,0.15,0.15); the style of a session is a hash of its id. The writer is a model, so the report gives the realised share twice: sessions given each style, and how many written sessions really keep to it (by words and marks: at most ten words and no punctuation and so on). The test split's style prompts are worded differently from the others and train never uses them (tested).

**Ask-or-act pairs** (H4): the same message in two worlds, where the name fits one row in one world (the act side) and several in the other (the ask side). They are tagged `pair:askact:<id>` and `askact:ask|act` and kept together in a split like minimal pairs. The writer writes the ask side's message once; the act side says it word for word (after the typos), so the pair differs in the world and nothing else, and is grounded and read back in each world on its own. A pair whose ask side was dropped drops the act side with reason `pair`.

## Render and mix (stages 6 and 7)

`datagen render --in <messages out> --out <dir> --tokenizer <tokenizer.json>` renders every session of a messages run and mixes the result into a data version. `datagen build --version vN --out <dir> --tokenizer <tokenizer.json>` runs intents, messages (from the cache; `--offline` makes no call), render and mix, the stages under `<dir>/stages/` (working files, not published) and the version in `<dir>/`. `datagen show --in <dir> --tokenizer <tokenizer.json> [--split train] [--session ID]` prints one record decoded with its mask drawn on it.

### The record contract (what M6 reads)

A data version is this tree. It is published as one tag in each of two private dataset repositories, the data repo `srikanth235/centraid-assist-data` and the held-out repo `srikanth235/centraid-assist-heldout` (`v0.2`, `v0.3`, ...); readers pin a tag, and a tag is never overwritten. `datagen publish` lays the tree out for the two repos (see [Publish](#publish)): train, val and noise with their worlds, the contract and the reports in the data repo, the test split, its worlds and the LLM cache apart in the held-out one.

```text
manifest.json                 the version: hashes, seeds, targets, per-split counts, files
data/{train,val,test,noise}.jsonl.zst, data/train-<n>.jsonl.zst  the splits and the nested train subsets
worlds/<id>.json              the worlds the sessions name (presence-only)
build/render.txt              the render and mix report
build/render-dropped.jsonl    each turn the renderer lost, and why
build/messages.json, .txt     the manifest and report of the messages run the version came from
build/models.json            the writers, readers, styles and per-slot recovery of that run
build/llm-cache.jsonl.zst     that run's LLM cache, packed
contract/tools.json, system.txt, hashes.json   the tool contract the data was rendered for (see [The contract](#contract))
```

`datagen unpack-cache --in <dir>/build/llm-cache.jsonl.zst --out <messages out>/llm-cache` restores the cache byte for byte, so `datagen messages --offline` (or `build --offline --out <dir>` after unpacking into `<dir>/stages/messages/llm-cache`) rebuilds the version with no model calls.

`<dir>/data/{train,val,test,noise}.jsonl.zst` are single zstd frames, one record a line. A record is the session of `assist_eval::gold::Session` (`id`, `world`, `today`, `me`, `tags`, `turns[{user, gold, ref, tags}]`, so `assist-eval` loads it unchanged: `DatagenSource::open_version(<dir>, &["train", ...])`), plus `meta` (`app`, `apps`, `cells`, `span`, for the per-app and per-cell slices) and

```json
"render": {"input_ids": [u32, ...], "weights": [f32, ...], "text": "<the rendered transcript>"}
```

`input_ids` and `weights` have one entry per token. **The trainer reads only `render.input_ids` and `render.weights`.** The typed `scenario` stays behind. `<dir>/worlds/` holds the worlds the sessions name, so a version loads in the eval on its own.

The turns' `ref` are the reference calls the think states. One thing differs from the messages run: a period the planner wrote relative to today (`{"unit":"week","rel":-8}`) is written as the days it covers (`{"from":{"date":"2026-08-17"},"to":{"date":"2026-08-23"}}`) when the member's own message says the days ("aug 17 to aug 23", so the `dates:` line holds them). The days are the same, so the gold is, and the call is one a model can write from what it reads instead of a count of weeks it would have to work out.

### Render

A session is run on a private copy of its world's vault the way the phone runs one (`WorldRun::open`: default flags, the eight tools of the regroup). For each turn the runtime reads the member's message (`Session::user`: the block of `vault:`, `focus:`, `dates:`, `nums:` lines, and the compaction of earlier observations), then for each reference call:

1. **The think** is derived from the call (`trace`, below) and **round-tripped**: `compile_think_with` (what `decode_step` runs on the phone, with the turn's `dates:` and `nums:` lines) must give back exactly the reference call. A step that does not is never a record; the turn is lost and counted.
2. **The call text** is what the compiler gave back, not something written here. A `create` or `edit` carries its fields as parameters of its own, as the regrouped tools do.
3. **The observation** is what the runtime answers when it runs that text (`Session::call_text`), so it is byte-exact what the phone shows the model. A call the plan expects the runtime to refuse must be refused, and every other call must not be.
4. The step goes into `centraid_assist::native_turn::log::Log`, the conversation the phone feeds its model (the system turn and catalog from `Session::prompt`, history with earlier calls, results, `@k` handles and compaction), and `Log::transcript` renders it with `transcript.rs`. Nothing here writes a byte of the prompt format.

**The tools block** of every rendered prompt, and the mode the compiler reads the think with, come from one place: the model record (`crates/assist/model.json`, read by `centraid_assist::record`, the way the phone reads it) through `plan::tools_mode()`. The manifest names it (`tools_block.mode`) and a test reads the record from disk and checks the rendered system turn lists exactly that block's tools. The record says `sig`, the eight tools. **A record that said `s2`** (the tools before the regroup: `search`, `open`, `act`, no `create`, `edit` or `do`, under which a `create` does not round-trip through the compiler, so the render loses those turns and counts them) makes the manifest mark the version **not publishable**: the reference calls use the regrouped tools, so the prompt would not list the calls it teaches. The record's `tools_mode` is set by `cargo xtask model-pin`, and a version built before it changed is rebuilt.

A session whose turn fails a step is kept as the shorter session before it (tag `truncated`); a failure at the first turn drops it. The report counts both, with the reason and the call.

**The think (v4, with the tools of CONTRACT_V3 section 9).** `trace::trace` writes the slots in the v4 order from the call: `retry: rejected` on the step after a refused call, `intent` (the turn's act, from the typed scenario, and the opening words of the message), `via: find|compute`, `verb`, `pick: #n (reason)` for one row (the reason is the runtime's own `pick_reason`, read from the block and the rows shown so far), `rows`/`value`/`options`/`linked_to`/`within`/`exclude` as handles, the arguments of the selector, `where` as typed segments (`status = open · priority >= 1`, with `nums[i]` where the message says the number and the `nums:` line has it), `when` as `"<phrase>" = dates[i]` when the `dates:` line reads the period and else as the compact date (`"aug 17 to aug 23" = from 2026-08-17 to 2026-08-23`, `earlier = ...` when the days are in what the model has already read, `now = ...` otherwise), and `set` for the fields of a create, an edit or a `do` (a field under the name chat writes it: `date`, not `due`). A value a slot cannot spell (a line break or `·` in a field) is refused, not guessed. `Failure::Unspellable` and `Failure::Roundtrip` are the two reasons.

**The mask**, as per-token float weights from the trained span of each assistant message (just after `<think>\n` through `<|im_end|>`, `Log::transcript`'s spans in bytes):

| weight | tokens |
| --- | --- |
| `0.0` | the system turn and catalog, every user turn and its block, every tool result, the assistant header, and every token of a call the runtime was expected to refuse (the first half of an error-then-repair turn: the model is taught the recovery, not the mistake) |
| `1.0` | every other token of an assistant message, intermediate steps included: the think, `</think>`, the call, `< | im_end | >` |
| `2.0` (`--decision-weight`, `render::DECISION_WEIGHT`) | the deciding tokens inside those: in the think the intent word, `via`, `verb`, `kind`, `op`, `field`, `group`, `trashed`, `where`, `when` (the date after `=`), `linked_to`, `within`, `exclude`, `order`, `limit`, `more`, `rows`, the row number of `pick`, `value`, `options`, `reason`, `time`, and the values of `set`; in the call the same parameters and the values of `args` lines and of the fields of a create or edit. Not the free text the member said (`name`, `text`), the phrases, the pick's reason, `retry`, labels, tool names and scaffolding |

A token is trained when it lies wholly inside a span and a decision token when it also overlaps a decision range (`render::decisions`; the precedent is the retired `train/fmt.py`'s decision spans, with the labels the issue lists instead of every label). Offsets are bytes (a character the byte-level tokenizer splits into several tokens gives each the character's range), and a special string of the format (`<|im_start|>`, `<think>`) is one token.

**The tokenizer** is `bpe.rs`, a byte-level BPE of our own that reads the model's `tokenizer.json` (`--tokenizer`; its BLAKE3 goes in the manifest): the added tokens are cut out first (leftmost, longest), the rest is NFC-normalised, split by the file's `Split` regex (`fancy-regex`, for the lookahead) and merged by rank over the GPT-2 byte map. A file of another shape (another normalizer or model, a dropout, a merge prefix) is refused. It replaced the Hugging Face `tokenizers` crate, which pulled in `paste` (RUSTSEC-2024-0436; `deny.toml` has no ignores); on Qwen3.5-0.8B's file the two gave identical ids on 3.5 million texts (the rendered records of a build, the repo's own files, and a fuzz of unicode, emoji, CJK, digit runs, whitespace, contractions, typos and every special token), and only the offsets of text that NFC rewrites differ (the crate's are truncated there; ours cover the characters that composed). `render::byte_level_tokenizer` is a byte-level one with no merges that the tests use, so no test needs the network or the model file (`DATAGEN_TOKENIZER=<path>` also runs the two tests that read the real file).

### Rollout records (M7)

`datagen rollout-records --in <data version> [--split train] --rollouts <PREFIX.rollouts.jsonl>… --tokenizer <tokenizer.json> --out <dir> [--needs REPORT.json] [--min-samples 5] [--max-copies 4] [--decision-weight 2]` cuts the RFT records of `assist-eval rollout`'s samples (`assist_eval::rollout::records::cut`) and renders each with `rollout::Renderer`, the `RenderRecord` `assist-eval` asks for (it cannot link this crate), so every record carries `render {input_ids, weights, text}` as a data-version record does. `<dir>` gets `rft.jsonl` and `stats.json`. **Only the train split can be cut:** a `--split` of `val`, `test` or `noise` is refused before the tokenizer is loaded (`records::refuse_held_out`, which `records::cut` also applies; every `DatagenSource` record carries the split file it was read from as `split`). The sessions and worlds are the data version's (`--in`, as `assist-eval` reads it through `DatagenSource::open_version`), the ones the rollouts were sampled over.

A rollout record's turn holds what the model said, so nothing is traced: the messages are replayed through the runtime on a private copy of the world's vault (the user's message and its block, each message, the runtime's answer), and `Log::transcript` renders the conversation the model saw. The mask is the data version's: 1 on every token of an assistant message, `--decision-weight` on the deciding tokens inside it, 0 on everything else, and 0 on a message the runtime refused (the model is shown the repair, not taught the mistake; the data version masks its expected refusals the same way). A turn with no message of the model's that the runtime did not end itself, or a record whose day is not its world's, is an error naming the record. Tested: the rollout record rebuilt from a data-version record's own messages renders to the same text, ids and weights as that record, all 90 records of a small version.

### Mix

`mix::mix` chooses the sessions of each split from the larger rendered input. Splits are by world seed (drawn before any session; asserted: no world is in two splits). Then, per split:

1. **Duplicates out**: a session's key is the BLAKE3 of its normalised user texts and its gold. Test is read first, then val, then train, so a repeat is dropped from train.
2. **Minimal pairs together**: the two sessions tagged `pair:<id>` are one unit, both or neither; a pair whose twin is gone is not kept alone.
3. **Targets**, by what the model decides, by a greedy over units (exact lazily, because a deficit only shrinks), each share water-filled so a label the input cannot fill gives its share away:
   - per turn, **outcome** done 65 / nothing found 8 / ask 10 / decline 7 / repair 10 (`--outcome-shares`); **action** read, count or measure 45 / create, edit or other write 45 / recall or undo 10 (`--action-shares`); **how a row is pointed at** name 40 / filters 25 / pronoun or earlier answer 20 / nickname or misspelling 15 (`--reference-shares`, over the turns that point at a row); **impossible requests** 5% (`--impossible`: the runtime's decline outcome for out of scope, unbounded destruction and a fabricated secret);
   - per session, **turns** 40 / 30 / 30 for one, two and three or more (`--turn-shares`), and sessions that **touch two kinds** 20% (`--two-kinds`);
   - **a floor on the live cells** of the grid (tool, kind, verb or op): every live cell has at least `--cell-floor` turns in train (default 30), rarest cell first, and the report says per cell `hit`, `supply` (the input holds no more) or `short`. There is no share per app: the app is a tag and a report line.
   - **a floor on the live (kind, field) pairs** of `create` and `edit` (`fields`): the pairs share the turns that set one equally and every live pair has at least `--field-floor` turns in train (default 30), rarest first, reported `hit`, `supply` or `short` like the cells; val and test have no floor, as the cells have none, and are reported against the uniform target.
   - **Two ceilings**, not targets: pronoun or earlier-answer references are at most their share (20%) of the turns that point at a row, and undo turns at most `mix::UNDO_CAP` (0.04) of the turns. A unit that would take a ceiling over waits and is taken later only if there is room, so the realised share never exceeds it, in every split and subset; the report lists the ceilings with the realised count, the base and the supply.
   - **A floor**, not a share: at least half the sessions have two turns or more, as many as the input holds.
   - **Reserved combinations** (H7): a set of combinations of kind and filter field (`kf:task:status`) and of kind, verb or op and constraint count (`kvn:task:complete:2`) that appear **only in test** (`--reserve` of them, default 8, chosen by a seeded hash from what the input holds; `--reserved-share` of the test sessions carry one, default 20%). Train and val never take a session with one, and the build asserts none is there (`mix::mix` errors, and the manifest lists them under `reserved_combinations`). Together with the split by world, by name pool and by writer, the test split shows what none of the others do.
4. **Noise** is the heavy-typo copy of val: the noise sessions whose val session was chosen.

Mixing downsamples, and says what it could not do: per split the report lists each live cell's target, realised count and supply, each share's labels with target, realised and supply, the sessions given up to the reserved combinations and the ask-or-act pairs kept, and "could not hit" lines for what fell short (each label has `requested`, the share asked for, `target`, that share once the input's supply caps it, `realised` and `supply`; a label under 80% of what was asked is listed in `missed` against `requested`, and a label the input does not hold is shown with supply 0, not faked). Defaults: `--targets 5000,500,1000`.

**Nested subsets**: `--subsets 1000,2500` picks, from the chosen train sessions, 2,500 and from those 1,000, balanced to the same shares, so a learning curve compares like with like. Each is a file of its own, `data/train-1000.jsonl.zst` and `data/train-2500.jsonl.zst`, holding the same records the train file holds for those sessions, in the train file's order; the manifest lists them under `subsets` with their hashes.

### The manifest

`manifest.json` is the data version: `version`, `publishable` (`value` and the `blockers`: rendered with the byte-level test tokenizer, built from a dirty tree, written or read by a rehearsal model, a model record whose tools block is `s2`), `tools_block`, `messages` (the writers, readers and styles of the messages run), `catalog_hash`, `runtime_commit` (`git rev-parse HEAD`, `-dirty` when the tree is), `seeds` (master, typos, mix), `tokenizer.blake3`, `llm_cache.blake3` (every cache file's name and bytes, in name order) and its entry count, the weights, the targets, the render counts (steps and how many round-tripped), per split the sessions, turns, tokens, pairs, the shares realised and what was missed, and each file's size and BLAKE3. A rebuild from the same input, seeds and tokenizer is byte-identical (tested).

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

`DatagenSource` (which also reads the output of `datagen messages`) implements `assist_eval::source::EvalSource`, so a run plugs straight into the eval. `DatagenSource::open(dir, split)` reads a written run; `DatagenSource::new` takes records and world documents in memory.

## Commands

```sh
cargo run -p centraid-datagen -- catalog [--out catalog.json]
cargo run -p centraid-datagen -- worlds --seed 1 --out out/ [--counts 48,8,12] [--vaults]
cargo run -p centraid-datagen -- ambiguity --seed 1 [--counts 48,8,12] [--json]
cargo run --release -p centraid-datagen -- intents --seed 1 --out out/ [--counts 48,8,12] [--sessions 7500,750,1500 | --per-world N[,N,N]] [--mistakes runs/r1.rollouts.jsonl]
cargo run --release -p centraid-datagen -- messages --in out/ --out msgs/ [--concurrency 6] [--batch 12] [--limit N] [--offline] [--seed 1] [--writer train=haiku,val=haiku,test=sonnet] [--reader train=sonnet,val=sonnet,test=haiku] [--style-shares .4,.15,.15,.15,.15]
cargo run --release -p centraid-datagen -- render --in msgs/ --out v1/ --tokenizer tokenizer.json [--version v1] [--targets 5000,500,1000] [--decision-weight 2] [--render-concurrency 6] [the mix's flags]
cargo run --release -p centraid-datagen -- build --version v1 --out v1/ --tokenizer tokenizer.json [--seed 1] [--counts 48,8,12] [--sessions 7500,750,1500] [--offline] [--reuse] [--mistakes FILE] [--writer ..] [--reader ..] [the mix's flags]
cargo run --release -p centraid-datagen -- publish --in v1/ [--repo srikanth235/centraid-assist-data] [--heldout-repo srikanth235/centraid-assist-heldout] [--upload] [--public]
cargo run --release -p centraid-datagen -- drift --in v1/   # has the tool contract moved under the version?
cargo run --release -p centraid-datagen -- restamp --in v1/ [--heldout-repo srikanth235/centraid-assist-heldout]   # a version built before the contract block
cargo run --release -p centraid-datagen -- rollout-records --in v1/ --rollouts runs/r1.rollouts.jsonl --tokenizer tokenizer.json --out runs/r1-records [--split train] [--needs runs/r1.rollout.json]
cargo run --release -p centraid-datagen -- unpack-cache --in v1/build/llm-cache.jsonl.zst --out msgs/llm-cache
cargo run --release -p centraid-datagen -- show --in v1/ --tokenizer tokenizer.json [--split train] [--session ID]
cargo run -p centraid-datagen -- test-tokenizer --out tokenizer.json   # the byte-level test tokenizer, for a rehearsal build
```

The mix's flags: `--targets 5000,500,1000`, `--turn-shares .4,.3,.3`, `--two-kinds .2`, `--outcome-shares .65,.08,.1,.07,.1`, `--action-shares .45,.45,.1`, `--reference-shares .4,.25,.2,.15`, `--impossible .05`, `--reserved-share .2`, `--cell-floor 30,0,0`, `--field-floor 30,0,0`, `--subsets 1000,2500`, `--reserve 8`, `--mix-seed`, `--decision-weight 2`.

`build` draws half as many sessions again as the targets by default (`--sessions` sets it), so the mix has something to choose from; `--reuse` skips a stage whose manifest exists under `<out>/stages/`. `worlds` writes `<out>/<split>/<id>.json` (and `.vault` with `--vaults`) and `manifest.json`. `intents` runs stages 2 and 3 over the worlds of the run and prints the coverage report (also `report.txt`): the grid's size and its not-live cells, solvable intents per live cell (kept / drawn, with drop reasons), the shares along each axis, and the multi-turn share. Each world visits every live cell once as the first turn of a session, then keeps drawing until it has `--per-world` sessions (default: one per live cell); `--sessions train,val,test` derives it from the targets. Use `--release` for a long run: the sessions of 68 worlds, the very large vaults among them, take a long time. `DATAGEN_DEBUG=1` prints every drop with the intents that led to it. The package is `centraid-datagen`; the binary is `datagen`.

## Publish

<a id="publish"></a>`datagen publish --in <version dir>` puts a built version on two Hugging Face dataset repos as one commit and one tag each, the tag named by the version (`v0.3`): the **data repo** `srikanth235/centraid-assist-data` (`--repo`; what the trainer fetches) and the **held-out repo** `srikanth235/centraid-assist-heldout` (`--heldout-repo`; the test split, its worlds and the LLM cache, for evaluation only). Both are private. **It is a dry run unless told otherwise**: it checks the version, lists every file of both repos with its size and BLAKE3 and uploads nothing. A real upload needs `--upload`, `--repo`, `--heldout-repo` and `HF_TOKEN` in the environment. The token is read from the environment only, passed to the child processes that do the transfer through their environment, and never printed, written, put on a command line or kept in a message; a failure's text has it cut out.

It **refuses** (all reasons listed together): a file that does not match its hash in the manifest or is missing; a build from a dirty tree or an unknown commit (`runtime_commit` ends in `-dirty`); a version the manifest does not mark `publishable` (the byte-level test tokenizer, a dirty tree, a rehearsal model: the manifest says which); **any file holding a sealed placeholder** (`placeholder:` or a datagen placeholder; `.zst` files are read decompressed); **a manifest with no `contract` block or no `heldout` pointer, or `contract/` files that do not hash to the block** (see [The contract](#contract)); a `--heldout-repo` other than the manifest's pointer; and a version with no packed LLM cache. The checks run before a token is looked at.

Layout (the data repo is what the trainer fetches: `manifest.json`, `data/train.jsonl.zst`, `data/val.jsonl.zst`, and a nested subset by its name; the held-out repo is separate so a fetch of the data repo cannot pull test):

```text
data repo  (--repo)                               held-out repo  (--heldout-repo)
manifest.json   README.md (the card)              manifest.json (the same bytes)   README.md (evaluation only)
contract/tools.json  system.txt  hashes.json      test/test.jsonl.zst
data/train.jsonl.zst  val.jsonl.zst  noise.jsonl.zst   worlds/test/<test worlds>.json
data/subsets/train-1000.jsonl.zst ...             cache/llm-cache.jsonl.zst   (the packed writer and reader cache)
worlds/train/*.json  worlds/val/*.json
reports/<the build's text and JSON reports>
```

Nothing of test or the cache is in the data repo's set (a test asserts it). The manifest is uploaded byte for byte to both, so it still lists the test file as `data/test.jsonl.zst` and the subsets as `data/train-<n>.jsonl.zst`; the repos hold them at the paths above. The cache names test sessions, which is why it lives with test, and it is uploaded so a rebuild can run offline (`datagen unpack-cache`). The card covers what the data is (synthetic, English, for a LoRA adapter, with the dataset-card `configs` front matter mapping `train` and `validation` to the data files), how it was made, the catalog hash, the runtime commit, the tokenizer, the contract hashes, where test lives, the writers and readers, the realised share of every split against its target with what was not hit, the limits, and that sealed values are absent. Build reports under `build/` are the text and JSON ones, published as `reports/`; the other `.jsonl` files (which name test sessions) and the render spool are not uploaded.

**A version's tree is exactly its publish set, in each repo** (the paths the dry run lists). `main` always equals the latest version's tree. The commit puts every file of the set and deletes every path of `main`'s tree that is not in it (`publish::plan`, a pure function of the publish set and the remote listing). The one path kept is `.gitattributes`, the repo's LFS rules; nothing else is plumbing. The dry run prints the paths each commit would remove when it is given `--repo` and `HF_TOKEN` (a read-only listing of both repos; without them it says it cannot list them) and marks a tag that already exists.

**One tag per version, never overwritten.** The upload reads both repos first and refuses, before sending anything, when the tag exists in either. It then makes one commit on `main` of the held-out repo and tags it, then the same in the data repo, so a data tag never exists without its held-out one. There is no staging branch: `create_commit` on `main` is atomic, so a branch adds nothing; if the tag step fails after the commit, `main` holds the tree without a tag, which no reader pins, and a rerun plans from it (if only the held-out tag was made, the rerun is refused by it and the data repo is finished by hand). **Why Rust, and Python only for the transfer:** the checking, the layout, the cards, the plan and the dry run are what must be exact and what can be tested offline, so they are Rust and reuse the manifest; the listing and the commit to the Hub (LFS, tags) are `huggingface_hub`'s own protocol and are not re-implemented, so `publish::list_remote` and `publish::upload` run short scripts through `python3` (`--python` names another). It needs `pip install huggingface_hub`. The scripts are the one thing a test cannot run offline: tests hand a stand-in transport the listings and the staged trees and check the arguments, the deletes and the environment, and the first real upload is the owner's.

### The contract

<a id="contract"></a>A version's records show the model the runtime's tools block, so the version is for the tool contract it was rendered with. The manifest carries `contract` (`tools_mode`, `tools_hash`, `prompt_hash`, `catalog_hash`, `tokenizer_blake3`, written at build time) and `heldout` (`repo`); the version holds the texts the hashes are of: `contract/tools.json` (the tool catalogue exactly as `assist::record::runtime_hashes` hashes it; `tools_hash` is its BLAKE3), `contract/system.txt` (the static prompt it hashes: the identity, the static system turn with its tools block and kind card, the escape rules; `prompt_hash` is its BLAKE3) and `contract/hashes.json` (the block). Publish checks that the files hash to the block.

`datagen restamp --in <version dir> [--heldout-repo owner/name]` gives a version built before the block existed (v0.3) its `contract` block and `heldout` pointer and writes `contract/`. It changes no data file (only `manifest.json` is rewritten) and **does not read the test split**. It **proves the contract against the data first** instead of trusting the checkout: for the manifest's tools mode it builds the tools block this runtime serves and requires it, byte for byte, in the `render.text` of every record of train and val; it refuses with the counts (`val: 1 of 2 records hold the tools block of mode sig`) and changes nothing if any record lacks it. What that proves: the tool catalogue behind `tools_hash` (the block is that catalogue's tools, each written as the catalogue hash writes them, with the call format) is the one the data was rendered with. What it does not prove: the rest of `prompt_hash` (identity, escape rules, the kind card in `USD`) is not in the records in a form that can be compared (a record's card is its world's currency), so those parts are the checkout's. A version already stamped with a different contract is refused.

### Drift

<a id="drift"></a>`datagen drift --in <version dir>` (a built version, or one fetched from the data repo, whose worlds are in `worlds/<split>/`) says whether the tool contract moved under a version and by how much. It reads the manifest's contract block (`datagen restamp` gives an older version one), opens **train and val only** and replays their reference calls through this checkout's runtime in the contract's tools mode (`assist_eval::replay`, the path the version's own tests take; the render stage's think round trip needs the build's typed intents, which a published version does not carry, so it is not re-run). It prints counts, never time:

- **contract**: `tools_hash`, `prompt_hash`, `catalog_hash` each `same` or `DIFFERENT` with both values.
- **shape**: reference calls that no longer fit the current tools, counted by tool and what: the tool is gone, an argument no call of the tool may carry, a value outside a closed list (`op`, `verb`, `reason`), or the runtime itself refused the turn on replay. A reference call is recorded in the form the runtime executes (`create` and `edit` as `args` lines, `do` with `args` and a selector), not the form the model is shown, and the sig mode's tools block has signatures but no parameter schema, so the tool names are the version's mode's (`tools_for`), the parameters are the compact schemas they are generated from widened by the executed form, and the runtime's own refusal on replay covers the rest. Mode `s2` (a frozen constant with tools of its own) is refused.
- **behaviour**: turns whose calls validate but, said through the runtime, no longer give the recorded gold, counted by tool; sessions whose world no longer seeds. A turn with a shape problem is counted under shape only.
- **coverage**: tools, arguments (`tool.argument`) and kinds of the current catalogue with fewer examples in train than the floor (the manifest's `targets.cell_floor.train`, at least one). An argument is shown by a call that carries it flat or, for `create`, `edit` and `do`, inside its `args` lines (read with the runtime's own `act_args`), so a field of `create` counts when it is written there. A kind is shown by a `kind` argument that names it.
- **notes**, before the level: when the runtime ships a tools mode other than the version's (`crates/assist/model.json`) a line says so as a contract difference, not a shape failure; and when every hash is the same yet shape findings exist, a `SELF-CHECK` line says that points at a fault in the check or the data, not a tool change.
- **level**: the most work any of these calls for. `wording` (only the hashes differ): re-render from the cache (`datagen unpack-cache`, `datagen render`), no model call. `shape` or `behaviour`: regenerate those sessions. `coverage`: write new intents. `none`: nothing to do. It ends with the `stale` entry to put in `crates/assist/data.json` to accept the change for now.

`cargo xtask rules` has the offline half: the `data-pin` rule fails when the runtime's hashes for `crates/assist/data.json`'s tools mode differ from the pin, unless the pin carries `stale` (a one-line `since` and a `level`), which passes and prints a notice.

## Runbook

The owner's commands, from a clean checkout of this branch (a dirty tree is refused at publish). A real build writes with a language model and costs money; nothing below was run with one.

1. **Rehearse offline first** (no model, no cost; shows the report and every refusal):

   ```sh
   cargo run -p centraid-datagen -- test-tokenizer --out /tmp/tok.json
   cargo run --release -p centraid-datagen -- build --version rehearsal --out /tmp/rehearsal --tokenizer /tmp/tok.json \
     --counts 8,2,2 --sessions 1600,200,200 --targets 1200,150,150 --cell-floor 3,0,0 --subsets 300,600 \
     --writer train=rehearsal,val=rehearsal,test=rehearsal-b --reader rehearsal-r
   cargo run --release -p centraid-datagen -- publish --in /tmp/rehearsal     # refused: byte-level tokenizer, rehearsal models
   ```

2. **Build the real version.** `tokenizer.json` is the Qwen3.5-0.8B file. The writers and readers are `claude --model` names; the default writes train and val with `haiku` and test with `sonnet`, and reads back with `sonnet` (train, val) and `haiku` (test), so no reader is its split's writer. Every model output is cached under `<out>/stages/messages/llm-cache`, so an interrupted run resumes with `--reuse` and a rebuild with `--offline` makes no call:

   ```sh
   cargo run --release -p centraid-datagen -- build --version v0.3 --out data/v0.3 --tokenizer tokenizer.json
   ```

   Add `--mistakes runs/r1.rollouts.jsonl` to show the model's own refused reads in the repair turns, `--writer`/`--reader` to change models per split, and the mix's flags to change a share.

3. **Check the report.** `data/v0.3/build/render.txt` and `data/v0.3/manifest.json` (`splits[].shares`, `.cells`, `.missed`) give every share against its target, every live cell as `hit`, `supply` or `short`, and what could not be hit and why; `build/messages.txt` gives the recovery rate per slot, the realised styles and the drops by reason; `manifest.json` `publishable` says whether the version may leave (`value: true`). Look at `missed` before anything else: a share the input could not fill is reported there, not faked.

4. **Stamp a version built before the contract block existed** (v0.3; a version built now carries it). It proves the tools block against train and val, changes no data file and does not read test:

   ```sh
   cargo run --release -p centraid-datagen -- restamp --in data/v0.3
   ```

   It prints one `proved: N of N <split> records hold the `<mode>` tools block` line for train and for val, then `stamped <manifest>: tools_hash …, prompt_hash …, catalog_hash …, tokenizer …; held-out repo …`. On a failed proof it prints the counts and changes nothing.

5. **Dry-run the publish** (nothing is sent; it lists both repos' files with size and hash and fails with every reason when the version is not fit). With `HF_TOKEN` set it also reads both repos (read-only) and lists the paths each commit would remove:

   ```sh
   cargo run --release -p centraid-datagen -- publish --in data/v0.3 --repo srikanth235/centraid-assist-data --heldout-repo srikanth235/centraid-assist-heldout
   ```

6. **Publish.** Needs `pip install huggingface_hub` and a write token in `HF_TOKEN` (never in a file or on a command line):

   ```sh
   HF_TOKEN=... cargo run --release -p centraid-datagen -- publish --in data/v0.3 --repo srikanth235/centraid-assist-data --heldout-repo srikanth235/centraid-assist-heldout --upload
   ```

   It prints `published <repo>@v0.3` for the held-out repo and then the data repo. The trainer takes `hf://datasets/srikanth235/centraid-assist-data@v0.3` as `data.hf` (its subsets as `train-1000` and `train-2500`, read from `data/subsets/`).

## Findings and limits

What the generator does not teach, and what it could not do, so no one assumes it does:

- **`lakh` and `crore`** are not taught: the runtime does not resolve them, so the writer is told never to use them, a message that does is dropped (`hygiene`), and the card says so.
- **Requests with no runtime behaviour** are not in the data, so they are not impossible-request turns: a `create` of a photo, a transaction, a budget or a rule; an `edit` of a budget, a category or a rule; `tag`, `untag`, `archive` and `unarchive`; `reveal` (see the grid's not-live table). The impossible 5% is the runtime's decline outcome for out of scope, unbounded destruction and a fabricated secret. A verb the kind lacks, and an edit of a kind that cannot be edited, are decline turns for the same reason.
- **A very large vault** passes the runtime's window of the 500 newest rows, so a read of a kind the window cuts is refused by the runtime or shows fewer rows than the world holds. The planner compares the runtime with the world's second reading (`facts`), so a turn where they disagree is dropped as `overmatch`/`undermatch`/`value` and reported, not recorded. The runtime's "narrow it with a date" refusal is not drawn as a deliberate repair; a large world mostly contributes the turns its window leaves answerable.
- **The shares are targets, not promises**: the mix chooses from what the sampler and the planner solved, so a label with little supply (repairs on a rare kind, recall in a small vault) is reported short, with its supply, in `missed`.
- **The writer is a model**, so a style or a rule it ignores is caught by the checks (span, hygiene, the reference, the read-back) or counted in the realised-style report; the data is never better than those checks.

The H9 investigation (report only; nothing was built):

- **A reduced or reordered catalogue, a kind held out:** not honest today, and a small, real runtime change makes it so. The catalogue text the model sees is a pure function of compile-time constants (`native::prompt::prompt`, `kind_card_for` over the generated `Kind::ALL`; `crates/assist/src/native/prompt.rs`), not of the vault, and the runtime would still accept a removed kind (`Kind::parse` and every use of `Kind::ALL` in compose, session, search, parse and grammar), so a kind hidden from the text would still be found, created and shown in the `vault:` block. Honesty needs a kind mask in `Flags` (`session.rs`) that the card, the grammar, the parse and the `vault:` line all obey, so an unknown kind gives the same error and hint as a kind that does not exist; datagen then passes it through `WorldRun::seed` and `open` (`plan.rs`) and excludes the held-out kind's scenarios.
- **Qwen's native tool-call format as well as the current one:** render-only for training if the think is kept. The call is already Qwen3.5 XML (`<tool_call><function=…><parameter=…>`, `transcript::call_text`, `native/identity.rs`) with `<tool_response>` in a user turn; what is compact is the think (`trace.rs`, weighted in `render.rs`). A JSON variant needs a second `call_text`/`assistant_body`, a second system block and `tools_block` (`prompt.rs`), `Log::transcript` and `Log::prompt` calling it, `assistant_record` learning it, and the decision ranges in `render.rs` re-aimed at the JSON call. The phone is unaffected while the model only writes the think (`decode_step`, then `compile_think_with` and `call_text_of` write the call); a model that writes the call itself needs `parse.rs` to read JSON and `grammar_for_step` to change, which is a real runtime change.

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

`cargo test -p centraid-datagen`. The intents tests run three worlds with more rows in the trash than a preset puts there (a `restore` needs one) and hold: a run is a pure function of its seed; every live cell has a solvable intent; the shares (multi-turn, three or more turns, across-app, three or more constraints among the turns that select by constraints); each follow-up leans on an earlier turn; each minimal pair differs in its answer; every name a create or rename gives is from its kind's pool, has no trailing number and clashes with no row of the kind; **replaying every session's reference calls through `assist_eval::run::Runner` passes every turn**, so gold is the runtime's effect reproduced and the eval loads what datagen writes; and a written run opens as an `EvalSource` with its worlds. `-- --ignored` also seeds all 68 worlds.

`tests/messages.rs` runs stages 4 and 5 over a small intents run with the library's **rehearsal models** (no network: a writer per split and a reader): a rebuild from a warm cache makes zero calls and every output file is byte-identical, `--offline` on a cold cache fails, no sealed placeholder or datagen placeholder reaches a prompt (checked against every placeholder the worlds seed), the output opens as an `EvalSource` with real messages and a verdict on each turn, and `World::from_doc` reads a world back from its document. The refusals are tested too (a reader that is its split's writer, a test split written by train's writer) and the style words (no prompt train's writer was given holds the test split's wording). `src/proofs.rs` holds the fast proofs of the coverage work: every live (kind, field) pair is drawn, each intent family (typed Locker secrets, measurements, the options of `find`) is built, solved through the runtime and shown to carry its argument, the runtime's refusal of a money field is replayed, a typed secret is a span of its brief while a placeholder is still refused, the rare outcomes' supply is counted against their targets, and a run with no room for a capped share draws none of it. Unit tests cover the checks (span, pronoun repeating a name, hygiene), the parsing of an answer, the cache and the typo pass (spans, numbers and date words survive even heavy noise).

`tests/mistakes.rs` runs every repair family against a real vault on every kind it applies to and demands the runtime refuses it, for the reason the family names. `tests/publish.rs` builds a small version by hand and proves the layout (train and val apart from test), the card, the dry run, every refusal (a changed or missing file, a dirty tree, a version not publishable, a placeholder in a data file or a world) and the transport (a stand-in is handed the staged tree and the token only in its environment, and a failure's text never holds it). `tests/worlds.rs` also holds the world counts (48, 8, 12), the year of dates, the empty and very large vaults in every split, and the Indian names and rupees. The mix's unit tests hold the targets, the cell floor, the shares met, supply reported rather than faked, the multi-turn floor, nested subsets, the reserved combinations only in test and the pairs together. `tests/rollout.rs` rebuilds each record of a small data version as a rollout record (the messages read back out of its text) and proves it renders to the same text, ids and weights, and runs a scripted model (`assist-eval`'s `fake::Scripted`) over a session through the eval's runner into `records::cut` with the renderer. `tests/render.rs` renders and mixes a small intents run with the byte-level tokenizer and proves: every step's think compiled back to its reference call (the count is in the manifest), the ids decode to the text, the mask is exactly the assistant messages by an independent reading of the text (every `<|im_start|>assistant\n<think>\n` opens one region that runs to its `<|im_end|>`; a region is all trained, or all zero when it is a call the runtime was expected to refuse, and those are counted against the `bad` calls), the records carry the contract and load in `assist-eval` unchanged, **replaying their reference calls through `assist_eval::run::Runner` passes every turn** (so the rewritten periods keep their gold), no world is in two splits, noise follows val, the manifest names the version, and a rebuild is byte-identical. Unit tests cover the think (typed filters, `dates[i]`, the compact date, `nums[i]`, picks and their reasons, fields under chat's names, a value a slot cannot spell), the decision spans, the weights, byte offsets, and the mix (targets hit, pairs whole, duplicates out, the multi-turn floor, supply-limited reports, a world in two splits refused, water-filling).
