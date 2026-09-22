# Decoder verification

Two questions about grammar-constrained decoding, run against `crates/evalsuite/grammar/check.py` itself. Reproduce with:

```
cd experiments/canon-model
HF_HOME=$PWD/hf ./.venv/bin/python -u verify_all.py --stage gold
HF_HOME=$PWD/hf ./.venv/bin/python -u verify_all.py --stage random --n-random 200
```

Box: 4 CPU cores, 15 GB RAM, no GPU. `google/flan-t5-small`, vocab 32107 after the seven grammar characters (`{ } < \ ~ ^ \``) are added.

## 1. The mask never blocks a gold token — PASSES

Every one of the **434** gold canonicals in `crates/evalsuite/grammar/map.json` is teacher-forced through `GrammarConstraint.allowed`, asserting at each position that the gold next token is in the allowed set, and that `</s>` is allowed at the end.

|                                 |            |
| ------------------------------- | ---------- |
| canonicals                      | 434 of 434 |
| token steps checked             | 8,505      |
| gold tokens blocked             | **0**      |
| `</s>` blocked at the end       | **0**      |
| not tokenizable without `<unk>` | **0**      |
| wall time                       | 182 s      |

This passed only after the fixes below. It did not pass on the code as found: the first run blocked 31 canonicals at position 0 — every one that opens with a `Cmd` (`reschedule{to: …}`, `tally.delete_expense{} …`), which SentencePiece spells with a leading blank piece.

## 2. A randomly initialised model emits 100% parseable strings — FAILS

`flan-t5-small`'s config with random weights, greedy, `max_new_tokens=48`, over 200 real member utterances (the `request` text of the mapped turns). Every generation is written to `raw_random_init.jsonl` before anything looks at it — raw decode, the emitted string, the finisher's output, and the parser's own error — and then fed to `check.parse`.

**61 of 200 parse: 30.5%.** The remaining 139 reach a state that no legal turn extends, so `</s>` is forced and the string is a fragment. The mask leaks.

The number moved as follows, each step a real defect fixed:

| mask | parse rate |
| --- | --- |
| as found | 5 / 200 (2.5%) |
| + blank-piece loop closed | 7 / 200 (3.5%) |
| + `step_char` agrees with `allowed_next` on free identifiers | 38 / 200 (19%) |
| + finisher rewritten (terminal search) | **61 / 200 (30.5%)** |

### Why it still leaks

`canon_grammar.viable` is deliberately conservative: its prefix parser answers "viable" whenever finite lookahead cannot decide. That is the right direction for question 1 — it is why no gold token is ever blocked — but it means the mask admits **heads that no legal turn extends**. A model with no opinion walks into one. The surviving failures are single structural words emitted as an entire output: `and` (11), `called` (7), `days` (4), `before` (3), `except` (2) — heads of length one from which nothing legal follows.

`decode.py`'s docstring claimed "the guarantee is total: any model, trained or not, emits a string that `check.py` parses". That claim is false and has been corrected in the file.

### The fix, and why it is not switched on

The exact fix is to check completability at every settle boundary: `GrammarConstraint.LOOKAHEAD`, already written, refuses any character that settles a terminal into a head with no completion. **Measured and turned off** (`LOOKAHEAD = 0`): at a bound of 3 terminals it did not finish 25 generations in eight minutes, against 97 s for all 200 without it. It costs a completion search per new head. Raising it needs a cheaper completability oracle — a precomputed fixpoint over heads, not a search per query.

## Defects found and fixed

1. **`decode.py` — blank-piece loop.** A piece decoding to whitespace only (`▁`) settles nothing when the current terminal is empty: the automaton returns the same state. Nothing stopped the model taking it 48 times in a row, which is what it did — every output in the first run was two or three characters followed by a wall of spaces. Now only the _repeat_ is blocked, because 31 golds need one.
2. **`canon_grammar.py` — `step_char` disagreed with `allowed_next`.** `allowed_next` admits the free-identifier witness only when a `:` may follow it (an argument name is the one place `check.py` takes an identifier it does not know). `step_char` used the weaker `viable_tokens(head + (token,))`, so the character automaton settled free identifiers where the terminal automaton never would, giving dead ends like `created_at of rac…`. Both now go through `_settle_ok`.
3. **`canon_grammar.shortest_completion` — unsound, and it could not complete a command.** It was a breadth-first search over characters with a 40,000-state cap. Its alphabet held no `{`, `}` or `<`, so no state inside a `Cmd` could ever be completed; and widening the alphabet only exposed the deeper problem, that the frontier is exhausted after three or four characters. It returned `None` — "no completion exists" — for `show (events du`, which one word finishes. Replaced with a search over terminals (`allowed_next`), depth in terminals rather than characters, with an explicit expansion budget. `show (events du` now completes.

None of these was worked around; each is a fix in the file that owned the bug.

## Caveat on the finisher

A string that runs out of budget mid-way is closed by `shortest_completion`, not by the model. Those completions are legal but arbitrary (`show (them that` → `( notes = 1 ) )`). `used_finisher` in `raw_random_init.jsonl` says which outputs are the model's and which are the finisher's. A parse rate is not an accuracy.
