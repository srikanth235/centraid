# #1115 — native-python is red: its worlds still hold Tally's debts and groups

[#1115](https://github.com/srikanth235/centraid/issues/1115), a follow-up to [#1099](https://github.com/srikanth235/centraid/issues/1099) (PR #1112 removed Tally from v0 and added the read-only `transaction` kind). The owner asked for the rewrite [R-1099-59](../docs/decisions.md#money-1099) deferred; [R-1099-85](../docs/decisions.md#money-1099) supersedes it. The experiment is `experiments/toolchat/native`.

## What changed

**What was red.** The `native-python` job at `40d96f5de` was reproduced step for step (below). One module of 29 was red: `train/test_trace3`, three tests of `RuntimeCompile`. They seed `crates/nativetools/tests/fixtures/world.json`, which #1112 cut from two groups to none, so the dentist the tests address moved from `#9` to `#7` in the vault block. The rest of the suite was green because nothing in it builds the data from the worlds: the data build itself was broken. `nativetools seed` ignored `groups`, `expenses` and `debts` without a word, so a world seeded as a household that never held them, and 1,388 sessions of 6,816 named a row, kind, verb or op the runtime no longer has.

**The three tests** (`experiments/toolchat/native/train/test_trace3.py`). Every line of the diff is the dentist's handle, which `nativetools session` now prints as `#7` (checked: `{"block":"vault: #7 event \"Dentist\""}`), plus one handle that stands for "a row the model was never shown" and keeps its meaning:

- `rows: #9` to `rows: #7` in the five `think` strings of `v31_compiles`, `pick: #9 (name)` and `pick: #9 (focus)` / `refer: it -> #9` in the v4 test, `rows: #9` in the `verb` refusal case, and `rows: #9`/`"#9"` in `good`: the dentist.
- `drawn = call(..., "#7")` to `"#8"` and `assertIn("<parameter=rows>\n#9\n")` to `#7`, `assertNotIn("#7")` to `assertNotIn("#8")`: the test draws a call whose written row differs from the think's and checks the runtime's wins. The drawn row must still be a different one, so it moved off the dentist's new number. Nothing else in the test changed.
- `#99` (a row that was never shown) is untouched in both places; a blanket substitution had turned it into `#79` and the second pass restored it. The owner approved this edit on 2026-10-15.

**The worlds.** The 35 builders in `authored/worlds/T*_build.py` no longer define `groups`, `expenses` or `debts` (nor the `group(...)` helper, the `DEBT_*` tables, the loops that filled them, their banners or the `check()` assertions about them). Every other section of every world is unchanged: the 35 rebuilt files equal the previous ones minus those three keys (checked, below). `artefacts.json` carries the new hashes (`artefacts.py rehash`), and `verify-rebuild --public-only` proves they rebuild byte for byte. The worlds gain no Money accounts or transactions: no authored session reads a transaction, and each row would renumber the vault block the model reads (R-1099-85).

**The seeder** (`crates/nativetools/src/seed.rs`). A top-level key that is none of the scalars and sections it reads is an error naming the key, so a stale builder fails at the seed. `today` stays allowed: the Python tools read it (T29 to T38 carry it, and the first run of the rule found it). Test: `a_section_the_seeder_does_not_read_is_an_error`. The same crate drops `vault_of` from `tests/phase9_nt9b.rs`, which no test calls since #1112.

**The sessions** (`authored/sessions/`). 1,416 of 6,816 sessions leave, with the 38 turns appended to them (`X(...)`) and 199 helper definitions only they used (`OWED = 'direction = "owes_me" ...'`, `TOP3 = find(kind="debt", ...)`):

- 1,388 name a removed row by key (in a reference call or in the gold), or a removed kind, verb or op (`debt`, `group`, `settle_up`, `settle_debt`, `balance`, `owes_me`, `i_owe`, `settle=`); the message and the tags are never read;
- 5 reach one through a helper;
- 23 verified before #1112 (the tree at `d8c0b99b4`, the old runtime and the old worlds) and no longer verify, 20 of them `trace unsourced`: a `where` value ("Ward 7", "Leeds Photo Co-op", `cadence >= 30 days`) that the vault block used to show through a group's name or a former parse, and three adds of a person "to it" that ended in a decline.

5,400 sessions remain. The build (`authored/build.py W --gold-from-ref`, 35 worlds) verified 5,283 of the 5,423 in the tree then; the 23 above were removed after it and the rest are unchanged. The old tree verified 6,654 of 6,816, so the share that builds is the same (97.6 % before, 97.8 % after); the 117 that do not build were failing before #1112 and are left as they were.

**The code** (`authored/*.py`, `authored/gen/*.py`, `eval/*.py`, `train/*.py`): the verb list, the `balance` op, the directory regex, the `settle_*` lexicons and intent cues, the `direction` and `settled` words, the person's-own-row guard of `noise.py` (`SENSE`, `me_hit`: the runtime dropped the rule), the `debt` and `group` kind tables of the drill generator, its `debt`, `group`-twin and `sum` drills (the only sum was over debts), the `balance_person` error family and its mutator, `settle` in `gold.py`, `lib.py` and `score.py`, the `debt-or-person` and `narrowed-balance` conventions and the `settle` bookkeeping of `regen.py`, `conventions.py`' balance sign, the hand corrections of ten held-out turns that named a debt or a group, `view_world.py`' balances, `fmt.py`' `direction` hard parameter (no tool has one). `fixture_world.py` holds two transactions instead of debts and groups; the tests that needed money use them.

**Tests removed with the machinery they tested (21 of 1,139):** `test_regen`: `test_settle_up_is_the_settlement_and_not_a_balance_change`, `test_a_balance_that_did_not_reach_zero_is_a_change_not_a_settlement`, `test_who_owes_me_has_the_people_of_the_debts_beside_the_debt_rows`, `test_two_debts_of_one_person_are_one_person`, `test_a_check_the_accept_carries_stays_with_the_people`, `test_the_people_of_the_debts_need_the_words_and_debt_rows`, `test_the_cues_of_the_debt_idiom`, `test_the_people_when_the_run_answers_the_debts_and_the_other_way_round`; `test_audit`: the eight `NarrowedBalance` tests, `test_the_next_fix_answers_the_members_of_the_group_the_call_is_linked_to`, `test_the_who_owes_fix_adds_the_debt_row_beside_the_person` and `test_the_number_fix_adds_the_ask_and_the_out_of_scope_decline_beside_the_balance` (they pin the removed hand corrections); `test_score`: `test_settle_up_balance_row`; `test_gen`: `test_balance`. No test of a convention or a family that still exists was removed or loosened; the ones that used a debt or a group as their data (`test_a_money_field_has_the_currency_of_the_vault`, `test_the_effect_names_the_refusal_and_the_verb_can_be_any`, the nickname chain, the drill evaluator's `where`, `sel_pair`, `tidy` and `follow_*` tests, `test_noise`'s world) run on a transaction, a folder refusal, a count and the other kinds, with the same assertions.

**Docs.** `SPEC.md`, `CONTRACT_V3.md` and `authored/BRIEF.md` describe the runtime's twelve kinds, its verbs and its ops (the `balance` op, the group directory line, the group's rows in `vault:` and `focus:`, the closing `(you)` row, `member_off_ledger` and `group_empty` leave). `HANDOFF.md` has the owner's hand-offs; `README.md` names `authored/untally.py`. `docs/decisions.md` carries R-1099-85 and the supersession marker on R-1099-59; `CHANGELOG.md` one line. `.github/workflows/gate.yml`'s comment on the job said 26 modules and two tolerated red tests; it is 29 and none.

**`authored/untally.py`** is the one-shot migration the owner runs on the held-out sources (on a copy of the old tree, from `d8c0b99b4`, it drops the same 1,393 sessions, 38 appended turns and 199 definitions; the tree then differs from that copy by the 23 sessions and a few banner comments above).

**Not done, and why (owner hand-offs, `HANDOFF.md`).** The data version stays `data-v7`. data-v8 is made by `artefacts.py version` from files that are on the Hub, and published with the token: the held-out world builders and sessions (T03, T12, T23, the eval worlds A to G), `eval/sets/*.jsonl` (val and test), the screen set and `data/train*.jsonl.gz` all still hold Tally. `collide.TARGETS` are measured on A to D and must be measured again on the rebuilt worlds (`verify-heldout` will say so). `authored/golden_v3.json` is not regenerated: it comes from the r1 corpus, 117 of its 871 shapes name Tally, and regenerating it from the corpus the tree builds today (1,136 shapes) would drop 144 older-form shapes that `think.rs` and `test_trace.py` use to prove the compiler still takes the older form. R-1099-82: nothing was trained or scored on the `transaction` kind.

## Verification

The job's own steps, on `40d96f5de` (before) and on this branch (after). `NATIVETOOLS=/home/user/target-npy/debug/nativetools`, `HF_HOME` the pinned tokenizer cache, `EVAL_VAULTS` a scratch directory, `GEN_INTEGRATION=1 NOISE_INTEGRATION=1`.

```sh
cargo build --locked -p centraid-nativetools --bin nativetools
uv venv --seed --python 3.11 VENV && python -m pip install --require-hashes --only-binary=:all: --no-deps -r requirements-ci.txt
hf download Qwen/Qwen3.5-0.8B --revision 2fc06364715b967f1860aea9cf38778875588b17 config.json tokenizer.json tokenizer_config.json vocab.json merges.txt chat_template.jinja
sha256sum -c SUMS
python artefacts.py fetch --public-only && python artefacts.py check --public-only
```

pass: the build finished, the pinned packages installed, the six files `OK`, `artefacts: 35 of 35 files match the manifest`.

```sh
python experiments/toolchat/native/run_cpu_tests.py --jobs 4        # before, at 40d96f5de
```

fail (exit 1): 29 modules, 1,139 tests, 0 skipped, 3 red, all in `train/test_trace3` (`RuntimeCompile`: `'refused': {'slot': 'rows[0]', 'why': '#9 is not in the block'}`); 25.2 min.

```sh
cd train && python -m unittest test_trace3
```

pass: `Ran 17 tests`, `OK`.

```sh
python experiments/toolchat/native/run_cpu_tests.py --jobs 4        # after
```

pass (exit 0): 29 modules, 1,118 tests, 0 skipped, 0 red; 36.8 min wall, 110.5 min of module time (the 21 fewer are the removed tests above; `GEN_INTEGRATION` and `NOISE_INTEGRATION` on, so the two integration suites ran).

```sh
python artefacts.py check --public-only && python artefacts.py verify-rebuild --public-only
```

pass: `35 of 35 files match the manifest`, `35 of 35 regenerable file(s) rebuild byte for byte`.

```sh
python - <<'E'
import glob, json, os
bad = 0
for f in sorted(glob.glob("OLDWORLDS/T*.json")):
    a, b = json.load(open(f)), json.load(open("authored/worlds/" + os.path.basename(f)))
    [a.pop(k, None) for k in ("groups", "expenses", "debts")]
    bad += a != b
print("differ:", bad)
E
```

pass: `differ: 0` (35 worlds; the other sections, the links and the order are equal).

```sh
python authored/build.py W --gold-from-ref   # the 35 worlds, tree at d8c0b99b4 (old runtime) and this tree
```

pass: old tree 6,654 of 6,816 verified; this tree 5,283 of 5,423 (23 more removed after, see above). No session of the tree names a removed row, kind, verb or op (the `untally.py` scan below).

```sh
python authored/untally.py sessions --worlds-dir OLDWORLDS --dry
```

pass: `would drop 0 session ids` on this tree; on a copy of the old one it dropped 1,393 session ids, 38 appended turns and 199 definitions.

```sh
cargo test --locked -p centraid-nativetools --all-features
cargo clippy --locked -p centraid-nativetools --all-targets --all-features -- -D warnings
cargo fmt -p centraid-nativetools -- --check
```

pass: 48 test binaries `ok`, none failed (the new `a_section_the_seeder_does_not_read_is_an_error` among them); clippy clean once `vault_of` is gone (an unused helper in `tests/phase9_nt9b.rs` that #1112 left when it removed the tests that called it); fmt clean. `cargo fmt --all -- --check` also flags `crates/core/tests/assist_door.rs`, which this change does not touch.

```sh
cargo xtask rules
bun run check:push:static
```

pass: every rule `ok`; `4/4 gates passed` (format:check, lint, turbo:lint, typecheck:affected).

## Audit

PENDING
