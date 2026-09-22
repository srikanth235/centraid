# `centraid-candidates`

Candidate runtimes for the assistant eval harness in [`crates/evalsuite`](../evalsuite/README.md). Everything here is scored through that crate's own interface — `Candidate`, `CandidateRuntime`, `Plan`, `Context` — and reaches the vault through no other door. **There is no SQL in this crate**, and the executor holds no session ids, no corpus and no per-turn table.

## What is in it

| module | what it is |
| --- | --- |
| [`canon`](src/canon.rs) | the canonical grammar of [`GRAMMAR.md`](../evalsuite/grammar/GRAMMAR.md) as Rust types, with a parser from the canonical string and a serializer back. The lexicons are transcribed from `grammar/check.py`, which derives them from the ontology. |
| [`exec`](src/exec.rs) | the **executor**: a canonical tree + the session's `State` + a `&mut Context` becomes a `Plan`. Every §4 rule is implemented and named where it fires. |
| [`oracle`](src/oracle.rs) | `OracleCanonical` — the executor's **ceiling test**. |

## The oracle is a ceiling, not a candidate

`OracleCanonical` is handed the GOLD canonical for the turn out of `grammar/map.json`. Its score answers one question: _if the paraphrase step were perfect, how much of the corpus could this executor execute through the doors that exist?_ It sees the session id only to look the canonical up, and nothing downstream of that lookup knows which corpus is running. A real candidate replaces the lookup with a parser and changes nothing else.

```text
cargo run -p centraid-candidates --bin run-oracle -- --corpus suite|blind|holdout
cargo run -p centraid-candidates --bin dump-board -- <app|all|search:entity=query>
```

`run-oracle` prints the standard report, the cost columns, the **round trips per turn** (recursion compiles to a sequence of door reads, so the door-call count is what the grammar's depth bound is a budget on) and a per-turn failure list with the canonical beside each failure.

## `JoinedRules` — the first shipping-shaped candidate

[`joined`](src/joined.rs) is the oracle with its one cheat removed. Same executor, same `State`, same doors; the `map.json` lookup is replaced by [`parse::Parser`](src/parse/), so nothing in the loop has ever seen the answer key. An `Unparsed` becomes `Plan::Declined { reason: "clarify" }` — an honest _I did not understand_, which the harness scores as a FAILURE everywhere except a genuine clarify turn, and that is the behaviour we want.

```text
cargo run -p centraid-candidates --bin run-joined -- --corpus suite|blind|holdout|all
cargo run -p centraid-candidates --bin run-joined -- --registers
```

Every turn's RAW CANONICAL STRING is written to `joined-<corpus>.jsonl` (`$JOINED_LOG_DIR`, default `.`) **as the run happens and before anything parses it** — the brief's save-the-raw-output rule applies to a rules parser exactly as to a model, and a string that crashes the next stage is the most interesting one there is. The verdict is joined onto each row afterwards.

**Measured 2026-09-21** — floor is the strongest degenerate instrument in `run-nulls`, ceiling is `run-oracle` (the same executor, handed the gold):

| corpus  | floor        | joined                           | ceiling         |
| ------- | ------------ | -------------------------------- | --------------- |
| suite   | 5/120 (4.2%) | **53/120 (44.2%)**, graded 60.1% | 114/120 (95.0%) |
| blind   | 4/60 (6.7%)  | **34/60 (56.7%)**, graded 59.8%  | 60/60 (100%)    |
| holdout | 0/78         | **31/78 (39.7%)**, graded 44.3%  | 73/78 (93.6%)   |

The 349 `registers.json` variants, each lifted out of its conversation and run as its own SINGLE-TURN session — the first candidate ever scored on them: **126/349 strict (36.1%)**, graded 38.2%; `elliptical` 13.5% is a floor rather than an estimate, because its whole premise is a noun that lives in a previous turn and here there is none.

### The write verbs are a table, not a pile of rules

Every write the parser recognises comes from ONE place: [`parse/lexicon.json`](src/parse/lexicon.json)'s `write_verbs`. Each row names a typed command out of `crates/vault/src/commands/*` (or one of GRAMMAR.md 2.7's two verb CLASSES), states the ACT that command performs in a `sense` field, and lists the English verbs that name that act. **The surfaces were written from the sense, not from any corpus sentence** — the corpora were read only to learn which senses were unreachable, never to learn what words to match. `needs` is an any-of guard for a surface too generic to stand alone (`add` is a task, a note, an expense, an album entry or a group member until a second word says which), `bars` rules a row out, and `question_ok` lets a row fire behind an interrogative opener, which only a disclosure request legitimately is. `rules.rs` holds one CONSTRUCTOR per row and no second place where a surface form is spelled.

A write that names no set of its own takes the one the session is holding, and the `Ref` follows GRAMMAR.md 3's number convention: the member's own pronoun when they used one, else `it` for a single held row and `them` for several. `ParseState::held_rows` is how the parser learns the count — fed back by [`joined`](src/joined.rs) from the plan the runtime itself just answered, never from the gold.

Parse-only (`run-parse`, no vault, no executor), exact + skeleton: suite **58.9%**, blind **55.6%**, holdout **43.9%**, registers **47.9%**; 0 illegal canonicals on all four.

### The stage attribution is the point

A pass rate says how much is broken, not which half to fix. Every failing turn is filed against a stage by comparing the raw canonical to `map.json`'s gold — read only, after the run, by `run-joined` and never by the candidate — with `scorecheck.py` as the same authority `run-parse` uses:

| stage                            | suite | blind | holdout |
| -------------------------------- | ----- | ----- | ------- |
| correct                          | 132   | 43    | 43      |
| parse-unparsed                   | 4     | 0     | 0       |
| parse-wrong-skeleton             | 85    | 24    | 58      |
| parse-wrong-literal              | 15    | 4     | 10      |
| join-rejected                    | 0     | 0     | 0       |
| exec-failed-on-correct-canonical | 12    | 1     | 3       |
| uncovered                        | 0     | 0     | 0       |

`join-rejected` is zero on all three: every string the rules lane renders, the `canon` parser reads. The seam holds. The executor's own share ROSE as the parser improved — 8 to 12 on the suite, 0 to 1 and 0 to 3 on the other two — because the write turns it now reaches are turns the parser used to hand it as a board read. `s29.1`, `b43.1` and `h53.1` are each a correct canonical the executor declines, and they are the executor lane's first three.

### Tests

[`tests/joined_ratchet.rs`](tests/joined_ratchet.rs) — a strict-session ratchet per corpus (53 / 34 / 31) and on the registers (126/349), plus the property that every turn across all three corpora and all 349 variants returns one of the four `Plan` shapes with a decline reason from the executor's own vocabulary. Nothing panics on 783 turns of member text.

## Tests

- `every_canonical_round_trips` — `parse(serialize(parse(c))) == parse(c)` for all 430 covered canonicals in `map.json`.
- three **ratchets**, one per corpus, asserting the oracle's session pass rate is at least what it was when the executor landed. They are slow (a private world per session). Lowering one is a regression to be argued for, never edited away.
