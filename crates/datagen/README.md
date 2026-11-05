# centraid-datagen

The chat model's training-data pipeline, in Rust ([#1166](https://github.com/srikanth235/centraid/issues/1166)). It drives the `centraid-assist` runtime as a library. Python stays only for the GPU trainer.

## State

Milestones M1 to M4 are built: stages 0 to 7 (the intents, the messages, the render and the mix), plus the ambiguity measure. `datagen build --version vN` makes a data version end to end.

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
| `brief`, `messages` | 4 | A typed turn put into English for the writer; the Haiku writer (batched JSON in, JSON out), the mechanical checks and the pipeline of stages 4 and 5. |
| `llm` | 4 + 5 | The `Llm` trait, Claude Haiku through headless Claude Code (`ClaudeCli`), and the prompt-hash cache. |
| `typos` | 4 | The seeded typo pass: light by default, heavy for the noise split. |
| `verify` | 5 | Runtime grounding (the session solved afresh against the real messages) and the read-back pass. |
| `source` | out | `DatagenSource`: the sessions as an `assist-eval` `EvalSource`, from a run (`open`) or from a data version (`open_version`). |
| `trace` | 6 | The v4 think of a reference call, and the round trip through the runtime's compiler. |
| `render` | 6 | A session rendered as the phone renders it, the model's tokenizer (`bpe.rs`), the loss weights of every token. |
| `mix` | 7 | Duplicates out, minimal pairs together, the grid's shares, the multi-turn floor, the per-cell report. |
| `bpe` | 6 | The model's byte-level BPE, read from its `tokenizer.json`. |
| `rollout` | 11 | M7's rollout records rendered by the M4 renderer (`datagen rollout-records`). |
| `version` | 6 + 7 | Render all, mix, write a data version (`manifest.json`, `data/`, `worlds/`, `build/`); pack and unpack its LLM cache. |

New stages add modules beside these and read `Catalog`; none reads a schema from anywhere else.

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

An `Intent` is the meaning of one turn in the vocabulary of the vault, not text: `Read`, `Count`, `Measure` (sum, avg, min or max of a number field, optionally grouped by a field or a period), `Compare` (two measures set side by side), `Write` (a `do` verb on a row), `Edit`, `Create`, `Recall` (an earlier result shown again), `Ask` (a name more than one row answers to) and `Decline`. **Names a request gives** (`create`, and `edit` of a name) come from a pool per kind in `pools.rs` (`NEW_TASKS`, `NEW_EVENTS`, `NEW_LISTS`, `NEW_NOTES`, `NEW_NOTEBOOKS`, `NEW_LOCKER`, `NEW_ALBUMS`, `NEW_FOLDERS`, `NEW_DOCUMENTS`, `NEW_ACCOUNTS`, `NEW_CATEGORIES`, `NEW_PHOTOS`, `NEW_TRANSACTIONS`), so a person is never "Plan the weekend" and a notebook is never a chore. A new person is `first last` from `NEW_FIRST_*` and `NEW_LAST_*`, which share nothing with the names worlds give their people (`FIRST`, `LAST`, `ME_*`) and are split like the owner's: a val or test person is a name no train create uses. A locker item or account is made with the type its pool entry names. A name never carries a number. The sampler picks one that no row of the kind, live or trashed, already has (for a person, no row with the same first name or nickname either) and that differs from the current name on a rename and from the row the session just made; a pool spent in a world falls back on "Recipes 2", which `report.txt` counts (`names numbered because a kind's name pool was spent`, 0 in normal runs). Pool names hold letters and spaces only and none of the words the runtime reads as a date, a period, a turn's verb or a retraction, so the M3 span check and the typo pass keep them verbatim; `pools.rs` tests hold every pool to that.

A `Scenario` is a session's turns; each turn records how it points at rows (`Reference`), how it ends (`Outcome`), and which earlier turn it leans on and how (`Dep`: pronoun, handle, narrow, carry, undo).

The sampler is a pure function of the seed and the world, and is target-first: it picks a row the world holds, reads constraints off it (its status, a threshold it clears, the period it falls in, the container it sits in) and only then writes the selector, so a selector always selects at least its target. Money and Health get real depth: sums, grouping by category, account, month or week, budget against spent, trends in daily figures (average by week), comparing workouts (two kinds of workout over one month, or one week against the last), and date ranges. Across-app means one turn that joins two apps (a selector linked to a row of another app, a period read off an event) or a turn that leans on a turn of another app; two unrelated questions in two apps are not across. Cross-app intents take the days around an event as their period (the workouts, spend or photos "around the dentist"), link rows across apps (tasks linked to a person), or hop a follow-up to another app over the days the rows of the turn before fall in. A follow-up always leans on an earlier turn: by pronoun ("complete it"), by handle (an earlier result, not the turn before's), by narrowing the rows just shown, by carrying the question to another period or another app, or by undoing the write.

## Planner and execute (stage 3)

The planner writes the reference calls in the decided shapes: a read is `find` then `answer rows=@k`, a count is `compute` then `answer value=@k`, a by-name write is `find` then `do`/`edit rows=@k`, a comparison is two `compute`s then `compute op=compare rows=@a,@b` then `answer value=@k`. `answer` takes no selector or `op`. Calls use names, `@k` handles read back from each response, compact date expressions (`{"unit":"month","rel":-1}`, or an explicit span) and a lookup of any container, person or event they link to. They never use a prompt's `#n`, a `dates[i]` or a `$key`: the user's text is not written yet, and M3 writes it from the scenario.

An `Edit` of a `workout` or a `daily figure` has the outcome `decline`: every seeded world follows a health store, which states those rows, so the runtime refuses the edit with the vault's sentence naming the store ("This workout comes from Health; change it there, not here.") and ends the turn on it. The reference is the one `edit` call; gold is a decline, and a turn that ends any other way (a world with a row the member logged) is dropped.

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

## Messages and verify (stages 4 and 5)

`datagen messages --in <intents out> --out <dir>` turns each typed turn into what a person types on a phone, then checks the text still means the intent. One command, five steps, each a pure function of its input, the seed and the cache:

1. **Write** (Claude Haiku, `claude -p --model haiku`, no API key). Sessions are batched (`--batch`, default 12) and sent as JSON; the answer is JSON. The prompt for a turn is its **brief** (`brief.rs`): what it asks in the vault's words (the rows, the filters with their units, the period resolved from `today`, the new values), the strings it must say verbatim (`say_verbatim`: the names, titles and notes the reference calls copy), and how it points at rows (the reference axis: say the name as quoted, say the nickname, copy the misspelling, use a pronoun and do not name the row again, point back at an earlier answer; and, for a follow-up, which turn it leans on and that it must be short). It never sees a tool call, a handle (`@k`, `#n`) or a world value that is sealed: a world is presence-only, `messages::no_sealed` refuses any prompt holding a sealed placeholder, and a test asserts that none reaches one. A session the answer does not cover is asked again in a later batch (a different prompt, so a different cache entry), up to three times, then dropped with reason `writer`.
2. **Check** (mechanical). No placeholder, ISO date, line break or text over 240 characters (`hygiene`); every `say_verbatim` string is in the message, compared without case (`span`); a pronoun or handle turn does not repeat a name an earlier turn said (`reference`).
3. **Typos** (`typos.rs`, `rng.rs`, seeded by session and turn). Light by default: about a third of messages carry one slip (a dropped, doubled, swapped or neighbouring-key letter, first letter kept). It never touches a span, a word with a digit, or a date word (`last`, `week`, `march`, `yesterday`). The **noise split** is a heavy-typo copy of every val session (`noise/`, ids end in `~noise`), grounded like the rest and not read back.
4. **Ground** (`verify::ground`). The session is solved again by the planner with the real message in place of the placeholder (`WorldRun::solve_with`). The runtime reads the message (names it finds, dates it reads, a retraction ends the turn), so this is what "the runtime finds the same rows and dates" means: gold must be unchanged, the reference calls are written afresh (what `#n` a row gets depends on what the message made the runtime show), the message must not read as a retraction (`grounding:retraction`), every row the turn points at by name must be listed in the runtime's `vault:` line (`grounding:name`; a trashed row is not looked for), and when the intent has a period the `dates:` line must read its first day (`grounding:dates`). Any change of gold or any other planner drop is `grounding:<drop>`.
5. **Read back** (Haiku, again batched). A second pass sees only the messages, with no brief, and says per message: the act (read, count, sum, avg, min, max, compare, create, edit, recall, undo, decline, or one of the `do` verbs), the kind, the period as `from`/`to` dates, the numbers in base units, which earlier message it leans on, and a decline reason. These slots are compared with the typed intent (`verify::agree`): `act`, `kind` (not asked when a row is named or the turn refers back), `period` (exact days), `number` (every number the intent carries, by absolute value), `leans` (only for a pronoun or handle turn, which cannot be understood alone; a carried or narrowed select restates what it needs) and `decline`. The share of read turns that agree is the **recovery rate**.

A turn that fails a step is dropped with a reason, and the turns after it are cut (they lean on it); the turns before it stay as a shorter session tagged `truncated`. The report counts a cut turn separately and never as a drop of its own cell.

**Cache.** `<out>/llm-cache/<hh>/<hash>.json` holds each model output under the BLAKE3 hash of the model name and the exact prompt (one file per prompt, written whole then renamed). A rebuild with a warm cache makes zero calls and writes byte-identical files (tested with a fake model, and by hand with `--offline` on the real run); `--offline` makes a miss an error instead of a call. Copy the cache with the data version. `--model` changes the model name and so the keys.

**Output** (`<out>/`): `train|val|test|noise/sessions.jsonl` in the shape above with `user` filled and `reference calls` rewritten against the real message, plus `"verify": {"keep": true, "passed": [...], "reason": "ok"}` on each turn and `scenario` cut to the kept turns; `dropped.jsonl` (one row per session that lost a turn: split, session, turn, grid cell, reference, reason, detail, the message, how many turns were cut); `worlds/` (copied, so `DatagenSource::open(<out>)` and `open_named(<out>, &["noise"])` read the result unchanged); `manifest.json` and `report.txt` (drop rate per grid cell, per reference axis and per split with the reasons, the recovery rate and its disagreements by slot, the noise split, examples). Files hold no call counts; the command prints them to stderr.

## Render and mix (stages 6 and 7)

`datagen render --in <messages out> --out <dir> --tokenizer <tokenizer.json>` renders every session of a messages run and mixes the result into a data version. `datagen build --version vN --out <dir> --tokenizer <tokenizer.json>` runs intents, messages (from the cache; `--offline` makes no call), render and mix, the stages under `<dir>/stages/` (working files, not published) and the version in `<dir>/`. `datagen show --in <dir> --tokenizer <tokenizer.json> [--split train] [--session ID]` prints one record decoded with its mask drawn on it.

### The record contract (what M6 reads)

A data version is this tree, and the dataset repository (`srikanth235/centraid-native-data`, private) holds exactly it at the root of one tag per version (`v0.2`, ...). `main` carries the latest; readers pin a tag. Publishing is a copy of `<dir>/` without `stages/`, then the tag.

```text
manifest.json                 the version: hashes, seeds, targets, per-split counts, files
data/{train,val,test,noise}.jsonl.zst
worlds/<id>.json              the worlds the sessions name (presence-only)
build/render.txt              the render and mix report
build/render-dropped.jsonl    each turn the renderer lost, and why
build/messages.json, .txt     the manifest and report of the messages run the version came from
build/llm-cache.jsonl.zst     that run's LLM cache, packed
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

`datagen rollout-records --in <data version> [--split train] --rollouts <PREFIX.rollouts.jsonl>… --tokenizer <tokenizer.json> --out <dir> [--needs REPORT.json] [--min-samples 5] [--max-copies 4] [--pairs-per-turn 2] [--decision-weight 2]` cuts the RFT records and DPO pairs of `assist-eval rollout`'s samples (`assist_eval::rollout::records::cut`) and renders each with `rollout::Renderer`, the `RenderRecord` `assist-eval` asks for (it cannot link this crate), so every record and both sides of every pair carry `render {input_ids, weights, text}` as a data-version record does. `<dir>` gets `rft.jsonl`, `dpo.jsonl` and `stats.json`. The sessions and worlds are the data version's (`--in`, as `assist-eval` reads it through `DatagenSource::open_version`), the ones the rollouts were sampled over.

A rollout record's turn holds what the model said, so nothing is traced: the messages are replayed through the runtime on a private copy of the world's vault (the user's message and its block, each message, the runtime's answer), and `Log::transcript` renders the conversation the model saw. The mask is the data version's: 1 on every token of an assistant message, `--decision-weight` on the deciding tokens inside it, 0 on everything else, and 0 on a message the runtime refused (the model is shown the repair, not taught the mistake; the data version masks its expected refusals the same way). A turn with no message of the model's that the runtime did not end itself, or a record whose day is not its world's, is an error naming the record. Tested: the rollout record rebuilt from a data-version record's own messages renders to the same text, ids and weights as that record, all 90 records of a small version.

### Mix

`mix::mix` chooses the sessions of each split from the larger rendered input. Splits are by world seed (drawn before any session; asserted: no world is in two splits). Then, per split:

1. **Duplicates out**: a session's key is the BLAKE3 of its normalised user texts and its gold. Test is read first, then val, then train, so a repeat is dropped from train.
2. **Minimal pairs together**: the two sessions tagged `pair:<id>` are one unit, both or neither; a pair whose twin is gone is not kept alone.
3. **Targets**, by a greedy over units, exact lazily because a deficit only shrinks: the grid's live cells share the split's turns equally (water-filled: a cell the input cannot fill gives its share away); each app, by the first app a session names, an equal share of the sessions (~2,250 of 18k over eight apps); one, two and three or more turns 40 / 30 / 30 (`--turn-shares`); across-app sessions 30% (`--across`). **A floor**, not a share: at least half the sessions have two turns or more, as many as the input holds.
4. **Noise** is the heavy-typo copy of val: the noise sessions whose val session was chosen.

Mixing downsamples, and says what it could not do: per split the report lists each live cell's target, realised count and supply (`hit`, `supply` when the input holds no more, `short` when the mix left it under), each app and each share the same way, and "could not hit" lines for what fell short. Defaults: `--targets 18000,1000,1000`.

### The manifest

`manifest.json` is the data version: `catalog_hash`, `runtime_commit` (`git rev-parse HEAD`, `-dirty` when the tree is), `seeds` (master, typos, mix), `tokenizer.blake3`, `llm_cache.blake3` (every cache file's name and bytes, in name order) and its entry count, the weights, the targets, the render counts (steps and how many round-tripped), per split the sessions, turns, tokens, pairs, the shares realised and what was missed, and each file's size and BLAKE3. A rebuild from the same input, seeds and tokenizer is byte-identical (tested).

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
cargo run -p centraid-datagen -- worlds --seed 1 --out out/ [--counts 48,6,6] [--vaults]
cargo run -p centraid-datagen -- ambiguity --seed 1 [--counts 48,6,6] [--json]
cargo run --release -p centraid-datagen -- intents --seed 1 --out out/ [--counts 48,6,6] [--sessions 18000,1000,1000 | --per-world N[,N,N]]
cargo run --release -p centraid-datagen -- messages --in out/ --out msgs/ [--concurrency 6] [--batch 12] [--limit N] [--offline] [--seed 1] [--model haiku]
cargo run --release -p centraid-datagen -- render --in msgs/ --out v1/ --tokenizer tokenizer.json [--version v1] [--targets 18000,1000,1000] [--decision-weight 2] [--turn-shares .4,.3,.3] [--across .3] [--render-concurrency 6]
cargo run --release -p centraid-datagen -- build --version v1 --out v1/ --tokenizer tokenizer.json [--seed 1] [--counts 48,6,6] [--sessions 27000,1500,1500] [--offline] [--reuse] [render's flags]
cargo run --release -p centraid-datagen -- rollout-records --in v1/ --rollouts runs/r1.rollouts.jsonl --tokenizer tokenizer.json --out runs/r1-records [--split train] [--needs runs/r1.rollout.json]
cargo run --release -p centraid-datagen -- unpack-cache --in v1/build/llm-cache.jsonl.zst --out msgs/llm-cache
cargo run --release -p centraid-datagen -- show --in v1/ --tokenizer tokenizer.json [--split train] [--session ID]
```

`build` draws half as many sessions again as the targets by default (`--sessions` sets it), so the mix has something to choose from; `--reuse` skips a stage whose manifest exists under `<out>/stages/`. `worlds` writes `<out>/<split>/<id>.json` (and `.vault` with `--vaults`) and `manifest.json`. `intents` runs stages 2 and 3 over the worlds of the run and prints the coverage report (also `report.txt`): the grid's size and its not-live cells, solvable intents per live cell (kept / drawn, with drop reasons), the shares along each axis, and the multi-turn share. Each world visits every live cell once as the first turn of a session, then keeps drawing until it has `--per-world` sessions (default: one per live cell); `--sessions train,val,test` derives it from the targets. Use `--release` for a long run: the first run's 20,010 sessions over 60 worlds take about an hour and a half in release. `DATAGEN_DEBUG=1` prints every drop with the intents that led to it. The package is `centraid-datagen`; the binary is `datagen`.

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

`cargo test -p centraid-datagen`. The intents tests run three worlds with more rows in the trash than a preset puts there (a `restore` needs one) and hold: a run is a pure function of its seed; every live cell has a solvable intent; the shares (multi-turn, three or more turns, across-app, three or more constraints among the turns that select by constraints); each follow-up leans on an earlier turn; each minimal pair differs in its answer; every name a create or rename gives is from its kind's pool, has no trailing number and clashes with no row of the kind; **replaying every session's reference calls through `assist_eval::run::Runner` passes every turn**, so gold is the runtime's effect reproduced and the eval loads what datagen writes; and a written run opens as an `EvalSource` with its worlds. `-- --ignored` also seeds all 60 worlds (about two minutes).

`tests/messages.rs` runs stages 4 and 5 over a small intents run with a **deterministic fake model** (no network): a rebuild from a warm cache makes zero calls and every output file is byte-identical, `--offline` on a cold cache fails, no sealed placeholder or datagen placeholder reaches a prompt (checked against every placeholder the worlds seed), the output opens as an `EvalSource` with real messages and a verdict on each turn, and `World::from_doc` reads a world back from its document. Unit tests cover the checks (span, pronoun repeating a name, hygiene), the parsing of an answer, the cache and the typo pass (spans, numbers and date words survive even heavy noise).

`tests/rollout.rs` rebuilds each record of a small data version as a rollout record (the messages read back out of its text) and proves it renders to the same text, ids and weights, and runs a scripted model (`assist-eval`'s `fake::Scripted`) over a session through the eval's runner into `records::cut` with the renderer. `tests/render.rs` renders and mixes a small intents run with the byte-level tokenizer and proves: every step's think compiled back to its reference call (the count is in the manifest), the ids decode to the text, the mask is exactly the assistant messages by an independent reading of the text (every `<|im_start|>assistant\n<think>\n` opens one region that runs to its `<|im_end|>`; a region is all trained, or all zero when it is a call the runtime was expected to refuse, and those are counted against the `bad` calls), the records carry the contract and load in `assist-eval` unchanged, **replaying their reference calls through `assist_eval::run::Runner` passes every turn** (so the rewritten periods keep their gold), no world is in two splits, noise follows val, the manifest names the version, and a rebuild is byte-identical. Unit tests cover the think (typed filters, `dates[i]`, the compact date, `nums[i]`, picks and their reasons, fields under chat's names, a value a slot cannot spell), the decision spans, the weights, byte offsets, and the mix (targets hit, pairs whole, duplicates out, the multi-turn floor, supply-limited reports, a world in two splits refused, water-filling).
