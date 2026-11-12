# Handoff: the native tool task after the Python data tooling was retired (#1044, #1171)

The state on 2026-11-05, written for the next coding agent.

- Evidence and numbers: [#1044](https://github.com/srikanth235/centraid/issues/1044) (S2), [#1171](https://github.com/srikanth235/centraid/issues/1171) (datagen M3 to M7, and the retirement).
- How the task works (data, layout, the loop): [`README.md`](README.md).
- The runtime contract: [`SPEC.md`](SPEC.md). The slot trace: [`CONTRACT_V3.md`](CONTRACT_V3.md).

## What changed in #1171

The Python data tooling is gone: `authored/` (worlds, the ~450 session recipes, the generators, `build.py`, `gate.py`, `dist.py`, `coverage.py`, `park_oracle.py`), `render.py`, `runtime_think.py`, and `eval/` (`run.py`, `score.py`, `build_sets.py`, `regen.py`, `rollout.py`, the replay and the rest), with the `native-python` CI job. It is in git history, at the commit before the one that retired it.

- **The data**: `cargo run -p centraid-datagen -- build --version vN` is the only way to make a data version (`crates/datagen/README.md`). The records carry their rendered token ids and loss weights.
- **The eval**: `crates/assist-eval` scores a set and cuts rollouts, RFT records and DPO pairs (`crates/assist-eval/README.md`). It reads data-v7's val set and worlds from `data/v7/`, which `artefacts.py fetch` fills.
- **The trainer**: `train/train.py` reads datagen's records only. The legacy format (`messages`, the v3.1 slot trace, decision, hard and copy tokens) is no longer read, so **a data-v7 training file cannot be trained on any more**; it is kept for reference. DPO reads `{id, chosen, rejected}` pairs of datagen records, which is what `assist-eval rollout-records` writes.
- **The GCP VM** (`train/vm/`) only trains. Its scoring half (the python eval driver on a VM) went with the eval; score a checkpoint with `train/to_gguf.py` and `assist-eval`, or on Kaggle (`train/kaggle/`).
- **Gone with it, not replaced**: the proof that a parked write shows what a run shows over the authored sessions (`park_oracle.py`, R-1088-6; `crates/nativetools/tests/park.rs` still holds every `(verb, kind)` of the table to a real vault), the held-out checks of `artefacts.py verify-heldout`, the Tally migration helper (`untally.py`), and the plan for a v8 test set (test world-disjoint from val).
- `crates/nativetools/tests/golden_v3.json` (871 call shapes, 117 of them naming a debt or a group) stays as the compiler's regression set. `nativetools think` still serves the `render`, `render_many` and `call_text` ops the Python renderer used; nothing calls them now.

## Where it stands

| model | what | val sessions (655) |
| --- | --- | --- |
| **S2 (current best)** | soup of r3a + i2a + r2 ckpt-100, a third each (`train/soup.py`) | **537 (82.0 %)** live on nt12 / v7.3; 541 rescored on v7.4; **542 by replay on nt15 / v7.4** (a lower bound, see below) |
| S1 | r3a + i2a, half each | 534 live (nt12); 530 by replay on nt15 |
| i2a | p7-i2e4, average of ckpt-075 and ckpt-100 | 502 live (nt12) |
| r3a | p7-r3, average of ckpt-075 and ckpt-100 | 491 (nt12) |

- **Runtime: nt15** is the crate `crates/nativetools` at this commit: 889 tests, `tests/phase9_nt14.rs` and `tests/phase9_nt15.rs`.
  - It adds ruling 1, N1 to N6, N9, R1 to R5 and N1b (D-1044-16).
  - The S2 replay on nt15 loses 11 sessions, and all of them are renumbering artefacts. nt15's new vault lines shift `#n` handles, which the recorded model text still points at. It gains 14 turns for real.
  - **No model has been scored live on nt15.** nt15 also adds `body+` to the system prompt's `act` line, which S2 never trained on. The live score is the first thing to measure (step 1).
- **Val v7.4** (`data/v7/val.jsonl`, sha256 `5d3d9035…`) is the nt15 refreeze. 128 accepts were added and none removed; lineage and hashes are in `data/v7/FROZEN.md`.
  - **Test is not refrozen or scored on the phase-7 runtime** (owner deferred).
- 82 % is a val number: every fix, ruling and soup choice was derived on val. Expect test lower until it is scored.
- **The branch is on main** (`f5487678`, #1080) **plus #1078's on-device chat** (the `ios-app-simulator-aaef2f` branch), merged 2026-10-07. Main wins every overlap; the record is on #1044.
  - `crates/nativetools` is ported to main's APIs. Harness worlds seal Locker cells under a fixed `HARNESS_LOCKER_KEY` (`crates/nativetools/src/vaultio.rs`) and name the generation through `Vault::locker_generation`, because the phone derives `K` from the 24 words.
  - Decoding is free and the grammar path is gone (D-1044-18, 2026-10-07): no `hard`/`soft` modes, no Lark exports, no llguidance, no llama.cpp arm. `free` was the only arm of the Python rig (the phone and `assist-eval` now decode under the `full` grammar: `native_turn::phone_options()`, #1188), and `NATIVE_DECODING`, `NATIVE_LARK`, `NATIVE_SOFT_THRESHOLD` and `NATIVE_HANDLES` are refused. Free decoding was shown token-identical before and after the cut on the base model (CPU), and val v7.4 refreezes byte-identical on the cut runtime.
  - Everything S2 does not depend on is gone from the branch (2026-10-07, D-1044-17): the canonical-English harness (`crates/evalsuite`, `crates/evalworld`, `crates/candidates`, `experiments/canon-model`, the `joined-*.jsonl` corpora and its manifest, registry and command declarations), the earlier toolchat rounds `v2` to `v8` and their scripts, and the `afm-spike`, `frontier-probe`, `qwen-mobile` and `qwen-sanity` experiments. They remain in history (`69d89575f` and earlier); #1044 lists them.
  - Val v7.4 refreezes byte-identical on the merged runtime.
  - #1078's product assistant (`crates/assist`, `crates/assist-llama`, `crates/core/src/assist`) is a separate, read-only tool registry of 18 `<app>.<verb>` reads over llama.cpp. Wiring this task's model and its 8 tools into it is integration work that has not started.

## Next steps

Per #1171, in order: M6 (the three SFT arms on Kaggle, scored with `assist-eval` against the S2 baseline; the Kaggle eval kit first, which has never been run), then M7 (rollouts and a second RFT/DPO round). Each paid step needs the owner's go. S2's GGUF is public: `srikanth235/centraid-native-gguf@s2-q4_0`.

## Open owner questions (none applied)

1. A bare perfect tense ("how many times has tobi had football training") as a window to today. Today it is "trace unsourced", so it stays under-trained. Recommend yes: a gold and runtime change for nt16.
2. Series-ask options in date order, upcoming first (B-E093). Recommend yes, display only.
3. Optional: warn when a task is created with a past due date (an N5 side effect in test-B-075).
4. Kept as built unless the owner says otherwise:
   - R3d's menu-fairness rule is narrowed to words of 4+ letters for containers and 5+ letters for whole words. The broad version changed 1,214 of 5,523 train vault lines.
   - R1s is on in every mode.

## Where everything is

**In the repo**: the runtime (`crates/assist/src/native`, `crates/nativetools`), the data builder (`crates/datagen`), the eval (`crates/assist-eval`), and the trainer (`train/`).

**In GCS** (`gs://centraid-train-clawgnition`, project `centraid`):

| path | what |
| --- | --- |
| `soups/soup2/` (`soup1/`, `soup3/`) | S2 and its siblings, plain checkpoints |
| `p7-r3/avg/ckpt-avg/`, `p7-i2e4/avg/ckpt-avg/`, `p7-r2/out/ckpt-100/` | S2's three members |
| `p7-i2e4/job/bundle.dat` | the i2 bundle: code, runtime, and the train data as trained (legacy format) |
| `score/<name>/` | every scoring run of the Python rig |
| `i3-backup/phase7/` | the scratch tree of iterations 1 to 3. **Val runs and gold are inside: never give them to a data author.** |

**Infrastructure.** Training runs on GCP Spot via `train/vm/` (see its README) or on Kaggle (`train/kaggle/`).

- Log in with the service account: `cd train/vm; unset CLOUDSDK_AUTH_ACCESS_TOKEN; source ./common.sh; sa_login`.
- The VM `ct-train-p7-i2e4` (us-central1-a) is TERMINATED with its disk kept.
- Modal is not reachable from the cloud sandbox: its API is gRPC, which the proxy does not carry.

## Known gaps

- `assist-eval` was never run against a real model; the Kaggle kits (`crates/assist-eval/kaggle/`, which only scores, and `train/kaggle/`) were never run.
- The GPU path of the trainer (`train/train.py` on CUDA, the DPO memory probe) has run on CPU tests only. Run the trainer tests from inside `train/` (`python -m unittest test_datagen`), or all of them with `python3 run_tests.py`.

## Rules the owner set (keep them)

- Commits and pushes:
  - Never commit or push unless the owner says so, and scope commits to what is named.
  - Use Conventional Commits, ≤ 100 chars, citing (#1044).
  - Never use `--no-verify` without asking.
  - Run `cargo xtask gate --profile local` before a commit.
- Ask before any training launch, GPU scoring run, VM start or bucket upload. Stop VMs when done.
- Subagents are Sonnet only. **Authors of training data never open val/test gold, run outputs or the audit reports** (`data/v7/val.jsonl`, `data/v7/test.jsonl`, `score/`, `i3-backup/`, `p0/audit/`). Runtime agents don't either, and none of them use git.
- Test is scored only at milestones; every fix is derived on val.
- Never save credentials; use environment variables only. A credential posted in chat is to be rotated, not used.
- Back every claim with a paired comparison: sessions won and lost, z = (w − l)/√(w + l). |z| < 2 is noise.
