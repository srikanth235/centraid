# `derive/` — the grammar's terminals, taken from the ontology

GRAMMAR.md §2 was written BY HAND from the ontology. A hand transcription can miss a construct the vault serves and can invent one it cannot, and neither failure shows up in a test: the corpus only exercises what somebody thought to write. These four scripts close that loop. Stdlib Python only — the derivation must run without a cargo build, or it becomes a second thing that can rot.

| file | what it does |
| --- | --- |
| `ddl.py` | a small reader for `contracts/schema/vault-ddl.sql`: columns, declared types, `CHECK (col IN (…))` value sets, foreign keys and their `ON DELETE` rules, primary keys. Reports; interprets nothing. |
| `commands.py` | the 148 `CommandDefinition`s, read out of `crates/vault/src/commands/*.rs` — name, input schema (inline, `const`, `macro_rules!` or `concat!`), gates and handler SQL. The registry has no machine-readable manifest, which is why this parses Rust. |
| `derive_grammar.py` | walks the ontology and writes `derived.json`: the terminal set the vault supports, with nothing in it a human chose. |
| `diff.py` | diffs `derived.json` against `check.py`'s lexicons — the grammar AS EXECUTED — and writes `../DIFF.md`. |
| `emit.py` | generates BOTH parsers' terminal tables from `derived.json` + `terminals.json`. |
| `terminals.json` | the naming layer: the only part of the terminals a human owns. |

**Roles.** Every registry entity declares a `role` — `thing`, `edge`, `revision`, `vocabulary` or `facet` — and the derivation reads it BEFORE any shape test. The shape test is now the CHECK: a declared `edge` or `revision` whose table carries no `(X_type, X_id)` pair fails the run, and so does a `thing` whose table anchors one to `core_entity`. What the check FINDS and does not fail on is the six unanchored pairs — an id nothing constrains to a row that exists — reported in `derived.json` under `unanchored` and in `DIFF.md` §R1, with a reading of each. Whether a given one is a receipt that must outlive its object or a pointer at a row that is gone is a product ruling; the DDL is not changed from here.

**Surfaces.** The doors serve 119 (entity, door) pairs and a member names 24 of them. Which ones is a PRODUCT decision, so it is declared — `surface` on every read scope in `crates/apps/*/manifest.json`, validated by `crates/apps/kit/src/manifest.rs` — and `derive_grammar.py` computes the DEFAULT each declaration is measured against: the role first (`edge` / `revision` / `vocabulary` → `internal`, `facet` → `facet`), then, for a `thing`, trashable / search domain / create target → `kind`, and a `kind` only at its home doors. An override carries a one-line `surfaceReason` or the derivation fails; seven scopes do, down from eleven, because the role declaration made four of them redundant and a redundant override is a lie about the rule. `emit.py` then holds the declaration and GRAMMAR.md §2.1 to each other BOTH ways, so neither can grow a Kind the other has not heard of. `DIFF.md` §S carries the split.

**Effects, and egress.** A command's effect is read off its handler's SQL, which is what makes the verb CLASSES derivable. Twenty-six handlers write through a helper or write nothing, so the SQL said nothing and derivability sat at 82%. Those twenty-six now DECLARE it in `DECLARED_EFFECTS` (`crates/vault/src/commands/mod.rs`) with a one-line reason each; where both the declaration and the SQL speak, the derivation holds them to each other and fails on a disagreement. Derivability is 100%. Egress — whether an effect leaves the vault — was previously reported as underivable and is now declared the same way in `DECLARED_EGRESS`, `none` included, with the derivation failing on any structural candidate (a sealed input, `online_only`, a name that states a transfer) that nobody has ruled on. `emit.py` generates the set into both parsers and `exec.rs` reads `canon::egress_verbs()`.

**Reader-computed Fields.** Declared per app under `derivedFields` in `crates/apps/*/manifest.json`: what computes the field, and the tables that reader reads. Manifest validation refuses an input the app's read scopes do not grant; `computedBy: null` plus a `gap` note is how a Field the product does not compute is STATED rather than discovered.

```
python3 derive_grammar.py && python3 diff.py && python3 emit.py
python3 emit.py --check          # what check.py runs on every pass
```

**What is derived and what is declared.** Structure is derived — which columns a Kind has, which foreign keys relate two boards, which commands exist, which effects group into a class. NAMES are declared in `terminals.json`, because the vault holds `core.event` and never "events", and so are the terminals of the CONVERSATION (`Ref`, the window phrases, the decline reasons), which are not the vault's to say. `emit.py` refuses a declared name the derivation does not hold.

**The productions are not generated.** A production is the shape of the meaning space and the ontology has nothing to say about it. Only terminals are generated — which is exactly the layer where `canon.rs` said "transcribed from `grammar/check.py`", and a transcription is the thing that drifts.

**What the derivation cannot reach** is reported rather than guessed: `derived.json` carries a `judgements` block (the `around` band, which no column declares itself an estimate for) and an `unanchored` block naming the polymorphic pairs the DDL holds to nothing. Those are product signal, not omissions. The `egress` block used to be a third: it said outright that egress was underivable and named what the registry would have to grow. The registry grew it, so that block now reports the declarations instead.
