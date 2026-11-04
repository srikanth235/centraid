# Contract v3: the slot trace

Status: current. The trace is the only think format: `authored/build.py` writes it, `train/fmt.py` and `train/decode.py` read it, and the current model is trained on it. Issue [#1044](https://github.com/srikanth235/centraid/issues/1044). Section 7 (v3.1) adds the picks, the typed `where` and the runtime's compile step; section 8 (v4) cuts the slots the model writes to the ones the harness cannot infer; section 9 regroups the tools ([#1166](https://github.com/srikanth235/centraid/issues/1166)) and says what that changed in every section above.

## 1. Why

A think that names only the intent, the verb, the scope and the rows leaves the call's arguments for the model to remember when it writes the call: the `kind` of a search, `exclude`, `order` and `limit`, `more: true`, the `time` of a date, a date written as ISO instead of `{unit,rel,name}`, `amount = 35 BRL` read as `limit: 35`. So the trace states every argument once, in a fixed order, and the call is the rendering of the think. The `refer:` line is decided by the turn, not by the words of the message (section 4), so the model has nothing to detect, only to say. The failure analysis behind both choices is in #1044.

## 2. Format

One `label: value` line per slot, in a fixed order; a slot that the call does not need is absent. The Rust guard reads the `intent`, `scope` and `refer` lines and ignores the rest (`refer: none` is a malformed refer to it, and is ignored).

```
retry: rejected                               only after a rejected call
intent: read|count|write|ask|decline "<deciding phrase>"
via:    find|compute                          the tool, when it is not the intent's own (read, count -> answer; write -> the tool of its verb: create, edit, else do); S2 wrote search and open (section 9)
verb:   <verb>                                writes: create edit reschedule complete reopen cancel delete restore star unstar add_to remove_from log reveal undo
scope:  one|some|all "<qualifier>"            a write on rows that already exist
refer:  it|both|that|nth "<phrase>" -> @k|#n  the call names rows an earlier turn showed
refer:  none                                  the message points back and the call names no earlier rows (section 4)
target: "<span>" · "<span>"                   spans of the message the values come from, minus a span the name, text, set value or where literal already says
kind: op: field: group: trashed:              the argument, as the call carries it
name: text: where:                            the exact value, unquoted, to the end of the line
when:   "<phrase>" = <date>                   the source (quote | now | earlier ["<phrase>"]), then the `when` argument
linked_to: within: exclude:                   handles
order: limit: more:                           the argument
set:    key = value · key = ~<date> ...       the lines of an act's `args`, in order; `~` marks a date
time:   HH:MM · HH:MM                         one value per `t` in the dates, in order (`when` first, then `set`)
pick:   #n ok · #n no (<reason>) ...          a row chosen among several shown
rows: row: value: options: question: reason:  the argument; `rows` / `row` are left out when pick or refer already state them
```

- Every value is a closed word, a quoted span of the user message, or an argument as the call carries it. Nothing the runtime can compute: no row lists, no resolved dates. A slot depends only on the message, the context and the slots above it.
- `intent`: what the call is for; the quote is the deciding phrase. A lookup (`find`) carries the intent of the call it prepares, read off the turn's own next call. When an `ask` or a `decline` follows, the message alone decides.
- `scope`: written on an `act` that names existing rows, not on `create` or `undo`. One row is `one`. More than `ROW_CAP` (12) rows is `all`. A qualifier such as "except the padel one" is `some`.
- `refer`: written when the call names rows an earlier turn showed and the message does not name them. `refer: both "both" -> @3` makes the call `rows=@3`, not two `#n` the model has to guess.
- `target`: also carries attribute spans and new values ("over fifty dollars", "Dr Patel"). A value the message does not say but the context does is sourced there.
- `when`: a quote of the message's date phrase; `now`, the unstated default (from today on); or `earlier`, a date said in an earlier message or an earlier call's own date. ` = <date>` is the `when` argument in the compact form below.
- `pick`: after a listing that shows several rows, one verdict per candidate, `ok` or `no (<reason>)`, the reason one of kind, name, position, date, status, other.

A date is written key by key in the call's own order: `{"unit":"week","rel":1,"weekday":5}` is `week+1 wd5`, `{"date":"2026-03-27","time":"15:00"}` is `2026-03-27 t` (and `time: 15:00`), `{"from":{...},"to":{...}}` is `from ... to ...`, `{"unit":"day","rel":0,"anchor":"row"}` is `day+0 row`, `{"unit":"month","rel":0,"name":3}` is `month+0 m3`. Tokens: `<unit>[+-N]`, `[+-N]`, `wd<N>`, `m<N>`, `row`, `today`, `t`, `YYYY[-MM[-DD]]`.

## 3. The call is the trace's rendering

The compiler from a think to its call is ONE implementation, the runtime's (`crates/assist/src/native/think.rs`, `think::compile_think(think, dates, mode)`; the Python side calls it through `nativetools think`, `runtime_think.compile_think`, and keeps no compiler of its own). It returns `{"tool", "args"}` and is a pure function of the think text (and, for a `dates[i]`, of the prompt's `dates:` line). The tool is `via`, else the intent's own. The arguments come out in `CALL_ORDER`, the majority order of the authored calls (the arguments of a record are written in that order). The rows argument is the explicit `rows`/`row` slot, else the `ok` rows of `pick`, else the handles of a real `refer`, and only when no other handle slot (`linked_to`, `within`, `value`, `exclude`, `options`) is explicit.

- Data: (Section 9: `via` and the tool of a write name the regrouped tools; the round trip below is unchanged.) `derive_trace3` makes the text and refuses (reason `roundtrip`, or `tool`, `date-form`, `raw-arg`, `body-line`) a call whose compiled call is not the authored one. `build.py` reports the refusal and leaves the session out; it also calls `fmt.call_of_think`, the decoder's function, on every record; `derive_trace3` round-trips its own text through the same compiler (`runtime_think.compile_think`).
- Inference: `decode.Decoder` writes the call after `</think>` with `fmt.call_of_think`, one forced token at a time; a think that does not state a whole call leaves the call to the model (decoding is free, SPEC §9).
- Golden: `authored/golden_v3.json` holds one (think, call) per distinct call shape of the train data it was generated from (937 shapes); `crates/nativetools/tests/think.rs`, `authored/test_trace.py` and `train/test_trace3.py` compile each (the decoder renders each as the data does). Regenerate with `python3 authored/trace3_check.py golden DATA.jsonl.gz`.

## 4. The refer rule

`trace.refer_required(history)` is a pure function of the turn index and of whether an earlier turn showed a result (`has_prev_result`: a reply with rows or an `@k` in an earlier turn, not the vault block). It reads nothing from the words of the message.

- The first step of every turn that has a previous result carries a `refer:` line: `refer: it "that" -> @1` when the call names rows of an earlier turn, else `refer: none`. Short by construction: `none` has no phrase.
- The first turn of a session, and every turn while no earlier turn showed a result, has no `refer:` line.
- A later step of a turn has a `refer:` line when the call names rows of an earlier turn, none otherwise.

`derive_trace3` writes the line by this rule and refuses a session whose first step carries a `refer` with no previous result (reason `refer-rule`). Nothing enforces it at inference: decoding is free (SPEC §9, D-1044-18), so the model writes the line the data taught it.

A detector on the words of the message cannot decide it, because the label depends on the call, not on the words.

## 5. Decoding and training

- `fmt.THINK_LABELS` (`DEFAULT_LABELS`) are the slots whose values are decision tokens (`train.py --decision-weight`). A value of `intent` (its quoted phrase), `set`, `text` or `question` that appears verbatim in the user's message is a copy token instead (`fmt.CopyConfig`, `train.py --copy-weight`, default 0: no loss), in v3.1 and v4 thinks alike; a value that does not appear keeps its loss. The hard tier is the closed words and row numbers of `intent`, `scope`, `refer`, `when` and `pick`, with the call's rows, selector and date leaves (`fmt.HardConfig`).

## 6. Acceptance numbers

`authored/trace3_check.py report DATA.jsonl.gz` measures them. On the train data (the train worlds of `authored/split.json`, as `build.py` writes them; 3,869 sessions, 15,555 steps):

| Metric | Value |
| --- | --- |
| Round trip, compiled call == authored call | 15,555 / 15,555 = 100% |
| Arg-drop surface: steps with a call argument that has no slot | 0 / 15,555 = 0% |
| `refer:` rule: present on turns that have a previous result / absent on turns that have none | 8,192 / 8,192 and 4,112 / 4,112 (12,304 / 12,304 turns) |
| Think length, Qwen tokens per step | mean 35.14, max 111, p99 82 |

The model generates the think only; the call is written from it.

## 7. v3.1: picks, typed conditions, the compile step

Additive: a v3 think is read as before. The runtime's `compile` op ([`compile.rs`](../../../crates/assist/src/native/compile.rs); request `{"op":"compile","slots":{...}}`, reply `{call, stated, notes, normalized, resolved}` or `{refused:{slot,why}}`) turns the slots of a think into the call, so the model names its referents and the runtime resolves them. The model writes no vault id, no resolved date and no free `where` string. Issue [#1044](https://github.com/srikanth235/centraid/issues/1044), decision D-1044-11.

```
linked_to: #8                                  a row the prompt shows (a block `#n`, a row of the `focus:` line, an observation's row): its handle, as in v3
when:   "friday" = dates[1] past               the date is entry 1 of the `dates:` line; the reading (past | upcoming) only when the entry gives two
set:    to = ~dates[0] · name = Dentist        a date of an act's `args` as an entry of the dates line; other entries as in v3
where:  status = open · effort > 60            typed segments, one condition each, joined by ` · `, never a free string
retry:  where[1]                               first line, after the runtime refused the slot it names (`retry: rejected` stays for a rejected call)
```

- **Rows.** The handle slots (`rows`, `row`, `linked_to`, `within`, `exclude`, `value`, `options`) and the `pick` verdicts are sent to `compile` as picks of the block (`{"pick":{"row":"#n"}}`, a `@k` as is). The runtime refuses a handle the model cannot see now, naming the slot (`linked_to[0]`, `pick[1]`): the directory, the pre-grounded rows, the `focus:` line, the rows of the observations still shown. `pick` candidates are rows of the current block or of a reply, not of an earlier turn's block.
- **Dates.** A `when` or a date of `set` is written `dates[i]` when entry `i` of the turn's `dates:` line, read as the runtime reads it (`trace.reading_expr`: a day, a day with a clock, a range), is exactly that date expression. A date the line does not give as written stays in the compact form of section 2 with its `time:` markers: `week+1` is the same days as `2026-03-16..2026-03-22` but is not that expression, so it is typed. A clock alone (`at 3pm = 15:00`, or both readings of a bare hour, `at 3 = 15:00 (pm) / 03:00 (am)`) is not a date and is never picked. An entry of the conversation carries a source note after its date (`that day = 2027-02-08 (the eighth, turn 2)`, `before berlin = ..2027-03-11 (#30 event "Flight to Berlin")`); the pick is the date or range before the parenthesis. The model's `time:` line counts only the `t` markers of typed dates.
- **Where.** A condition is `field op value`, `field is empty`, `field is set`, `field contains "text"`, `field in ("a", "b")` or `link count op n`; op is one of `= != < <= > >=`. A value is a number, a closed word (`open`, `posted`, a bare enum), `yes` or `no` for a flag, a number with a unit (`35 BRL`, `1 hour`), or a quoted text. The runtime renders each condition in one spelling and checks it against the kind (`where[i]` names the one that fails); the call carries that spelling (`status = "open"`: a string is quoted, a flag and a number are bare), so a record's `where` is written in it.
- **Compiling.** `trace.slots_json(parse3(think))` is the request. The runtime's stateless compile (`runtime_think.compile_think(think, dates)`, `fmt.call_of_think(think, dates)`) renders the same call from the think and the prompt's `dates:` line with no session; it is the render path the session's answer replaces, and what a decoder without a session writes. It shares with the session's compile step (`compile.rs`) what both state (the order of the arguments, the date spellings, the kind a verb fixes, where a pick's rows go) and reads nothing a session would check against a world. A think with a `dates[i]` states no whole call without the line.
- **Inference.** `hf_backend` (`complete(prompt, compile=fn)`) sends the slots of the drawn think to `compile` and executes the `call` of the reply (after the grounding and the conventions). On a refusal it draws the step once more with `retry: <slot>` as the first line of the think (given as its prefix; the model continues), and compiles again. A second refusal, or a think that is no trace, leaves the first draw with the call the decoder wrote (`fmt.call_of_think`, else the model's own call). `last_info["compile"]` is `compiled`, `retry`, `fallback`, `retry-fallback` or `none`.
- **Slot values.** `WHERE` is typed segments; `WHEN`'s date is `dates[i]` (i below the number of entries the prompt's dates line has, none when it has none) or the compact form; `RETRY` takes `rejected` or a slot name (`where[1]`, `pick`).
- **Data.** `derive_trace3` writes the picks and the typed `where`; `build.py` replays every kept record against the runtime and sends the slots of each think (a repair call's excepted) to `compile`: the `stated` call must be the record's call, else the session is refused with `roundtrip`. Per world it reports, over the calls that are not repair calls, how many refer to something with every mention a pick (`anchored`), how many still type a name or a date (`free`), and how many refer to nothing (`none`). A mention is a row (`#n`, `@k`), a name the model types for the runtime to find (the `name` or `text` of a lookup or of a write that names no row) or a date.

## 8. v4: the model writes only what the harness cannot infer

A session passes only if every turn does, so each slot the model writes is a decision at a small model's error rate, and a slot the compile step can read off the rows, the verb or the result is a decision for nothing. v4 drops those slots and moves them to the compile step, which says what it inferred. v4 is the default trace: the data keeps the v3.1 text until it is regenerated, and the think of every record is rewritten as it is read for training (`fmt.records`); the same default selects the decoder's `call_of_think`. `NATIVE_TRACE=v3.1` keeps v3.1 everywhere (an older checkpoint's run). Issue [#1044](https://github.com/srikanth235/centraid/issues/1044).

```
retry: rejected | <slot>                       as in v3.1
intent: read|count|write|ask|decline "<phrase>"
via:   find|compute                            a lookup step; a write, count or read may also name its selector in the call itself (S2: search|open, section 9)
verb:  <verb>                                  writes
pick:  #n (<reason>)                           ONE row, and why it is the one: name | kind | date | focus | created | asked | nick
rows:  @n | #a, #b                             a result, or several rows (`row:` for `open`); never beside a pick
kind: op: field: group: trashed: name: text:   as in v3.1; `kind` only when no pick, no rows and the verb does not fix it; `name` only when no pick
where: when: linked_to: within: exclude: order: limit: more: set: time: value: options: question: reason:   as in v3.1
```

The slot order is `trace.SLOT_ORDER4`: the row decision (`pick`, `rows`, `row`) comes straight after `verb`. A `pick` line reads `pick: #31 (focus)`; the reason is one closed word, read from the context the model sees: `created` (the focus line says this session made the row), `asked` (the runtime asked about it: `focus: asked: ...`), `focus` (the focus line shows it: a set, `earlier:` or `acted`), for a row the message does not name; `name` for a row it names, `nick` when only the person's nickname is said, `date` and `kind` for the rest (`think.rs` `pick_reason`).

**Dropped.** `scope`, `refer` and `target` are not slots (`parse4` refuses them), and neither is the candidate list of a v3.1 `pick` (`#31 ok · #33 no (kind)`): the model names the one row. The `refer:` line the refer rule demanded on the first step of a turn with a previous result (section 4) is gone, and with it `fmt.requires_refer`. The Rust guard reads `intent` only from a v4 think: with no `scope` or `refer` line there is nothing for a call to contradict.

**Inferred** (the compile step, `compile.rs`; the stateless compiler, `think.rs`, renders the same call without a session). The runtime's reply carries `inferred: [...]` for a v4 trace (slots JSON `"trace": "v4"`):

| What | Inferred from | Rule |
| --- | --- | --- |
| the rows of the call | the `pick` row, else the `rows`/`row` slot | a pick states the rows beside any other handle slot (v3.1: only when none is explicit); a pick and a `rows` slot together are refused |
| `kind` of an act | its `verb` | a `name`, no `kind`, no handle slot, and a verb with one kind (`complete` and `reopen`: task, `cancel`: event, `log`: person, `reveal`: locker item) takes it; rule 4 of `normalize.rs` (a `target` with no pick) is this rule over the `name` |
| `scope` (reply only) | the rows or the selector | rows: `one` for one row, `all` for more; a selector: `all`, `one` under a single-row verb (`edit`, `reschedule`, `log`, `reveal`); none for `create`, `undo` and reads |
| `refer` (reply only) | the pick's reason, or a result handle | reason `focus`, `asked` or `created`, or a `@k` in the rows: `refer: it -> #n` for one row, `refer: that -> ...` for more |

`scope` and `refer` change no call: they are what the v3.1 trace had to state for the guard, now read off the call and recorded. `ground_name` still reads the trace's `scope` (the session's own, v3.1) and falls back to the message's "all" and "every" without one.

**One version per think.** `think::parse_any(text, mode)` (the compiler's; `trace.parse_any` reads the same text for the data side): a think with a construct of one version only (v3.1: `scope`, `refer`, `target`, `via: find`, a candidate pick; v4: a one-row pick) is that version whatever the mode, so data of both is readable and the old model's thinks still compile; any other think is read in the mode (`NATIVE_TRACE`, `trace.default_mode()`, default `v4`). The two versions differ only in what the compile step infers. A parsed v4 trace carries `v: 4` (`pick_reason`), `slots_json` sends it as `"trace": "v4"`, and the runtime reads no `trace` as v3.1.

**The converter and the round trip.** `think::v4_think(think, dates, context)` (the runtime's; Python: `runtime_think.v4_think(think, history, dates)`, which passes the conversation's minimal context: the turn's message, the `focus:` line and the rows the think names) rewrites a v3.1 think: the rows the v3.1 trace states (its `rows` slot, else the `ok` rows of the pick, else the handles of the refer) become a pick when they are one `#n` and a `rows` slot otherwise, and an act's `kind` goes when the verb fixes it. It then compiles both thinks and skips (`V4Skip`) unless the calls are the same, so a v4 think in the data always compiles to the v3.1 call. A lookup (`via: find`) converts like any other step; the 30 lookups of the first measure below were skipped when v4 had no lookup step (section 9 gives `find` back). `trace3_check.py v4 DATA` converts the first N turns of a built file, compiles both thinks with the stateless compiler and through the runtime's `compile` op over the session's own world (`stated` of the v4 think must be the record's call, `call` the v3.1 think's), and measures the tokens. `trace3_check.py golden4` adds `think4` to every row of `golden_v3.json` (the pick reason is the runtime's hint, there being no context; `golden` from data writes the real one).

**Decoding.** The v4 think is the v3.1 slots in the v4 order, with no `scope`, `refer` or `target`, `via` of `search|open|compute`, and `pick: #n (reason)`; `fmt.call_of_think` follows `fmt.trace_mode()`. `hf_backend` sends the slots of either version to `compile` (`parse_any`). Decision tokens: `THINK_LABELS` stand, the hard tier of the think is the row number of `pick` (`scope` and `refer` words are no longer there).

**Acceptance numbers to re-measure** on the regenerated train data (`trace3_check.py v4`, v4 being the default trace): the round trip (v4 think compiles to the v3.1 call: Python and runtime), the steps v4 does not say (lookups), think tokens and think decision tokens per turn. First measure, the first 500 turns (641 steps) of one built train world (T01, 156 sessions, 524 turns, built with `build.py T01 --gold-from-ref`, the authored sessions unrewritten):

| Metric | v3.1 | v4 |
| --- | --- | --- |
| Compiled call equal to the v3.1 think's, Python |  | 611 / 641 steps (30 lookups not said) |
| Same, the runtime's `compile` op (stated = the record's call, call = the v3.1 call) |  | 549 / 549 compared steps (repair steps excepted) |
| Slot lines per turn | 6.38 | 4.92 (-23%) |
| Think tokens per turn (Qwen) | 51.24 | 35.76 (-30.2%) |
| Think decision tokens per turn | 29.94 | 19.04 (-36.4%) |
| Think hard-tier tokens per turn | 6.15 | 1.76 (-71.4%) |
| Call decision tokens per turn | 13.57 | 13.57 |
| Trained tokens per turn | 121.34 | 105.85 (-12.8%) |

## 9. The tools regrouped ([#1166](https://github.com/srikanth235/centraid/issues/1166))

The runtime has eight tools: `find`, `compute`, `create`, `edit`, `do`, `answer`, `ask`, `decline` (`meta::TOOLS`). The model S2 and the data it was trained on (sections 1 to 8) use the first design. Nothing in sections 1 to 8 changes except the tool a call names:

| S2 wrote | Now | Through |
| --- | --- | --- |
| `search text kind?` | `find text kind?` | `via: search` compiles to it |
| `open row` | `find rows` (one `#n`) | `via: open` and the `row` slot compile to it |
| `find <selector>` | `find <selector>` | unchanged; `via: find` is valid in v4 again |
| `act verb=create` | `create kind args` | the tool of the verb; `verb` is not an argument |
| `act verb=edit` | `edit rows args` | as `create` |
| `act verb=<any other>` | `do verb rows args` | `do` takes at most one argument |
| `answer <selector>` (a read) | `find <selector>`, then `answer rows=@k` | two steps |
| `answer op field <selector>` (a count) | `compute op field <selector>`, then `answer value=@k` | two steps |
| `act` / `edit` / `do` by `name` and `kind` | `find`, then `edit` / `do rows=@k` (or a `pick` of a row the block shows) | two steps |
| `compute` | `compute` (`op` adds `avg` and `compare`; `group` adds `day` · `week` · `month` · `year`) |  |

`compute op=compare rows=@a,@b` sets two plain values already computed side by side and answers what separates them in each unit both hold (`@3 = +3 (compare @1 4 with @2 1)`). It takes no field, group or selector; a value per group, a result of rows and two values with no unit in common are refused. The difference is a value like any other: `answer value=@3` ends on it, and `within: @3` reaches the rows of both.

- **A by-name write is two steps.** The lookup is a think of its own: `intent: write`, `via: find` and the selector (`kind`, `name`, …); the `verb` slot is not stated there, and the step compiles to `find`. The next think states the verb and `pick:` the row, or `rows: @k` for the result: `do`/`edit` carry no selector. A write on an `@k` that a find by name left with several rows is held to the one safety check (SPEC §3.3), as the selector's was: the message saying all takes them all, a verb that leaves one row narrows to it, anything else is the composed `Which one?`. A `find` that matches nothing issues a handle too, so `answer rows=@k` ends a turn on "nothing".
- **Health is written in chat, for what the member did (#1166).** `workout` and `daily figure` are live kinds. `create workout` is `workout.log` (a title, `date`, and `moving`, `distance`, `energy`, `heart_rate`, `climb` in the kind's units); `edit` of a workout is `workout.edit`; `delete` and `restore` are the shared `entity.trash` and `entity.restore`; `edit` of a daily figure (`value`) is `measurement.log`. No verb was added. A workout the health store follows, and every figure while a health origin exists, is refused with the store's name before anything parks (`World::health_store`, `row.extra["followed_by"]`); the vault's preconditions are the authority and say the same words. `create daily figure` is `measurement.log` and `delete` is `measurement.clear`, the undo of a create: R-1129-3 "a day is never deleted" keeps its force for what a store states, and the owner's one exception is a figure the member logged, taken back only while no store is followed. `delete` of a figure is put back with the value it held, read from the vault to the digit. **S2's prompt does not advertise any of this:** its kind card lists no verbs for `workout` and `daily figure`, as it was trained (`prompt::kind_card_for`, pinned by `tests/fixtures/prompt.s2.pre-1166.txt`); the runtime still accepts such a call from S2.
- **Strict, and S2.** The shapes above are the default (`--tools sig`, `compact`, `full`). The runtime takes S2's shapes only under `--tools s2` (`Flags::tools`, `StepOptions::tools`, `compile_think_for`) and for a call in a name only S2 writes (`act`, `search`, `open`; `legacy::modernize`). In the default, `answer` takes `rows` or `value`, `edit` and `do` take `rows`, and any selector or `op` on them is an error naming the step before (`answer has no parameter "kind". … find first, then answer rows=@n`). `Session::compile` and `compile_think_for` agree: a read with no rows or value is `find`, with rows or a value `answer`; a count with an `op` is `compute`, with only a `value` it is `answer`; a write that states a selector (`kind`, `name`, `where`, …) is refused naming that slot. `compile_think` (no `for`) is S2's, which the golden and the Python tools read; `nativetools think` takes `"tools"` and defaults to S2's. The phone ships S2: `NativeChat::open` sets `Flags::tools` to `S2` and `StepOptions::default().tools` is `S2`; the retrained model flips both to `Sig`.
- **Compile.** `intent: write` with `verb: create` is `create`, `edit` is `edit`, any other verb `do`; a write with no verb slot is refused (`a write without a verb slot`). `think::compile_think` and `compile.rs` give the same call for either spelling of `via`. `CALL_ORDER` has no `row`: the row a `find` opens is `rows`, the `row` slot of S2 thinks being kept as an input spelling.
- **Verbs.** The catalog's live verbs are unchanged: `do` runs every verb but `create` and `edit` (`act::do_verbs`), which takes the issue's table: none (complete, reopen, cancel, delete, restore, star, unstar, archive, unarchive, unlink, undo), a date (`reschedule`), a row (`add_to`, `remove_from`), a label (`tag`, `untag`), a choice (`log`, `reveal`). No verb was added or removed.
- **S2.** `legacy::modernize` renames a call in S2's names as it enters `Session::step`; `--tools s2` (`prompt::ToolsMode::S2`) renders the tools block S2 learned. What S2 loses: nothing it was trained to do fails. What differs: its errors and `Send` repairs name the new tools, and `find` by text or row no longer passes through the selector repairs.
- **Golden.** `authored/golden_v3.json` (section 3) holds S2-era calls: `act`, `search`, `open`. The Rust test maps them through `legacy::modernize`; the Python tests that read it through `nativetools think` expect the old names and are retired with that pipeline.

## 10. The per-step grammar ([#1166](https://github.com/srikanth235/centraid/issues/1166))

`crates/assist/src/native/grammar.rs`. The model writes only the think (the call is compiled from it), so the grammar constrains the think. `StepOptions::grammar` is `Off` (the default: S2 and the phone), `Handles` or `Full`; `assist-step` takes `"grammar"` and `"tools"` in a request. The grammar is built fresh at each step from the catalog and the rendered prompt, sent as the think generation's `grammar` (never the call's), and ends with `</think>`. The engine makes a fresh context per generation, so the stages below are layers of one GBNF grammar, not three generations (each would prefill the prompt again).

**Handles** (the only mode S2 gets, and what `Full` becomes under `--tools s2`): free text, except that `#n` and `@k` must be a handle the prompt shows (every `#n` / `@k` in its text: the directory, `focus:`, the pre-grounded block, the observations, the calls already made) and `dates[i]` an entry of the turn's `dates:` line. A `#` or `@` followed by a digit, and a `dates[`, are the only things it constrains; a text that says `#5` where `#5` is not shown cannot be decoded.

**Full** (the regrouped tools; `--tools sig`), in stages:

1. **tool**: the `intent` line, `via` (`find` | `compute`), then `verb` (the catalog's). `retry: rejected` may lead; a given `retry: <slot>` prefix is not written again. A given prefix with any other slot is outside what the grammar can place and gets `Handles`.
2. **rows**: `pick` (`#n (reason)`), `rows`, `row` take visible handles only. A chosen verb is followed by a `kind:` line for a kind it applies to (`Verb::kinds`), or by none (a picked row fixes it; the tail is then over any field). With no verb, any kind, or a comma list of kinds.
3. **fields**: after `kind: K` only K's tail: `field`, `group`, `where` (K's fields, its date and its links), `order`, and `set` (K's create and edit fields, plus the verb arguments `to`, `from`, `label`, `choice`, `row`, `field`) name K's fields; `linked_to`, `within`, `exclude`, `value`, `options` take visible handles. Slots are in the v4 order, each at most once.

**Free text** is not constrained to the message (a grammar cannot say "a span of it", and the phrases of a trace are not verbatim). After decoding `StepInfo::unspanned` lists, as `slot: value`, the `intent` and `when` phrases, `name`, `text`, a `set` value of a text field and the `where` literals whose words are not, in order, in the user's message. It refuses nothing.

**Flat fields.** In the regrouped tools `create` and `edit` carry each field as a parameter of its own (`create kind=task name=Pay rent effort=30`, `edit rows=#4 effort=20`), after the parameters the tool takes. `compile_think_for` (any mode but S2) writes them so, and refuses a `set` key that is also a slot of the call; `Session::step` folds them into `args` (`legacy::fold_fields`) so the runtime is unchanged. `args` lines still run. S2 (`--tools s2`, `compile_think`) keeps `args`, and `meta::flat_field_names()` must not collide with `kind`, `rows`, `more`, `args`, `verb`, or with a selector parameter other than `name` (a test holds this). An `edit`'s `name` is a rename when `rows` is given; with none it is the by-name selector the tool refuses (`edit takes rows; find them first`).

**`nums[i]`** (regrouped tools only; `native/nums.rs`). The runtime reads the numbers out of the user message into a `nums:` line of the user block, between `dates:` and `picks:`, in the shape of the `dates:` line: `nums: fifty = 50 · 23.50 = 23.5` (the phrase, `=`, the value without separators or trailing zeros, entries joined by `·`, in the order the message says them). The line is there only when `Flags::tools` is not S2 and the message says a number (`Session::nums_line`); S2's prompt and blocks are unchanged.

- An entry is the number and nothing else: the unit stays in the trace (`where: amount > nums[0] USD`, `set: effort = nums[1]`). Read: digits with `,` and `.` separators, a `k` suffix (`5k` is 5000), the words `two`..`ninety-nine` (`twenty-five`, `twenty five`), `hundred` and `thousand` (`two hundred`). Not read: digits inside a date phrase of the same message (they belong to `dates[i]`), a clock time (`9:30`, `9pm`), an ordinal (`2nd`), a handle (`#12`, `@3`), an ISO date, digits that touch a letter (`A4`), and the pronoun `one`.
- The model writes `nums[i]` in a `where` condition or a non-date `set` value. `compile_think_with(think, dates, nums, mode, tools)` (`compile_think_for` is the same with `nums` `None`) replaces it before the condition is respelled; the session's `compile` does the same for a `value` string of a `where` condition or a `set` entry, from the message's own line. An index with no entry is refused naming the slot (`nums[2]`, `set[0]`). `limit` and bare digits stay literal; the grammar does not forbid digits in `where` and `set` (compact dates need them), which can be tightened once the data writes `nums[i]`.
- The grammar admits `nums[k]` only for k below the entry count (`Visible::nums`), and none without the line, in free text as in the structured slots; the free-text automaton tracks `dates[` and `nums[` together. `decode_step` reads the line from the prompt's last user block; `assist-step` needs no new field. `nativetools think` takes `"nums"`.

**Not done: the prompt does not show only the chosen kind's schema.** The kind is chosen inside the think, after the prompt is rendered; showing one kind's card needs a second render and prefill, and changes the prompt datagen trains on. The grammar needs no prompt change.
