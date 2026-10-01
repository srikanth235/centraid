# Flat tool surface for Qwen3.5-0.8B — spec, draft 2

Status: draft 2, approved for build; §14 decisions taken. Draft 2 folds in the second review: dates are a typed expression the model writes and the runtime evaluates (no phrase parsing in the runtime), the ambiguity check reads only the call, one way per read and per write, `more` covers any next call, compaction and `#n` reach agree, and the undefined corners (undo, idempotent writes, balance, guardrail denominators, think guard, duplicate calls) are settled. Accuracy is the only target; cost is not measured or optimised in this phase. Built fresh: a new tool runtime over the real vault, a new world generator, a new scorer and new evaluation sets. Past experiment code (`crates/candidates`, earlier generators, scorers and data) is left untouched and is not reused or depended on.

## 1. Principles

1. **The model decides, the runtime computes.** The model owns everything that needs language: what the person wants, which words name things, which kind, which constraint, which of the shown rows, how a date phrase reads, the answer shape. The runtime owns everything computable: retrieval, name matching, date arithmetic, unit conversion, filtering, joins, aggregation, schema validity. **The runtime reads the person's message in two places only** (§3.3: repairing a stated date, picking the in-focus row); otherwise its inputs are the call and the vault.
2. **Accuracy first.** Extra steps, longer prompts and reasoning tokens are acceptable when they raise accuracy. Cost and latency are out of scope for this phase.
3. **Few flat tools; compose across steps by handle.** No nested expressions. A step does one thing; later steps point at its rows (`#n`) or its whole result (`@n`). The common case is one step.
4. **Plain words, human units.** Model-facing kind and field names are plain English (`person`, `debt`, `date`, `amount`), amounts in currency units, every dated kind has a `date`. The runtime maps to vault names (`core.party`, `obligation`, `dtstart`, `amount_minor`).
5. **No dead ends.** Every observation says what exists and what can be done next.
6. **One name per effect; one way per action.** Exactly one spelling for each write and each read pattern, so equivalent calls cannot differ. Concretely: names are filtered only by `name`, dates only by `when`, values are computed only by `op` (§4.3).
7. **One source of truth.** Tool schemas, the kind card, the constrained-decoding grammar, the runtime tables, the row cap and the generator's vocabulary are generated from one metadata table that lives in the runtime crate (model-facing name, runtime name, unit, kind, links, verbs).
8. **Native format.** Calls use Qwen3.5's own tool format (XML tool calls, JSON schemas in the system prompt, `<tool_response>` results). The only reason to deviate is a session that does not fit the training length (§11.6).

Non-goals: the model never writes SQL; no reference operators (`the other one`, `that one`, `it`, `them`, ordinal refs) — rows are named only by `#n` / `@n` the model has seen; the runtime never parses natural language (names, dates, amounts all arrive typed).

## 2. Division of labour

| concern | model | runtime |
| --- | --- | --- |
| intent (read rows / read value / write / ask / decline) | ✓ |  |
| which words in the message name a thing | ✓ |  |
| kind | ✓ | lists kinds; errors on unknown |
| constraints (name, field conditions, date, link) | states them | evaluates them |
| dates ("last november", "an hour earlier", "next monday at 2") | writes a date expression (§4.4) | evaluates it against `today` or the row, echoes the absolute range |
| money ("over fifty dollars") | `amount > 50` | converts to minor units in the vault's default currency (§14), shows currency |
| retrieval | decides to search | ranks; optional pre-grounding (§6.1) |
| selecting rows by a constraint | states the constraint | returns exactly the matching rows |
| selecting rows by judgment (ordinal, "the dentist one") | picks `#n` | shows position |
| ambiguity ("Neha" fits two people) | asks, or picks if the conversation settles it | refuses a write whose selector matches several rows (§3.3) |
| schema validity |  | rejects with the valid options |

## 3. Row selection — who picks rows

**The harness never picks rows on its own judgment.**

1. **It returns exactly the rows a stated constraint selects.** `find kind=task name="Benedikt"` returns every live task whose name matches; nothing is dropped or added.
2. **It numbers every row and every result.** Rows get session-wide numbers `#n`; each `find`, `search`, `compute` result gets a handle `@n`. Each row shows its position in its result (`[3]`), so "the third one" is a lookup, not counting.
3. **The one safety check, defined on the call alone.** An `act` whose target is given by a selector (not by `#n`) and whose selector matches more than one live row returns `ambiguous:` with the candidates and does nothing. Whether several matches were intended (a bulk write) or not is the model's call: it names the rows by `#n`, or narrows the selector, or asks. Two things read the message, and nothing else does (real exceptions to "the runtime does not look at the message"): (a) **Date repair** (`ground.rs`): when the model's date expression contradicts the one unambiguous phrase the message states, the runtime replaces it and says so in the observation. Narrowed rules: a phrase has a role, `Row` (names the row: "the one due tomorrow", "from monday"), `Dest` (where a write puts it: "to friday", "make it due friday") or `Free`, and a `Row` phrase never becomes a write's new date; ordinals ("the twentieth") never rewrite a date that exists (only a nonexistent one such as 2026-11-31 under a single stated ordinal); a bare weekday is left alone when it is today's weekday, is already past, or a prior result showed a later week (and for a short follow-up to a turn that only asked); a span is repaired only when both its ends resolve to the same day. (b) **Focus pick** (`session.rs`, `Session::focus`): a by-name `act` that fits several rows takes the one in focus when exactly one is. Rows acted on or opened in the previous or current turn always count; rows of a `find`/`search`/`answer` result count only when the result has at most 4 rows (`FOCUS_RESULT_MAX = 4`); an `ambiguous:` block never counts. The runtime reads the message for nothing else. The generator applies the same rule, so train and test agree.

**The model selects in one of two ways, preferring the first:**

- **By constraint (default).** If the choice can be said as a condition — name, kind(s), date, status, amount, link — it says it in `find`/`answer`/`act`. "The Benedikt task and the calendar entry" → `answer kind=task,event name="Benedikt"`. "The ones over fifty dollars" → `answer within=@3 where="amount > 50"`.
- **By pick (only when no condition expresses it).** Ordinals, "the dentist one" where the name doesn't literally match, a row from an earlier turn. The model names `#n` it has seen; its reasoning lists each candidate with a verdict and the picked rows follow from the verdicts (§7). Rows in the pre-grounding block (§6.1) and the vault directory (§6.0.4) count as seen and are pickable; that is their purpose.
- **Large results.** Real vaults return hundreds of rows; only `ROW_CAP` (12, a metadata constant) are shown. Picking by number is legal only among shown rows; anything else is a constraint (`order`, `limit`, `when`, `name`). The generator logs how often a gold answer exceeds `ROW_CAP`.
- **Compacted rows are not addressable.** After compaction (§6.4) a row that was dropped from an earlier result can be reached only through its result: `within=@1` plus a constraint, or `search`. The generator never emits a `#n` from a compacted result; the grammar (§9) forbids it.

## 4. Tools

`rows` accepts a comma list of `#n` and `@n` (mixed). `kind` accepts one kind or a comma list; `any` is allowed only in `search`. `find`'s selection parameters are called the **selector** and are shared by `answer` and `act`, so the common case is one step.

| tool | parameters | returns | ends turn |
| --- | --- | --- | --- |
| `search` | `text`, `kind?` | ranked, fuzzy rows of any kind, with their numbered links | no |
| `find` | selector | the matching rows as `@n` | no |
| `open` | `row` (one `#n`) | every fact of the row and its links, with counts | no |
| `compute` | `op`, `field?`, `group`, `rows` or selector | `@n` = one number per group | no |
| `act` | `verb`, `rows` or selector, `args?`, `more?` | what changed, dates resolved | yes, unless `more=true` |
| `answer` | `rows` or selector; or `op`, `field?`, `rows` or selector; or `value=@n` | — | yes |
| `ask` | `question`, `options?` (rows) | — | yes |
| `decline` | `reason` (out_of_scope · unbounded_destruction · sealed_egress · fabricated_secret · never_mind · not_found) | — | yes |

`more=true` on `act` means "another call follows" — another `act`, or an `answer` ("mark it done and tell me what's left"), or a `find`. Without it the turn ends.

### 4.1 Selector

`kind`, `name?`, `where?`, `when?`, `linked_to?`, `within?`, `exclude?`, `order?`, `limit?`, `trashed?`.

- `name` — exact whole-word match, all words, any order. This is the ONLY way to filter by name; `where` has no name field. Fuzzy or cross-kind lookup is `search`.
- `when` — a date expression (§4.4) applied to the kind's `date`. This is the ONLY way to filter by date; `where` has no date fields.
- `where` — conditions joined by `and`: `field op value` with op in `= != < <= > >=`, `contains "…"` (text fields other than name), `in ("a", "b")`, `is empty`, `is set`; a linked-count condition `<kind> count op N`. No `or` except via `in`; no `not` except via `!=` / `is empty`. Its per-kind grammar is generated from the metadata table.
- `linked_to` — rows the results must be linked to (`kind=photo linked_to=#3` = photos of person #3; `kind=person linked_to=#1` on a group = its members). Link semantics per kind pair come from the metadata table.
- `within` — an earlier result (follow-ups). `exclude` — rows to leave out ("what else").
- `order` — `field asc|desc`; `limit` — N. `trashed=true` searches only trashed rows.
- **Multi-kind selectors** (`kind=task,event`) may use only `name`, `when`, `linked_to`, `within`, `exclude`, `limit`, `trashed`. `where`, `order`, `op/field` and `act` require exactly one kind, because fields are per kind.

**Two-step is for looking.** `find` then `answer @n` is used when the model needs to see rows before committing (a pick, a check that a name resolved). A read the model can state as a selector is one `answer`. The trace says which and why.

### 4.2 Verbs

`act` verbs — one per effect, dispatched by the kind of `rows`. The table is GENERATED from the domain commands the gold corpus uses; this is the expected shape:

| verb | applies to | args |
| --- | --- | --- |
| `create` | the top-level `kind` | that kind's fields, `name` included (dates as §4.4 expressions) |
| `edit` | any | `field: value` lines (rename, change amount, set status) |
| `reschedule` | task, event | `to: <date expr>`; "an hour earlier" is `{"unit":"hour","rel":-1,"anchor":"row"}` |
| `complete` · `reopen` | task | — |
| `cancel` | event | — |
| `delete` · `restore` | any | — |
| `star` · `unstar` | document, person, locker item | — |
| `add_to` · `remove_from` | photo→album, note→notebook, document→folder, person→group | `to: #n` / `from: #n` |
| `log` | person | `kind: call · message · visit · coffee` |
| `settle_up` | person in a group | `group: #n` (amount = their balance unless given) |
| `settle_debt` | debt | — |
| `reveal` | locker item | `field: password · code …` |
| `undo` | the previous turn's writes | — |

- Several writes in one message: each `act` but the last has `more=true`. One write names every row it applies to.
- **`undo`** reverts every write of the immediately previous turn of this session, as one unit, once. A second `undo`, or an `undo` with no previous write in the session, returns `error: nothing to undo`. Undo across sessions is out of scope.
- **Already-so writes** (`complete` on a completed task, `restore` on a live row, `star` on a starred row, `cancel` on a cancelled event) are not errors: the runtime changes nothing and returns `already: #12 task "Book the cabin" is completed (2026-06-01)`. The model answers with that. Gold for such turns is "no vault change, answer states the current state".
- **Impossible writes** (`complete` on an event, `reschedule` on a person) are schema errors (§5).

### 4.3 Values

`op` in `count · sum · min · max · balance`. `count` needs no field. `balance` is defined only for `kind=person` (`me` versus that person: positive = they owe me) and for `kind=group` with `linked_to` a person (that person's net position in the group); the metadata table names the kinds it applies to. `answer op=…` is the one-step form; `compute` exists only for `group` (one number per value of a field) and for a value a later step consumes (`answer value=@n`, `where amount > …` cannot take a handle, so this is rare). The generator never emits `compute` followed immediately by `answer value` when `answer op` would do.

### 4.4 Date expressions

The model writes a small JSON object; the runtime evaluates it. No English reaches the runtime.

```
{"unit":"month","name":11,"rel":-1}                   last november (most recent fully ended November)
{"unit":"day","rel":0}                                today
{"unit":"day","rel":1}                                tomorrow
{"unit":"day","rel":-3}                               three days ago
{"unit":"week","rel":0}                               this week (Mon–Sun containing today)
{"unit":"week","rel":1,"weekday":1,"time":"14:00"}    next monday at 2
{"unit":"hour","rel":-1,"anchor":"row"}               an hour earlier (relative to the row's time)
{"date":"2026-09-30"}                                 a date the person typed
{"date":"2026-09-30","time":"09:30"}                  with a time
{"from":{...},"to":{...}}                             a span, both ends expressions
{"from":{...}} / {"to":{...}}                         open-ended ("since March", "before Friday")
```

Fields: `unit` (minute · hour · day · week · month · year), `rel` (signed integer), `name` (month 1..12, only with `unit=month`), `weekday` (1..7 Mon..Sun, only with `unit=week`), `time` (`HH:MM`), `anchor` (`today` default · `row`, the target row's `date`; `row` is legal only inside `act`). A unit without `time` denotes the whole period as a range. The runtime resolves to an absolute range or instant, echoes it in the response (`when: 2025-11-01..2025-11-30`), and rejects anything outside the grammar with the grammar's examples. The grammar is shared with constrained decoding, so a malformed expression cannot be emitted in hard mode.

**Gold form.** Weekday and relative phrases ("friday", "next monday at 2", "tomorrow", "three days ago", "an hour earlier") are written in the structured form above (`unit`/`rel`/`weekday`/`time`/`anchor`), never as an ISO date. ISO (`{"date":...}`) is used only for an explicit calendar date the person typed ("the 3rd of may", "2026-11-05"). A bare weekday written as ISO is a training-data error: the model would be computing the date, which the runtime owns.

Interpretation conventions ("at 2" = 14:00 for hours 1..7; "last november" = the most recent ended one; "next monday" = the Monday of next week, even on a Sunday) are the model's, learned from the generator's phrase→expression table, and are listed in §14 for the owner to confirm. The runtime evaluates only what it is given.

### 4.5 Parameter repair and the trace guard

- **Salvage** (`parse.rs`, `salvage`): a parameter the model invents for a real one is renamed when the value says which: `result` (or `row`, when the tool has no `row` parameter) holding `@n` becomes `within`, `#n` becomes `rows`, a kind name (or `people`) becomes `kind`. A key the tool really accepts is never renamed: `open` keeps `row`.
- **Trace guard** (`trace.rs`): applies only when the think has a line exactly `intent: <read|count|write|ask|decline>` with an optional quoted phrase (old-format thinks never match and are untouched). A call is refused, as an error observation that does nothing, when: `intent: write` with an `answer` call; `act` under a non-write intent; `scope: one` with a write naming several rows; `refer -> @k` (or `#n`) with rows outside the referent, or `refer: both` with rows not equal to the whole referent. A refused call still counts as a step but not as the last call, so the same call under a corrected trace is not a repeat. A malformed `scope` or `refer` line is ignored.
- **Bulk-write guard** (`act.rs`, `bulk_allowed` in `trace.rs`): a write on more than `ROW_CAP` (12) rows is refused; with a trace only `scope: all` lets it through, and with no scope line the message's own "all"/"every" decides.

## 5. Observations

- **Result header, kind card, rows:**
  ```
  @3 · 5 tasks (showing 5)   [task: date (due), status, effort, completed]
  #12 [1] task "Book the cabin" · Fri 2026-06-19 09:00 (this Friday) · status open
  ```
  `ROW_CAP` rows shown, the rest counted and still addressable through `@3`. Amounts show currency.
- **Links inline** on search hits. **Values**: `@5 = 42.00 USD` (sum of amount over @3, 4 rows).
- **Writes** echo what changed, with resolved dates and the `#n` of any created row (so a group created mid-session is addressable although the directory was rendered at session start).
- **Already-so writes**: `already: …` (§4.2). **Undo**: lists each reverted change.
- **Empty find**: `0 tasks called "tabla". Other kinds called "tabla": #13 event "Tabla class"`.
- **No link**: `events are not linked to places. Events whose name mentions "Mallaig": #7, #8`.
- **Ambiguous** (§3.3): `ambiguous: "Neha" fits #3 person "Neha Rao", #4 person "Neha Kulkarni"; nothing was done.`
- **Only trashed**: `no live task called "library"; trashed: #9 task "Library books" · trashed`.
- **Error**: `error: tasks have no field "due_on". task fields: date, status, effort, completed.` Errors name every valid option. A call that fails to parse returns `error: could not read the call` plus the tool list. Errors count as steps (§6.3).
- **Compaction (§6.4)**: an earlier turn's result is replaced by its header plus the rows any later call referenced: `@1 · 23 tasks (compacted; #4, #7 kept)`.

## 6. Turn loop

0. **System prompt**, rendered by the harness at session start, in this order, each part generated:
   1. `today: <weekday> <date>` and the person's own name (`me`).
   2. **Tools** — the §4 tools in Qwen's native `<tools>` block as **signature lines** (`--tools sig`): each tool's params with `?` for optional and enums inline; the date expression's fields once, on `find`. The surface is fixed, so described schemas would repeat identically in every example and teach the fine-tuned model nothing the calls don't. Full described schemas (`--tools full`) are used only for untrained models (the Sonnet smoke test).
   3. **Kind card** — one line per kind: its model-facing name, its fields with enum values and units, its links, its verbs (`task: date (due), status (open|in_progress|completed|cancelled), effort (min), completed · links: subtasks · verbs: create edit reschedule complete reopen delete restore`). About 450 tokens for today's surface; the same lines constrained decoding uses.
   4. **Vault directory** (flag, ablated) — the names of the vault's CONTAINERS, the small sets a message refers to by name: groups, albums, notebooks, folders, lists; each as `groups: Tahoe Trip (#1), Flat 4B (#2)`, pre-numbered so a call can use `#n` directly. Capped at 8 per kind, most recently used first, with `+N more` (reachable through `search`). People, events, tasks, notes and photos are NOT listed: they are too many and change every turn; the pre-grounding block (6.1) covers them. Containers created mid-session are addressable through the `#n` echoed by their `create`.
   5. **Conventions** — none. Policy lives in the training data, not the prompt; a rule in the prompt that the data contradicts is noise to a 0.8B model. The prompt is identical in form in training and at inference; the generator renders the directory from each training world.

1. **Pre-grounding (flag, ablated, conditional).** When a message token scores above a threshold in the runtime's name index (the same fuzzy index `search` uses — retrieval, not interpretation), the harness prepends to the USER turn a block `vault: #3 person "Neha Rao" · #4 person "Neha Kulkarni" · …` of at most 5 rows. Not a synthetic assistant call, so the model does not learn "always search first". Training data includes turns where the block is irrelevant and the model ignores it.
2. The model makes one tool call per assistant message; the runtime answers; repeat.
3. The turn ends on `answer`, `ask`, `decline`, or an `act` without `more`. **Step cap 6**, counting every model call including ones that returned an error. **An identical call twice in a row** ends the turn: the runtime returns `error: repeated call` and the turn is scored as a fail (diagnostic label `loop`). Hitting the cap is likewise a fail (`cap`).
4. **Compaction.** Before each new turn, results of turns OLDER than the previous one are compacted (§5); the previous turn's results stay whole, since follow-ups pick from them. Rows the model created or acted on are always kept. Earlier turns' **thinking is kept**: the harness renders the history itself (not Qwen's default template, which drops it), so on a follow-up the model sees how it read the earlier turn. Training and inference use the same renderer. The generator renders training sessions with the same compaction.
5. `#n` and `@n` persist across the session; `#n` of compacted rows are not addressable (§3).
6. **Decoding.** The headline score is **greedy** (reproducible). Sampled decoding as Qwen recommends (temperature 0.6, top-p 0.95, fixed seed) is an arm in the first run and stays an arm only if it beats greedy by more than the noise floor. **Think guard**: at 200 think tokens the harness forces `</think>` and lets the call follow; the event is counted (`think_cut`) as a diagnostic, not a fail.

## 7. Reasoning (trace grammar v2)

A short `<think>` block before each call: fixed-order slots, one per line. Every value is a closed word or a quoted span of the user message; nothing the runtime can compute (no row lists, no resolved dates). Each slot depends only on the message, the context and the slots above it. The generator is `authored/trace.py` (`derive_trace`, `render`, `parse`); the Rust guard (`crates/nativetools/src/trace.rs`) parses the three slots it enforces (intent, scope, refer) from the same text.

```
retry: rejected                                 (only after a rejected call)
intent: read|count|write|ask|decline "<deciding phrase>"
verb:   <verb>                                  (writes)
scope:  one|some|all "<qualifier>"              (an act naming existing rows; not create or undo)
refer:  it|both|that|nth "<phrase>" -> @k|#n    (the call names rows an earlier turn showed)
target: "<span>" · "<span>"                     (names, attribute spans, new values, as said)
when:   "<date phrase>" | earlier "<phrase>" | now
pick:   #n ok · #n no (<reason>)                (a row is chosen among several shown)
```

| slot | values | closed set defined in |
| --- | --- | --- |
| `retry` | the literal `rejected` | `trace.py` `LINE_RX["retry"]` |
| `intent` | read, count, write, ask, decline | `trace.py` `INTENTS`; Rust `trace::Intent` |
| `verb` | create edit reschedule complete reopen cancel delete restore star unstar add_to remove_from log settle_up settle_debt reveal undo | `trace.py` `VERBS`; Rust `meta.rs` verb table |
| `scope` | one, some, all | `trace.py` `SCOPES`; Rust `trace::Scope` |
| `refer` | it, both, that, nth; handles `@k` or `#n`, comma separated | `trace.py` `REFERS`; Rust `trace::ReferKind` |
| `when` | a quote; `now` (the unstated default, from today on); `earlier` with an optional quote (said in an earlier message, or an earlier call's own date) | `trace.py` `LINE_RX["when"]` |
| `pick` reason | kind, name, position, date, status, other | `trace.py` `REASONS` |
| `target`, all quotes | spans of the message | `trace.py` `find_span` |

Slot order is `trace.py` `SLOT_ORDER`; `parse` rejects a line that is not a slot or is out of order.

- **Lookups carry the intent of the call they prepare** (read off the turn's own next call); when an `ask` or `decline` follows, the message alone decides.
- **`scope`** is written on an `act` naming existing rows (not `create` or `undo`). More than `ROW_CAP` rows is `all`; one row `one`; a qualifier such as "except the padel one" is `some`.
- **`target`** also carries attribute spans and new values ("over fifty dollars", "Dr Patel"); a value the message does not say but the context does is sourced there.
- **`refer` fixes "bring both back":** `refer: both "both" -> @3` and the call is `rows=@3`.
- **Guard:** see §4.5.

Examples (generated from the final train file; the message is the user turn, the call follows the trace):

```
user: delete crossbridge's property manager from my contacts, they got replaced
intent: write "delete"
verb: delete
scope: one
target: "property manager"
call: act {"verb":"delete","kind":"person","where":"role contains \"property manager\""}
```

```
user: bring greg back, i need him for the deposit thing
intent: write "bring greg back"
verb: restore
scope: one
refer: it "him" -> @1
pick: #31 no (name) · #32 ok · #30 no (name)
call: act {"verb":"restore","rows":"#32"}
```

```
user: push tomorrow's short meeting to 4:30
intent: write "push"
verb: reschedule
scope: one
when: "tomorrow"
call: act {"verb":"reschedule","kind":"event","when":"{\"unit\":\"day\",\"rel\":1}","where":"duration < 60","args":"to: {\"unit\":\"day\",\"rel\":1,\"time\":\"16:30\"}"}
```

Checks (`trace_check.py`): trace-call consistency (a call rebuilt from the parsed slots equals the gold call in every field the slots decide) and argument sources (every call argument traces to a slot, a handle or the context). Length is set by what the decision needs, with the think guard (200 tokens, §6.6) as the only cap.

**Correction-round traces** (§11.4): the teacher is the generator's own policy executor, so corrected steps carry traces from the same code as every other step.

## 8. Policy (the decision procedure the generator executes)

1. **Intent.** Question about rows → `answer rows`; "how much / how many / total" → `answer op`; change → `act`; the vault cannot decide → `ask`; outside the vault or unsafe → `decline`.
2. **One step when the selector says it all; look first when it does not** (a pick, an unfamiliar name, a write whose target must be seen).
3. **Unfamiliar name → `search`.** A name is _unfamiliar_ when it appears neither in the vault directory nor in the pre-grounding block of this turn nor in any row shown earlier in the session. Familiar name → selector or `#n`. The generator computes familiarity from the same rendered prompt, so the rule is executable.
4. **Constraint over pick** (§3).
5. **Dead end → recover once.** A dead end is a NAME that resolved to nothing (or only to trashed rows), a missing link, or an error: take the recovery rows the runtime offered, or `search` the name; `decline not_found` only when that also returns nothing. An empty result from conditions alone ("what's due next friday?" with nothing due) is not a dead end: it is the answer, and `answer` returns it and ends the turn.
6. **Ambiguity → `ask`** naming the candidates — unless the message or the conversation already decides it, then pick by `#n`. After an `ambiguous:` response the same rule applies.
7. **Answer exactly what was asked**; the kind the question asks for ("who" → people).
8. **Follow-ups.** A narrowing fragment ("just the weekend ones") = `within=@n` plus the new condition. A substitution fragment ("and Ray?", "and today?") = the previous turn's call with the one named slot replaced, everything else kept. The trace states which.
9. **Corrections add**; `undo` only on "undo that" / "I didn't".
10. **Writes on trashed-only targets** → `decline not_found` unless the person asked to restore.
11. **Never a destructive write from a read phrasing** ("is X in the bin" is a read).
12. **Already-so writes** → `act` anyway; answer with the runtime's `already:` state.
13. **Conventions** are the §14 rulings: bare "wifi password" is a read; "diary" is calendar; members are people linked to a group; the §4.4 date readings; `undo` = the whole previous turn; amounts in the default currency; positive balance = they owe me.

## 9. Constrained decoding

Built from the metadata table, llguidance under HF `generate`:

- the `<think>` block is free; after it, exactly one call of a known tool with its parameter names;
- `kind`, `op`, `verb`, `reason` are enums; `where`/`order` fields are the chosen kind's fields; `act` args are the verb's args; date values follow the §4.4 grammar;
- `#n` limited to numbers shown and not compacted, `@n` to handles issued (own flag). The harness tracks the kind of every issued `#n`, so `edit`/`where` fields for a `#n` target are typed too; when `rows` mixes kinds the grammar falls back to the union and the runtime's error catches it;
- `name`, `text`, `question` and string values are free text;
- **soft mode** (flag): if the mask would force a token the model gives low probability, emit unconstrained so the runtime returns its informative error instead of a silent wrong call.

## 10. Scoring

The new scorer judges each turn by **effect**, never by the call or echo text:

- `answer rows` → the set of vault ids (exact set; the order matters only when gold says `order`);
- `answer op` / `answer value` → the number, with unit;
- `act` → the vault diff (rows changed and the fields that changed), plus, for already-so writes, an empty diff;
- `ask` → the turn ended in `ask` and, when gold names candidates, the options cover them;
- `decline` → the reason. Gold is authored as an effect (ids, number, diff, ask, decline), not as a call, so several valid call paths score alike. Session strict pass (every turn right) is the headline; turns are diagnostic.

## 11. Data and training

1. **Generator** emits abstract actions → rendered in the native format with §7 traces, §8 policy only, §6.4 compaction applied. Coverage planned pairwise over (kind × field/verb), over date phrase families × expression shapes, and over conversation patterns (follow-up types, multi-write, act-then-answer, dead-end recovery, ambiguity then pick, already-so writes, pre-grounding ignored). No injected-error steps.
2. **Paraphrase with a check.** Requests are paraphrased by a strong model for register and idiom; every paraphrase passes a verifier (a second model asked whether the gold call still answers it, plus slot-preservation checks) before it enters training. Rejected paraphrases are logged.
3. **Loss** only on assistant tokens (think + call). Tool results and user turns are masked. The trainer asserts this on a sample.
4. **SFT** on Kaggle (one push), then **one on-policy correction round** (DAgger): run the model on fresh generated tasks, take every failing state, have the generator's policy executor compute the correct next step from that state (it knows each generated task's intent, so it is an exact teacher; no external model), render its trace (§7), add those steps, retrain from base. Optional RL only if this plateaus.
5. **Arms**: thinking is the design; constrained vs free decoding is scored on the same checkpoint (no extra training).
6. **Training length.** Sessions are rendered to at most the trainer's sequence length; a session that still does not fit after compaction is split at a turn boundary, and the split is logged. No other deviation from the native format is allowed.
7. **Training unit is one session.** One sequence = system prompt + every turn of the session as the harness renders it at inference (§6.4: compacted tool results, earlier thinking kept); loss on every assistant message (think + call), none on system, user or tool tokens. The prompt is paid once per session instead of once per trained turn. Sessions have 1–5 turns (mean ~2.5), so first turns and follow-ups are both covered.
8. **Size, from the 10-hour Kaggle limit.** Reference: past runs processed ~11M tokens in ~4.5 h, about 2.4M tokens/h. Of the 10 h, 8 h go to training and 2 h to loading, in-run validation, checkpoint saves and variance: ~19M tokens. With the signature prompt (~1,300 tokens) a session is ~2,500–3,500 tokens, ~1,000 per trained turn, so the budget is ~18,000 trained turns (~7,000 sessions). The Data step measures the real mean on a pilot and sets the session count from 19M tokens. One epoch. The trainer's time budget is 8 h, so it stops and saves whatever happens; checkpoints at 25/50/100% show what was reached.

## 12. Build plan

See `PLAN.md`.

## 13. Metric strategy

**Evaluation sets**, each with one job:

| set | built by | size | use |
| --- | --- | --- | --- |
| **test** | humans, against fresh eval worlds | 300 sessions | the headline; scored once per training run; never tuned on |
| **dev** | humans, same process | 150 sessions | iteration, error analysis, checkpoint picking |
| **generated val** | generator, held-out templates / worlds / phrasing families / combinations | ~1,000 sessions | fast signal during training; coverage per kind × verb |

If test leaks into any decision it is replaced. Dev and test disagree → test wins.

**Headline**: session pass rate on test — every turn right, judged by effect (§10), greedy decoding. Target 90%.

**Guardrails** (can veto a run whose headline rose). Denominators are fixed:

- **wrong-write rate** = turns with any vault change gold did not specify ÷ all turns (not only write turns, since a write from a read phrasing is the worst case) < 1%;
- **under-ask** = turns that acted or answered where gold is `ask` ÷ gold-`ask` turns; **over-ask** = turns that asked where gold acted or answered ÷ gold non-`ask` turns; each tracked, neither may grow beyond the noise floor;
- **generalisation gap** (generated val − test) may not widen.

**Diagnostics** (never optimised directly): turn pass rate by outcome type and slice, row precision/recall, error-recovery rate, cascade rate, constraint-override rate, `loop`/`cap`/ `think_cut` rates, next-step accuracy during training (checkpoint selection), loss curves (health only).

**Decision rules**:

- a change inside the 95% confidence interval is not real;
- one variable per run;
- 95% confidence intervals reported (±~3 points at 300 sessions near 90%);
- a fixed error analysis on dev after every run (cause label per miss, fix class tallied);
- a Sonnet run on dev is a smoke test of the tool surface and gold, not a target: every miss is classified, and gold or runtime causes are fixed; Sonnet is never told the §14 conventions.

**Gold quality**: gold is authored as effects (§10) with an authoring tool that shows the world and records ids / diff; one review pass per item plus an owner spot check of 50 test items; genuinely ambiguous items accept every valid reading or are dropped; after run 1, every test miss with a defensible reading is reviewed before a score is quoted.

## 14. Decisions (taken 2026-09-27)

The owner delegated these; each recommendation below is now the decision and is binding on the runtime, generator and gold. The owner may still amend any of them.

| decision | ruling | why |
| --- | --- | --- |
| "wifi password" | the row (`answer rows`), not `reveal` | asking where something is is a read; `reveal` is a deliberate egress of a secret and should need a reveal verb aimed at it ("show me", "tell me", "read it out"). The noun phrase "wifi password / pw / code" is a name for the row, so "what's the wifi password" is still a read; details in §14.1. Both readings are covered by the generator; only the bare-noun case is settled here. |
| "diary" | calendar (events), except "diary entry" / "journal" / "journal entry" → note | British usage in the gold corpus is calendar; the two-word forms are unambiguous. |
| `member` folded into `person` | yes: members = `kind=person linked_to=<group>` | one kind fewer in the card, one link pattern that already exists; nothing a member has that a person lacks. |
| model-facing names | `person`, `group`, `event`, `task`, `note`, `document`, `photo`, `album`, `debt`, `locker item`; `date`, `amount`, `status` | short, singular, one word where possible; `contact` rejected because `person` also covers `me` and group members. |
| vault directory | groups, albums, notebooks, folders, lists; cap 8 per kind | these are the kinds a message names without a hint; 8 covers the p95 of generated worlds and stays under ~120 tokens. Ablated in run 1 either way. |
| date conventions | "last november" = most recent fully ended November; "at N": the message or the target row decides first (dinner, drinks, party, movie, "tonight" → evening; breakfast, "morning" → morning), otherwise 1..7 = pm and 8..12 as written; "next monday" = Monday of next week even on a Sunday; "this weekend" = coming Sat–Sun (today if Sat/Sun); weeks start Monday; bare weekday ("monday") = the next occurrence, today included | one fixed reading each; the model learns them from the phrase table and the echoed range lets it check. |
| `undo` | the whole previous turn's writes, once, this session only | matches how people say "undo that"; anything finer needs a reference operator, which is a non-goal. |
| currency | bare amounts in the vault's default currency; multi-currency vaults show the unit on every row, comparisons are per currency, `sum` across currencies returns one number per currency | the model never converts; the runtime never guesses a rate. |
| `balance` | positive = they owe me; group balance = that person's net position (positive = the group owes them) | one sign convention stated in the kind card and echoed on every value. |

### 14.1 What each convention means in the authored data

One behaviour per convention; the authored sessions and the checks in `authored/audit.py` hold to exactly this.

- **wifi** (`wifi password`, `wifi pw`, `wifi code`): the phrase names a locker row. A message that only names it or asks what or where it is ("wifi pw?", "what's the home wifi password", "where did i save the wifi code", "do i have the wifi password saved") is `answer rows` on the row and never `reveal`. Only a reveal verb aimed at the secret is a `reveal`: "show me", "tell me", "read it out", "read me", "reveal", "give me" the wifi password. When two wifi rows fit a reveal, the turn ends in `ask` with both as options. Sending it ("text", "whatsapp", "email" it to someone) is `decline sealed_egress`; inventing one ("make up", "invent") is `decline fabricated_secret`. Other secrets follow the ordinary rule ("what's the router password" is a `reveal`).
- **diary**: "diary" (also "my diary", "in the diary", "diary tomorrow") means the calendar, so the reading is kind `event`: "what's in the diary tomorrow" is `answer kind=event when=tomorrow`, "put dinner in the diary thursday at 6" is an event `create`. "diary entry", "journal" and "journal entry" mean a note. A row whose own name contains "diary" (a notebook called "Diary 2019") is addressed by that name like any row, and the convention is off for it.
- **balance**: `answer op=balance` (or `compute`) always ends in a value. The sign comes from the vault and never from the wording: for `kind=person` positive = they owe me, negative = I owe them, so "how much do i owe X" can come back positive (X owes me) and the model reports what the vault says. For `kind=group` with `linked_to` a person, positive = the group owes that person; `linked_to=$me` is my own position ("where do i stand in it"). A named person with no group in play is the person balance; a group in play (named, or carried over from the last turn) is the group balance; totals over all debts ("how much do i owe all in") are `sum` over debts, not a balance.
- **weeks**: a week is Monday to Sunday. "this week" contains today (`unit=week rel=0`), "next week" is the following Monday to Sunday (`rel=1`), "last week" the one before (`rel=-1`), on a Sunday too. "before this week" ends with last week.
- **weekend**: "this weekend" and "the weekend" are the Saturday and Sunday of the current Monday to Sunday week (`rel=0`, weekdays 6 and 7; on a Saturday or Sunday that is today's weekend). "next weekend" is the Saturday and Sunday of next week (`rel=1`). Writers who mean the one after a Sunday say "next weekend".
- **next weekday**: "next friday" is the Friday of next week (`rel=1`, `weekday=5`), from any day including a Saturday or Sunday. "friday week" is the Friday of the week after next (`rel=2`).
- **bare weekday**: "friday" alone is the next Friday counting today (`rel=0` while the weekday is still ahead or today, else `rel=1`). Someone who means the Friday a week on says "next friday" or "friday week".
- **at N**: as in the table; the row's own name or the message ("dinner", "drinks", "party", "movie", "tonight" evening; "breakfast", "morning" morning) decides first, then 1 to 7 is pm and 8 to 12 as written. Writers who mean the early hour say "7am".
- **last month name**: "last november" is the most recent November that has fully ended (`unit=month name=11 rel=-1`).
- **Trace slots** (`authored/trace.py`; the lexicon is `VERB_RX`, `COUNT_RX`, `READ_LEAD`, `DECLINE_RX`, `ALL_RX`, `BOTH_RX`, `PLURAL_RX`, `EXCEPT_RX`, `IT_RX`, `NTH_RX`, `REFER_PHRASE_RX`):
  - `intent`: the deciding phrase is the first match of the intent's lexicon in the message: for a write the verb's `VERB_RX` entry ("tick it off", "call off", "push"), for a count `COUNT_RX` ("how many", "owe", "total"), for a read `READ_LEAD` (the question word plus the next two words), for a decline the reason's `DECLINE_RX` entry. When no lexeme matches, `intent_phrase` falls back to `lead_phrase`: the whole message if it has at most 7 words, else its first clause (cut at `, ; : . ! ?`, a dash, "so" or "because") if that has 2 to 7 words, else the first 5 words, and flags `intent-phrase-fallback`. About 24% of intent phrases take this fallback (3,548 of 14,940 good calls in the final train file; the refer phrase falls back on 17.4%, 376 of 2,165), mostly fragment follow-ups ("3 is fine").
  - `verb`: the closed verb set, read off the call; no quote.
  - `scope`: `one` has no quote; `some` quotes the exception clause (`EXCEPT_RX`: except, besides, apart from, other than, but not, minus ...) plus up to 4 words, else the `BOTH_RX` match or a count word; `all` quotes the `ALL_RX` match (all, every, each, whole ...).
  - `refer`: a follow-up is a call that names rows an earlier turn showed and the message does not name. Kind by order: `both` when the call takes a whole multi-row result and the message has a `BOTH_RX`/`ALL_RX` word; `nth` for an ordinal (`NTH_RX`: "the second one", "number 3", "3 is fine", "the other one") when one row is meant; `it` for a personal pronoun (it, its, him, his, her, he, she); `that` for other `IT_RX` words (this, that, there, the same, the one). If none matches, the quote is the stretch of the message that shares words with the referent's names, else the first date phrase, else `lead_phrase` (flag `refer-phrase-fallback`).
  - `target`: the spans of the message the call's names, attributes and values match (`find_span`, at least half the words).
  - `when`: the date phrase as said (`date_clusters`); `earlier` when it is from an earlier message or an earlier call; `now` for the unstated default (`is_default_now`). No phrase found is flagged `when-no-phrase` and fails the argument-source check.
  - `pick`: one verdict per shown candidate, with a reason from `REASONS`.
