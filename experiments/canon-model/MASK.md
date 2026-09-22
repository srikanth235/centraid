# The compiled mask

Lane E measured the grammar-constrained decoder from both ends and found one defect wearing two faces (VERIFY.md): the mask LEAKED — a randomly initialised model emitted a string `check.py` parses only **30.5%** of the time — and it was SLOW, ~1.5 s/turn, fifteen times the unconstrained model. Both are the same thing. `canon_grammar.viable` is an INTERPRETED prefix parser: it answers by running `check.Parser` in prefix mode, once per candidate character, per decoding step, and a recursive-descent parser with finite lookahead has to answer "still viable" whenever it cannot yet decide. So the mask is a superset of the legal prefixes — it admits heads no legal turn extends, and an opinionless model walks into one — and every step is a parse rather than a lookup.

This replaces it with a COMPILED mask.

## Approach, and why this one

Two routes were on the table: write the grammar as an EBNF and hand it to llguidance or outlines-core (i), or hand-compile the grammar to a character DFA at bounded depth and precompute a token bitmask per DFA state (ii).

**(i), llguidance.** The brief's argument for (ii) is that bounded nesting makes the language regular. It does, but the bound is the reason, and llguidance does not need it: its core is an Earley recognizer with a token-level lexer, which handles the context-free grammar directly, at the depth `check.py` actually allows — and `check.py` enforces no depth bound at all, so a DFA built to GRAMMAR.md's bound of 4 would have been NARROWER than the oracle it is checked against. The leak closes for a better reason under (i) as well: an Earley recognizer keeps the set of live items and admits a token only if some item survives it, and an item survives only if what has been read can still be completed. Completability is the algorithm, not a lookahead budget, so there is no `LOOKAHEAD` knob to price. It also expresses what (ii) would have had to special-case: the quoted literal and the free identifier (`ARGNAME`) are regular terminals in the lexer, not holes in a character DFA. The costs of (i) are real and are paid below — llguidance's regex engine has no lookahead, and its HF tokenizer bridge refuses T5 — but they are bounded, local and verifiable, where (ii) is a second implementation of the grammar with no oracle but itself.

The files:

| file | what it is |
| --- | --- |
| `canon_lark.py` | the grammar as Lark/EBNF. Terminals read LIVE from `grammar/lexicon.py`; productions transcribed from `check.Parser`. |
| `llg_mask.py` | the mask: tokenizer bridge, `LLGConstraint`, the HF `LogitsProcessor`, and the close-out search. |
| `llg_verify.py` | the two correctness measurements. |
| `llg_bench.py` | the latency measurement, with the idleness gate. |

**The transcription is the risk, and it is checked both ways.** GRAMMAR.md says productions stay hand-written in each implementation and only terminals are generated; a hand-written production can be wrong in either direction. Narrower shows up in the gold sweep (§1); wider shows up as a generation the mask admitted and `check.parse` rejected (§2). §2 found one, and it is fixed in `canon_lark.py`, not worked around — see §4.

## 1. Gold-token sweep — PASSES

```
cd experiments/canon-model
HF_HOME=$PWD/hf ./.venv/bin/python -u llg_verify.py --stage gold
```

All 434 gold canonicals from `crates/evalsuite/grammar/map.json` teacher-forced through the mask, asserting at every position that the gold next token is admitted, and that `</s>` is admitted at the end.

|                                 | old mask (VERIFY.md) | compiled mask  |
| ------------------------------- | -------------------- | -------------- |
| canonicals                      | 434 of 434           | **434 of 434** |
| token steps checked             | 8,505                | **8,505**      |
| gold tokens blocked             | 0                    | **0**          |
| `</s>` blocked at the end       | 0                    | **0**          |
| not tokenizable without `<unk>` | 0                    | **0**          |
| wall time                       | 182 s (idle box)     | **4.5 s**      |

Same 8,505 steps over the same 8,505 prefixes, so the two sweeps are the same sweep and the times are comparable. Re-run side by side under one box state in §3: **217.1 s against 4.5 s**.

## 2. Random-init parse rate

```
HF_HOME=$PWD/hf ./.venv/bin/python -u llg_verify.py --stage random --n-random 500
```

`flan-t5-small`'s config with RANDOM weights, greedy, `max_new_tokens=48`, over 500 real member utterances (the `request` text of the mapped turns). Every generation is written to `raw_random_init_llg.jsonl` BEFORE anything looks at it — the emitted string, the final string, whether the close-out search was used, and the parser's own error — and then fed to `check.parse`.

| mask                            | parse rate             |
| ------------------------------- | ---------------------- |
| old, as found (VERIFY.md)       | 5 / 200 (2.5%)         |
| old, after Lane E's three fixes | 61 / 200 (30.5%)       |
| **compiled**                    | **500 / 500 (100.0%)** |

0 unparseable, 0 stranded ("no legal completion"), 447 of the 500 closed by the close-out search (§5). 558 s for the 500, on a contended box.

**The leak is closed.** Lane E's residual failure modes — `and` (11), `called` (7), `days` (4), `before` (3), `except` (2), each emitted as an entire output because the mask let the model settle a head nothing extends — do not occur and cannot: `and`, `called` and `except` are infix, so no Earley item is live at the start of a turn holding one.

## 3. Latency — turn latency NOT MEASURED; the mask itself is 48x

**Turn latency is NOT MEASURED, and the reason is the box.** The TRAINING lane has held the four cores since 05:29 (`train.py`, 227-300% CPU) with `cargo test` beside it; load average sat between 6 and 8 for the whole window. `llg_bench.py` refuses to time on that, by design:

```
HF_HOME=$PWD/hf ./.venv/bin/python -u llg_bench.py --n 50
{"latency": "NOT MEASURED", "reason": "box never idle: load 7.78, ..."}
```

Forced through anyway (`--allow-contended`, `bench_llg_contended.json`) the numbers are visibly not numbers — unconstrained greedy comes out at **p50 6.1 s**, sixty times its real figure, and lands BELOW the constrained decoder on p50 because the unconstrained model never stops and spends all 48 tokens while the constrained one is finished sooner. That row is kept in the repo as evidence of the box state and is not a latency. **Re-run `llg_bench.py --n 50` with no flags once the training lane is done**; it gates itself and will produce the p50/p95 triple.

What CAN be compared without an idle box is the mask itself, because both implementations can be made to do the same work: the gold sweep is exactly 8,505 mask computations over exactly the same 8,505 prefixes. Both were run in the same window, under the same load (6.0-6.8):

|  | old mask | compiled mask |
| --- | --- | --- |
| mask computations | 8,505 | 8,505 |
| wall time | **217.1 s** | **4.5 s** |
| per step | 25.5 ms | **0.53 ms** |
|  | `verify_all.py --stage gold` | `llg_verify.py --stage gold` |

**48x on the mask**, and that understates it: 0.53 ms is the COLD figure, one fresh matcher per canonical. Warm, stepping a single decode, the `LogitsProcessor` costs 0.09 ms per token — the Earley row is cached and the step is a mask fill plus a bit-unpack, not a parse. Lane E's ~1.5 s/turn was the old mask at 25.5 ms x ~50 characters-worth of candidate walks per token; removing 216 of the sweep's 217 seconds removes essentially all of the decoder-side cost, and what is left for the idle re-run to measure is the model's own forward pass.

## 4. What the two-way check found

### A defect in `check.py`: `int()` where a `ParseError` belongs

`first N of Set`, `count of Kind Cmp N` and `next N days` are the three places `check.Parser` calls `int()` on the number it lexed. Its `number` terminal is `-?\d+(\.\d+)?`, so `first 1956.00 of (it)` reaches `int("1956.00")` and raises **ValueError, not ParseError**. Three of the five failures in the first 500-generation run were exactly that:

```
first 1956.0025020012502001250200125020012502001250159 of it
   ValueError: invalid literal for int() with base 10: '1956.00250...'
```

This was invisible to the old mask, whose `canon_grammar.complete` catches `ValueError` alongside `ParseError` and reads it as "not a whole turn" — the crash was being absorbed by the very function that decides whether a generation is legal.

Not worked around: a limit, a count and a horizon are integers in GRAMMAR.md §1, so `canon_lark.py` now says so with an `INT` terminal and the decoder cannot walk into the crash. **The fix in `check.py` is still owed**: it should raise `ParseError` on a non-integral count rather than let `ValueError` out, because any other caller (the Rust `canon.rs` round trip, `validate-suite`) reaches the same line. Not made here — `check.py` is the gate's parser and this lane does not commit.

### The whitespace rule, which llguidance cannot express as a terminal

`check.py` lexes with one regex and skips whitespace, so it needs a separator only between two lexemes that would otherwise merge — two idents, or an ident and a digit. That is a negative lookahead (`\b`, `(?!...)`), and llguidance's regex engine has none; without it the mask happily emits `last_contacted_atoffirst5`, which `check.py` reads back as a single identifier. So the separator is explicit in `canon_lark.py`: a WORDY lexeme carries a mandatory leading space, everything else an optional one.

That is measured against the corpus, not guessed. Over all 434 golds, zero-width adjacency happens only after `(` (714 times) and `{` (71), never anywhere else, and no canonical holds a double space or a tab. The `_b` ("bare") rule variants are the duplicates those two brackets need. The grammar is therefore NARROWER than `check.py`'s in whitespace alone, which is what the gold sweep in §1 exists to prove harmless.

### `no_forcing`

llguidance's fast-forward optimisation returns, for a state whose next bytes the grammar forces, a mask computed PAST those bytes — the client is meant to take them as `ff_tokens` rather than sample. We sample every token through HF `generate`, so a forced state reported the gold token blocked: `show (event` + `s` came back with a one-token mask holding `t`, and 418 of the 434 golds "failed". A decoder/API mismatch, not a grammar defect; `%llguidance {"no_forcing": true}` is the switch.

### The T5 bridge

`llguidance.hf.from_tokenizer` refuses this tokenizer outright — _can't determine decoder type: Metaspace_. The vocabulary is handed over directly instead, one byte string per id, with SentencePiece's `▁` spelled as the space it stands for: the same mapping `decode.piece_text` uses, so the mask and the text the decoder assembles cannot disagree.

## 5. The close-out, and what a parse rate is not

A generation that spends its 48 tokens without reaching a whole turn leaves a legal PREFIX. The recognizer guarantees a completion exists from any state it admitted, so `LLGConstraint.complete` searches for a short one: a best-first walk over matcher copies, ranked so that a closer is cheapest, an opener dearest and a lexeme continuation in between. Each of those three rankings was forced by a case that failed without it — counting digits forever after `first 904.11`, and a beam that spent its whole depth on `( ( ( ( ( (`. The search escalates through three widths and each rung has a wall-clock budget; when all three give up, the row says so and is counted as a FAILURE, never as a parse.

**A parse rate is not an accuracy.** `used_finisher` in `raw_random_init_llg.jsonl` says which outputs are the model's and which the search's, and from a randomly initialised model almost all of them are the search's. What §2 measures is that the mask cannot strand a model outside the language — nothing about whether the canonical means anything.

## 6. The drop-in

`decode.generate_canonicals(model, tok, inputs, ...) -> list[str]` is the interface the training lane scores checkpoints through. It takes a model, its tokenizer and the input strings and returns one canonical per input; `UNPARSED` appears only where the close-out gave up, and is never quietly replaced by something that merely parses. `decode.constrained_generate` keeps its old signature and now runs the compiled mask, EXCEPT when handed a `GrammarConstraint` — Lane E's `verify_all.py` passes one, and it has to keep running for the two rows of §2 to stay comparable. `train.py` is untouched.
