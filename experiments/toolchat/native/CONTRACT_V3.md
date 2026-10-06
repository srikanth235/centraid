# Contract v3: the slot trace

Status: current. The trace is the only think format: `authored/build.py` writes it, `train/fmt.py` and `train/decode.py` read it, and the current model is trained on it. Issue [#1044](https://github.com/srikanth235/centraid/issues/1044). Section 7 (v3.1) adds the picks, the typed `where` and the runtime's compile step; section 8 (v4) cuts the slots the model writes to the ones the harness cannot infer.

## 1. Why

A think that names only the intent, the verb, the scope and the rows leaves the call's arguments for the model to remember when it writes the call: the `kind` of a search, `exclude`, `order` and `limit`, `more: true`, the `time` of a date, a date written as ISO instead of `{unit,rel,name}`, `amount = 35 BRL` read as `limit: 35`. So the trace states every argument once, in a fixed order, and the call is the rendering of the think. The `refer:` line is decided by the turn, not by the words of the message (section 4), so the model has nothing to detect, only to say. The failure analysis behind both choices is in #1044.

## 2. Format

One `label: value` line per slot, in a fixed order; a slot that the call does not need is absent. The Rust guard reads the `intent`, `scope` and `refer` lines and ignores the rest (`refer: none` is a malformed refer to it, and is ignored).

```
retry: rejected                               only after a rejected call
intent: read|count|write|ask|decline "<deciding phrase>"
via:    find|search|open|compute              the tool, when it is not the intent's own (read, count -> answer; write -> act)
verb:   <verb>                                writes: create edit reschedule complete reopen cancel delete restore star unstar add_to remove_from log settle_up settle_debt reveal undo
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
- `intent`: what the call is for; the quote is the deciding phrase. A lookup (`find`, `search`, `open`) carries the intent of the call it prepares, read off the turn's own next call. When an `ask` or a `decline` follows, the message alone decides.
- `scope`: written on an `act` that names existing rows, not on `create` or `undo`. One row is `one`. More than `ROW_CAP` (12) rows is `all`. A qualifier such as "except the padel one" is `some`.
- `refer`: written when the call names rows an earlier turn showed and the message does not name them. `refer: both "both" -> @3` makes the call `rows=@3`, not two `#n` the model has to guess.
- `target`: also carries attribute spans and new values ("over fifty dollars", "Dr Patel"). A value the message does not say but the context does is sourced there.
- `when`: a quote of the message's date phrase; `now`, the unstated default (from today on); or `earlier`, a date said in an earlier message or an earlier call's own date. ` = <date>` is the `when` argument in the compact form below.
- `pick`: after a listing that shows several rows, one verdict per candidate, `ok` or `no (<reason>)`, the reason one of kind, name, position, date, status, other.

A date is written key by key in the call's own order: `{"unit":"week","rel":1,"weekday":5}` is `week+1 wd5`, `{"date":"2026-03-27","time":"15:00"}` is `2026-03-27 t` (and `time: 15:00`), `{"from":{...},"to":{...}}` is `from ... to ...`, `{"unit":"day","rel":0,"anchor":"row"}` is `day+0 row`, `{"unit":"month","rel":0,"name":3}` is `month+0 m3`. Tokens: `<unit>[+-N]`, `[+-N]`, `wd<N>`, `m<N>`, `row`, `today`, `t`, `YYYY[-MM[-DD]]`.

## 3. The call is the trace's rendering

`trace.compile_call(think) -> {"tool", "args"}` is a pure function of the think text. The tool is `via`, else the intent's own. The arguments come out in `CALL_ORDER`, the majority order of the authored calls (the arguments of a record are written in that order). The rows argument is the explicit `rows`/`row` slot, else the `ok` rows of `pick`, else the handles of a real `refer`, and only when no other handle slot (`linked_to`, `within`, `value`, `exclude`, `options`) is explicit.

- Data: `derive_trace3` makes the text and refuses (reason `roundtrip`, or `tool`, `date-form`, `raw-arg`, `body-line`) a call whose compiled call is not the authored one. `build.py` reports the refusal and leaves the session out; it also calls `fmt.call_of_think`, the decoder's function, on every record.
- Inference: `decode.Decoder` writes the call after `</think>` with `fmt.call_of_think`, token by token under the grammar; a think that does not state a whole call leaves the call to the grammar.
- Golden: `authored/golden_v3.json` holds one (think, call) per distinct call shape of the train data it was generated from (937 shapes); `authored/test_trace.py` compiles each, `train/test_trace3.py` checks the decoder renders each as the data does. Regenerate with `python3 authored/trace3_check.py golden DATA.jsonl.gz`.

## 4. The refer rule

`trace.refer_required(history)` is a pure function of the turn index and of whether an earlier turn showed a result (`has_prev_result`: a reply with rows or an `@k` in an earlier turn, not the vault block). It reads nothing from the words of the message.

- The first step of every turn that has a previous result carries a `refer:` line: `refer: it "that" -> @1` when the call names rows of an earlier turn, else `refer: none`. Short by construction: `none` has no phrase.
- The first turn of a session, and every turn while no earlier turn showed a result, has no `refer:` line.
- A later step of a turn has a `refer:` line when the call names rows of an earlier turn, none otherwise (it is optional in the grammar).

`derive_trace3` writes the line by this rule and refuses a session whose first step carries a `refer` with no previous result (reason `refer-rule`). The think grammar (`decode.Grammar.specialise(..., require_refer=True)`) demands the line at inference. `Decoder.step` and `Decoder.complete` pass `fmt.requires_refer(msgs)` (or `requires_refer_in_prompt`), the same function, over the same records, as the data.

A detector on the words of the message cannot decide it, because the label depends on the call, not on the words.

## 5. Decoding and training

- Grammar: the think is one terminal per slot line, in order, `intent` mandatory, `refer` mandatory when `refer_required` holds; quoted spans are at most 120 characters, raw lines at most 300, lists bounded, so a rambling value cannot run into `think_limit`.
- `fmt.THINK_LABELS` (`DEFAULT_LABELS`) are the slots whose values are decision tokens (`train.py --decision-weight`). A value of `intent` (its quoted phrase), `set`, `text` or `question` that appears verbatim in the user's message is a copy token instead (`fmt.CopyConfig`, `train.py --copy-weight`, default 0: no loss), in v3.1 and v4 thinks alike; a value that does not appear keeps its loss. The hard tier is the closed words and row numbers of `intent`, `scope`, `refer`, `when` and `pick`, with the call's rows, selector and date leaves (`fmt.HardConfig`).
- The exported `call.lark` is stricter than the runtime, and the authored sessions write what the runtime reads: `status = "open"` (the export: bare after `=` and `!=`, quoted only inside `in (...)`), `effort > 60 minutes` (the export: a number, optionally a currency code), and a month's `rel` before its `name`. `decode.Grammar` takes those spellings (`relax_where`, `DATE_KEY_ORDER`); the exported file is not edited. What the grammar still refuses (0.52% of the train steps) is call-side: `effort > 1 hour`, `cadence > 2 weeks` (the runtime refuses them too, "a number of minutes (60, not 1 hour)"; most are `bad` repair steps) and a few malformed dates.
- The think rules are checked apart from the call (`decode.py check` prints "think ... accepted"), and the call is written token by token whatever the grammar says of it (a rejected token only sets `grammar_error` and ends the masking), so the call-side refusals do not reach the output.

## 6. Acceptance numbers

`authored/trace3_check.py report DATA.jsonl.gz` and `train/decode.py check DATA.jsonl.gz --lark call.lark` measure them. On the train data (the train worlds of `authored/split.json`, as `build.py` writes them; 3,869 sessions, 15,555 steps):

| Metric | Value |
| --- | --- |
| Round trip, compiled call == authored call | 15,555 / 15,555 = 100% |
| Arg-drop surface: steps with a call argument that has no slot | 0 / 15,555 = 0% |
| `refer:` rule: present on turns that have a previous result / absent on turns that have none | 8,192 / 8,192 and 4,112 / 4,112 (12,304 / 12,304 turns) |
| Think accepted by the think grammar, with the step's refer rule | 15,555 / 15,555 = 100% |
| Whole message (think + call) accepted by the call grammar | 15,474 / 15,555 = 99.48% (15,473 with the handles restricted to the addressable ones) |
| Think length, Qwen tokens per step | mean 35.14, max 111, p99 82 |

The model generates the think only; the call is written from it.

## 7. v3.1: picks, typed conditions, the compile step

Additive: a v3 think is read as before. The runtime's `compile` op ([`compile.rs`](../../../crates/nativetools/src/compile.rs); request `{"op":"compile","slots":{...}}`, reply `{call, stated, notes, normalized, resolved}` or `{refused:{slot,why}}`) turns the slots of a think into the call, so the model names its referents and the runtime resolves them. The model writes no vault id, no resolved date and no free `where` string. Issue [#1044](https://github.com/srikanth235/centraid/issues/1044), decision D-1044-11.

```
linked_to: #8                                  a row the prompt shows (a block `#n`, a row of the `focus:` line, an observation's row): its handle, as in v3
when:   "friday" = dates[1] past               the date is entry 1 of the `dates:` line; the reading (past | upcoming) only when the entry gives two
set:    to = ~dates[0] · name = Dentist        a date of an act's `args` as an entry of the dates line; other entries as in v3
where:  status = open · effort > 60            typed segments, one condition each, joined by ` · `, never a free string
retry:  where[1]                               first line, after the runtime refused the slot it names (`retry: rejected` stays for a rejected call)
```

- **Rows.** The handle slots (`rows`, `row`, `linked_to`, `within`, `exclude`, `value`, `options`) and the `pick` verdicts are sent to `compile` as picks of the block (`{"pick":{"row":"#n"}}`, a `@k` as is). The runtime refuses a handle the model cannot see now, naming the slot (`linked_to[0]`, `pick[1]`): the directory, the pre-grounded rows, the `focus:` line, the rows of the observations still shown. `pick` candidates are rows of the current block or of a reply, not of an earlier turn's block.
- **Dates.** A `when` or a date of `set` is written `dates[i]` when entry `i` of the turn's `dates:` line, read as the runtime reads it (`trace.reading_expr`: a day, a day with a clock, a range), is exactly that date expression. A date the line does not give as written stays in the compact form of section 2 with its `time:` markers: `week+1` is the same days as `2026-03-16..2026-03-22` but is not that expression, so it is typed. A clock alone (`at 3pm = 15:00`, or both readings of a bare hour, `at 3 = 15:00 (pm) / 03:00 (am)`) is not a date and is never picked. An entry of the conversation carries a source note after its date (`that day = 2027-02-08 (the eighth, turn 2)`, `before berlin = ..2027-03-11 (#30 event "Flight to Berlin")`); the pick is the date or range before the parenthesis. The model's `time:` line counts only the `t` markers of typed dates.
- **Where.** A condition is `field op value`, `field is empty`, `field is set`, `field contains "text"`, `field in ("a", "b")` or `link count op n`; op is one of `= != < <= > >=`. A value is a number, a closed word (`open`, `owes_me`, a bare enum), `yes` or `no` for a flag, a number with a unit (`35 BRL`, `1 hour`), or a quoted text. The runtime renders each condition in one spelling and checks it against the kind (`where[i]` names the one that fails); the call carries that spelling (`status = "open"`: a string is quoted, a flag and a number are bare), so a record's `where` is written in it.
- **Compiling.** `trace.slots_json(parse3(think))` is the request. `trace.compile_call(think, dates)` renders the same call in Python from the think and the prompt's `dates:` line (`fmt.call_of_think(think, dates)`); it is the render path the runtime's answer replaces, and what a decoder without a session writes. A think with a `dates[i]` states no whole call without the line.
- **Inference.** `hf_backend` (`complete(prompt, compile=fn)`) sends the slots of the drawn think to `compile` and executes the `call` of the reply (after the grounding and the conventions). On a refusal it draws the step once more with `retry: <slot>` as the first line of the think (the grammar consumes it, the model continues), and compiles again. A second refusal, or a think that is no trace, leaves the first draw with the call the decoder wrote (`fmt.call_of_think`, else the call grammar). `last_info["compile"]` is `compiled`, `retry`, `fallback`, `retry-fallback` or `none`; `NATIVE_DECODING` is unchanged.
- **Grammar.** `decode.THINK3_LINES`: `WHERE` is typed segments; `WHEN`'s date is `dates[i]` (i below the number of entries the prompt's dates line has, none when it has none) or the compact form; `RETRY` takes `rejected` or a slot name (`where[1]`, `pick`). `Grammar.specialise(..., n_dates=)` carries the count.
- **Data.** `derive_trace3` writes the picks and the typed `where`; `build.py` replays every kept record against the runtime and sends the slots of each think (a repair call's excepted) to `compile`: the `stated` call must be the record's call, else the session is refused with `roundtrip`. Per world it reports, over the calls that are not repair calls, how many refer to something with every mention a pick (`anchored`), how many still type a name or a date (`free`), and how many refer to nothing (`none`). A mention is a row (`#n`, `@k`), a name the model types for the runtime to find (the `name` or `text` of a lookup or of a write that names no row) or a date.

## 8. v4: the model writes only what the harness cannot infer

A session passes only if every turn does, so each slot the model writes is a decision at a small model's error rate, and a slot the compile step can read off the rows, the verb or the result is a decision for nothing. v4 drops those slots and moves them to the compile step, which says what it inferred. v4 is the default trace: the data keeps the v3.1 text until it is regenerated, and the think of every record is rewritten as it is read for training (`fmt.records`); the same default selects the grammar, the refer rule and `call_of_think` of the decoder. `NATIVE_TRACE=v3.1` keeps v3.1 everywhere (an older checkpoint's run). Issue [#1044](https://github.com/srikanth235/centraid/issues/1044).

```
retry: rejected | <slot>                       as in v3.1
intent: read|count|write|ask|decline "<phrase>"
via:   search|open|compute                     `find` is gone: a write, count or read that names a selector is looked up by the call itself
verb:  <verb>                                  writes
pick:  #n (<reason>)                           ONE row, and why it is the one: name | kind | date | focus | created | asked | nick
rows:  @n | #a, #b                             a result, or several rows (`row:` for `open`); never beside a pick
kind: op: field: group: trashed: name: text:   as in v3.1; `kind` only when no pick, no rows and the verb does not fix it; `name` only when no pick
where: when: linked_to: within: exclude: order: limit: more: set: time: value: options: question: reason:   as in v3.1
```

The slot order is `trace.SLOT_ORDER4`: the row decision (`pick`, `rows`, `row`) comes straight after `verb`. A `pick` line reads `pick: #31 (focus)`; the reason is one closed word, read from the context the model sees: `created` (the focus line says this session made the row), `asked` (the runtime asked about it: `focus: asked: ...`), `focus` (the focus line shows it: a set, `earlier:` or `acted`), for a row the message does not name; `name` for a row it names, `nick` when only the person's nickname is said, `date` and `kind` for the rest (`trace.pick_reason`).

**Dropped.** `scope`, `refer` and `target` are not slots (`parse4` refuses them), and neither is the candidate list of a v3.1 `pick` (`#31 ok · #33 no (kind)`): the model names the one row. The `refer:` line the refer rule demanded on the first step of a turn with a previous result (section 4) is gone, and with it `fmt.requires_refer`. The Rust guard reads `intent` only from a v4 think: with no `scope` or `refer` line there is nothing for a call to contradict.

**Inferred** (the compile step, `compile.rs`; `trace.compile_call` renders the same call without a session). The runtime's reply carries `inferred: [...]` for a v4 trace (slots JSON `"trace": "v4"`):

| What | Inferred from | Rule |
| --- | --- | --- |
| the rows of the call | the `pick` row, else the `rows`/`row` slot | a pick states the rows beside any other handle slot (v3.1: only when none is explicit); a pick and a `rows` slot together are refused |
| `kind` of an act | its `verb` | a `name`, no `kind`, no handle slot, and a verb with one kind (`complete` and `reopen`: task, `cancel`: event, `log` and `settle_up`: person, `settle_debt`: debt, `reveal`: locker item) takes it; rule 4 of `normalize.rs` (a `target` with no pick) is this rule over the `name` |
| `scope` (reply only) | the rows or the selector | rows: `one` for one row, `all` for more; a selector: `all`, `one` under a single-row verb (`edit`, `reschedule`, `log`, `reveal`, `settle_up`, `settle_debt`); none for `create`, `undo` and reads |
| `refer` (reply only) | the pick's reason, or a result handle | reason `focus`, `asked` or `created`, or a `@k` in the rows: `refer: it -> #n` for one row, `refer: that -> ...` for more |

`scope` and `refer` change no call: they are what the v3.1 trace had to state for the guard, now read off the call and recorded. `ground_name` still reads the trace's `scope` (the session's own, v3.1) and falls back to the message's "all" and "every" without one.

**One version per think.** `trace.parse_any(text, mode)`: a think with a construct of one version only (v3.1: `scope`, `refer`, `target`, `via: find`, a candidate pick; v4: a one-row pick) is that version whatever the mode, so data of both is readable and the old model's thinks still compile; any other think is read in the mode (`NATIVE_TRACE`, `trace.default_mode()`, default `v4`). The two versions differ only in what the compile step infers. A parsed v4 trace carries `v: 4` (`pick_reason`), `slots_json` sends it as `"trace": "v4"`, and the runtime reads no `trace` as v3.1.

**The converter and the round trip.** `trace.v4_think(think, history, dates)` rewrites a v3.1 think: the rows the v3.1 trace states (its `rows` slot, else the `ok` rows of the pick, else the handles of the refer) become a pick when they are one `#n` and a `rows` slot otherwise, and an act's `kind` goes when the verb fixes it. It then compiles both thinks and raises `V4Skip` unless the calls are the same, so a v4 think in the data always compiles to the v3.1 call. A lookup (`via: find`, 4.7% of the steps measured below) has no v4 form: v4 has no lookup step, and the step keeps its v3.1 think until the sessions that use it are regenerated with the selector in the call itself. `trace3_check.py v4 DATA` converts the first N turns of a built file, compiles both thinks in Python and through the runtime's `compile` op over the session's own world (`stated` of the v4 think must be the record's call, `call` the v3.1 think's), and measures the tokens. `trace3_check.py golden4` adds `think4` to every row of `golden_v3.json` (the pick reason is `trace.reason_hint`, there being no context; `golden` from data writes the real one).

**Decoding.** `decode.THINK4_LINES` is the grammar of the think: the v3.1 terminals in the v4 order, with no `SCOPE`, `REFER` or `TARGET`, `via` of `search|open|compute`, and `pick: #n (reason)`; `Grammar.specialise(..., trace=)`, `decode.think_rules`, the llama backend and `fmt.call_of_think` follow `fmt.trace_mode()`. `hf_backend` sends the slots of either version to `compile` (`parse_any`). Decision tokens: `THINK_LABELS` stand, the hard tier of the think is the row number of `pick` (`scope` and `refer` words are no longer there).

**Acceptance numbers to re-measure** on the regenerated train data (`trace3_check.py v4`, `decode.py check`, v4 being the default trace): the round trip (v4 think compiles to the v3.1 call: Python and runtime), the steps v4 does not say (lookups), think tokens and think decision tokens per turn, the share of v4 thinks the think grammar accepts. First measure, the first 500 turns (641 steps) of one built train world (T01, 156 sessions, 524 turns, built with `build.py T01 --gold-from-ref`, the authored sessions unrewritten):

| Metric | v3.1 | v4 |
| --- | --- | --- |
| Compiled call equal to the v3.1 think's, Python | | 611 / 641 steps (30 lookups not said) |
| Same, the runtime's `compile` op (stated = the record's call, call = the v3.1 call) | | 549 / 549 compared steps (repair steps excepted) |
| Slot lines per turn | 6.38 | 4.92 (-23%) |
| Think tokens per turn (Qwen) | 51.24 | 35.76 (-30.2%) |
| Think decision tokens per turn | 29.94 | 19.04 (-36.4%) |
| Think hard-tier tokens per turn | 6.15 | 1.76 (-71.4%) |
| Call decision tokens per turn | 13.57 | 13.57 |
| Trained tokens per turn | 121.34 | 105.85 (-12.8%) |
| Think accepted by the grammar of its version, whole world (670 steps) | 669 (the refer rule demanded on 356) | 638 (the other 32: 31 lookups, which stay v3.1, and 1 the v3.1 grammar refuses too) |

