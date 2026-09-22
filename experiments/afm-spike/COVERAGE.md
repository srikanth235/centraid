# The frame's coverage of the canonical grammar

**Headline: 434/434 (100.0%) of the gold turns, and 7 287/7 287 (100.0%) of the distinct canonicals in `experiments/canon-model/data/train.jsonl`, survive `gold -> frame -> wire -> canonical` tree-equal. `frame.py`'s wire frame imposes no ceiling.**

**That headline is about `frame.py`, and `frame.py` is not what the Apple model fills.** The schema the on-device model is given is [`Sources/afm-spike/Frame.swift`](Sources/afm-spike/Frame.swift), and it is narrower: it can carry **329/434 (75.8%)** of the same gold wire frames. An Apple run is therefore bounded above by 329/434 before the model reads a single sentence — and that is itself an upper bound, because it assumes Stage A always names the right head and the right kind. [§ What Frame.swift cannot carry](#what-frameswift-cannot-carry) has the number by cause and how to reproduce it. Nothing in this file has been changed to close the gap; the gap is a decision, not a bug to fix in passing.

The 434/434 sentence is still the reason this file exists. The encoder lane ([ENCODER.md](../canon-model/ENCODER.md) §1) reached a legal, fast parser that could never have scored above **65.7%** on this corpus, because its template head was a flat classifier over the 1 200 whole SHAPES the generator happened to produce: a corpus turn whose shape was not in the inventory was unreachable no matter how well the model read the sentence. A spike whose ceiling is below the floor it is being measured against cannot produce a result, only a number. So the first thing built here was the ceiling, in Python, before a line of Swift.

Reproduce:

```
python3 frame.py
```

```
gold, frame only              434/434   100.0%
gold, through the wire        434/434   100.0%
train.jsonl (distinct)       7287/7287  100.0%
```

**Uncovered gold turns: none.** There is no list below because the list is empty.

## What is being proved, exactly

`frame.py` runs the identity the harness depends on, over every gold canonical in `crates/evalsuite/grammar/map.json`:

```
check.parse(gold)  ==  check.parse(render(decode(unflatten(flatten(encode(check.parse(gold)))))))
```

Three properties matter about that chain, and each is the answer to a way the proof could be hollow:

1. **It is TREE equality, not string equality.** The grammar admits redundant parentheses, so a string comparison would report failures that are not failures — and, worse, would pass a renderer that had memorised the corpus's spelling. `check.py` is the same parser that generated every `tree` in `map.json`, so the comparison is against the grammar itself.
2. **It goes through the WIRE shape.** `to_flat`/`from_flat` are the flat JSON object a `DynamicGenerationSchema` can describe — the thing the model actually fills. Proving the rich frame alone would have measured a surface the model never sees. The two lines above are reported separately for exactly that reason.
3. **Nothing is repaired.** `decode` raises on a frame it cannot build, and `to_canonical` re-parses its own output before returning it. A failure is counted as a failure.

`train.jsonl` is included as an adversarial set, not as a target: it is a generator's output, 7 287 distinct canonicals whose postfix orders the corpus never uses (`during` outside a filter, `called` after a link walk). It found two real gaps in the first ladder and is what the second ladder's extra slots answer.

## The frame

Two layers, because the model and the grammar want different shapes.

**The frame** is what code composes. It is recursive where the grammar is recursive and flat where the grammar is flat:

```
Frame  { head, agg, field, set, set2, cmds[], reason }
Set    { source: kind|ref|union|except, kind, ref, n, left, right, steps[] }
Step   { op: walk|called|that|during|ordered_by|first, ... }
Pred   { op: and|or|none, atoms[] }
Atom   { type: cmp|contains|is|pwindow|member|band|oneof|countwalk, ... }
```

The load-bearing idea is `steps`: a `Set` is a source plus an ORDERED LIST of postfix operations, which is exactly what `check.py`'s own `set_postfix` loop consumes. That is why there is no shape ceiling — the list is a list, not a class.

**The wire frame** is what the model fills. A `DynamicGenerationSchema` the on-device model can hold in a 4 096-token context cannot be a recursive tree, so the step list is unrolled into a fixed ladder of named slots:

```
called · filtersA · during · walk1 · called2 · filtersB · during2 · walk2
       · filtersC · orderBy · limit        then  combineOp + combineRight
```

The ladder's ORDER is the corpus's own postfix order, read off every gold Set shape rather than chosen. The 28 distinct gold `show` shapes decompose into it without a collision; `train.jsonl`'s wider orders are what forced `called2`, `during2` and `filtersC`.

## Why this is not the encoder lane's mistake again

|  | encoder lane (Tier A) | this frame |
| --- | --- | --- |
| how a shape is chosen | one class out of 1 200 templates seen in training | a source plus a list of steps, each chosen independently |
| a shape nobody has seen | **unreachable** | expressible, as long as its pieces are in the ladder |
| gold turns reachable | 285/434 (65.7%) | **434/434 (100%)** |
| where the vocabularies come from | `lexicon.py`, generated | `lexicon.py` + `derive/derived.json`, generated (`gen_vocab.py`) |

The second row is the difference. Both designs make an illegal command name or an invented field impossible by construction; only one of them can say a sentence it has not seen the shape of before.

## What Frame.swift cannot carry

`frame.py` is the frame. `Frame.swift` is the SCHEMA THE MODEL IS GIVEN, and the two are not the same object. Reproduce the gap:

```
python3 ../qwen-sanity/swift_ceiling.py
```

```
Frame.swift can express   329/434   75.8%   (frame.py wire frame: 434/434)
```

The script reads `Frame.swift`'s `ObjectSpec`s as predicates over each gold `to_flat` object and attributes every loss. A turn can hit several causes:

| cause | turns lost |
| --- | --- |
| a field that is not in the kind's narrowed field list | 37 |
| an `Arg.name` that is not in the registry's arg list for that kind (`to`, `by`, `since`) | 32 |
| a window whose value is an exact date: `Frame.swift` offers a `literal` slot, `frame._window_decode` reads `value` | 16 |
| `Arg.valueKind` lacks `set`/`field`/`daterange`/`value` | 12 |
| `Arg` has no `set` slot | 12 |
| `Atom` has no `set` slot | 7 |
| `Atom.valueKind` lacks `duration`/`daterange`/`field`/`set`/`value` | 7 |
| `Window` has no `anchored` how | 5 |
| `Atom` has no `member` type | 2 |
| `Atom` has no `lits` slot | 1 |

Three of those rows say more than their count does.

**The largest is the per-kind FIELD narrowing, and it is unsound rather than merely tight.** `Frame.swift` narrows `fields` to the kind Stage A named and then hands the same list to `filtersB`, whose own guidance says "Conditions on the rows AFTER walk1" — after a link walk has changed the board underneath it. The narrowing is correct for `filtersA` and wrong for everything past the first walk. (The same trap catches a single-stage schema harder still: one recursive `#/$defs/set` rule is reused at every depth, so `experiments/qwen-sanity/mkschema.py` carries the full 172-field enum and proves 434/434 against gold. That is a real design difference between the two lanes, not a stylistic one.)

**The window `literal` slot is a wiring mistake, not a narrowing.** `Frame.swift`'s `Window` offers `value` as `anyOf(Vocab.windowPhrases)` and puts an exact date, date-time, month or range in a separate `literal` slot. `frame._window_decode` requires `value` for `how` ∈ `date`/`datetime`/`month`/`daterange` and never reads `literal`. Every dated window the model produces comes back `unrenderable`, and `render_frames.py` books it as a model failure when it is a harness failure. 16 gold turns sit behind it.

**`called2`, `window2` and `filtersC` cost nothing here.** `Frame.swift`'s header comment lists all three in its `set` ladder and its `ObjectSpec(name: "Set")` has none of them, which reads like a hole — but no gold turn needs them. They exist for `train.jsonl`'s wider postfix orders (§ The frame), so the omission narrows the schema against the generator's corpus and not against this one.

## What the coverage number does NOT say

It says `frame.py` can EXPRESS every gold turn. It says nothing about whether the model will FILL it correctly — that is what `run-model` measures, against the Tier D floor of 53/120 · 34/60 · 31/78 strict sessions, and it is the only number that counts as a result.

Two narrowings sit between the frame and the model. Both were written as honest reductions; only the second is one, and the section above is why:

- **Stage A picks the kind, and Stage B only carries that kind's fields.** A wrong kind in Stage A costs the turn even though the frame could have expressed it. That is a model error, and `summarise.py` counts it by kind. But the field list is also wrong past a link walk, independently of anything Stage A does, and that is a schema error the model is charged for — 37 gold turns.
- **`gen_vocab.py` narrows the per-kind verb list** to the commands whose registry subject is that kind's entity, plus the five verb classes, plus every command the registry gives no subject at all (a creator such as `schedule.add_task` names the row it is about to mint, so the derivation cannot attribute it and the harness must not hide it). Twenty-three of the twenty-five kinds end up with 37–60 verbs instead of 153. This one is clean: no gold turn loses a verb to it.

## The verbatim-literal rule, and the measurement behind it

`crates/evalsuite/DEFECTS.md` #35: a content-bearing write argument must be words the member actually said. `render_frames.py` enforces it, and a literal that fails is `fabricated_literal` with an empty canonical — never a repair.

The rule's SHAPE was measured against gold rather than assumed:

| rule | gold literals it rejects |
| --- | --- |
| whole phrase, case-insensitive substring of the request | 105 of all string literals; 4 of the content-bearing write args |
| **words ≥ 3 chars, minus stopwords, over the session so far** | **0** |

A member says "the cabin" and the row is called `Cabin check-in`; a member says "print that parking note" three turns after naming Emerald Bay. Both are legitimate, and a substring rule calls both fabrication. The word rule over the session's own history keeps what the rule is for — a title the model composed out of nothing is still rejected — and stops it firing on the paraphrase the grammar exists to perform.

## Selftest

`make selftest` stands gold frames in for the model's, writes the exact JSONL the Swift harness writes, and runs the whole Python side over it:

```
wrote 434 synthetic frames -> out/_selftest.raw.jsonl
rendered 434/434 (100.0%) -> out/_selftest-gold.jsonl
selftest: 434/434 tree-equal to gold
```

It then runs `run-model` over the result, which must reproduce the oracle. A red there after a real run is therefore a finding about the MODEL, and never about this code.
