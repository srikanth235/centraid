# Handoff: the native tool task after phase 0 of iteration 4 (#1044)

This is the state on 2026-10-06, written for the next coding agent.

- Evidence and numbers: [`receipts/issue-1044-native-tool-task.md`](../../../receipts/issue-1044-native-tool-task.md) (the phase-0 section is last).
- How the task works (sets, the loop, layout): [`README.md`](README.md).
- The runtime contract: [`SPEC.md`](SPEC.md).
- Decisions: [`docs/decisions.md`](../../../docs/decisions.md), #1044 section; today's rulings are D-1044-16.

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
- **Val v7.4** (`eval/sets/val.jsonl`, sha256 `5d3d9035…`) is the nt15 refreeze. 128 accepts were added and none removed; lineage and hashes are in `eval/FROZEN.md`.
  - `build_sets.py check` accepts the hashes. It still lists 9 structural failures that belong to the deferred test redesign (test is held out of val's worlds whole, e2 origins). Those were in the tree before this phase.
  - **Test is not refrozen or scored on the phase-7 runtime** (owner deferred).
- 82 % is a val number: every fix, ruling and soup choice was derived on val. Expect test lower until it is scored.
- **The branch is on main** (`f5487678`, #1080) **plus #1078's on-device chat** (the `ios-app-simulator-aaef2f` branch), merged 2026-10-07. Main wins every overlap; the record is in the receipt's merge section.
  - The four native crates are ported to main's APIs. Harness worlds seal Locker cells under a fixed `HARNESS_LOCKER_KEY` (`crates/evalworld`, `crates/nativetools/src/vaultio.rs`) and name the generation through `Vault::locker_generation`, because the phone derives `K` from the 24 words.
  - Val v7.4 refreezes byte-identical on the merged runtime.
  - #1078's product assistant (`crates/assist`, `crates/assist-llama`, `crates/core/src/assist`) is a separate, read-only tool registry of 18 `<app>.<verb>` reads over llama.cpp. Wiring this task's model and its 8 tools into it is integration work that has not started.

## What phase 0 built (all CPU, all tested)

| piece | where | what it is for |
| --- | --- | --- |
| Hard-core audit | receipt; owner rulings in D-1044-16 | the 63 sessions every model fails: model-hard 44, runtime 12, conventions 5, gold 2 |
| Skill sessions | `authored/sessions/<W>_k1.py`, 21 train worlds, ids `<W>-K###`, tag `i3skill S<n>` | 355 verified sessions for the seven model-hard skills (referent, units/windows, read vs write, no invention, decline after a miss, vocabulary, look then pick). They are in the normal train build from now on. |
| Fresh prompts + screen set | `eval/sets/roll-screen.jsonl` (2,869 sessions: 2,514 fresh rewordings of train-world messages, new to training, plus the 355 skill sessions) | prompts S2 has never seen, for rejection sampling |
| Rollout driver | `eval/rollout.py`, `eval/test_rollout.py`; README "Rollouts" | `sets` (screen set; sample set of k copies `<id>-s<k>` of failures and of a seeded fraction of passes) and `export` (RFT records in train.jsonl format, DPO pairs `{id, chosen, rejected}` placed on the first failing turn) |
| Bundle options | `train/bundle.py`, `train/vm/bundles.sh`: `BUNDLE_WORLDS`, `BUNDLE_EVAL_ENV` | rollout sets were built on the collision worlds (`regen/worlds`, in GCS), so the bundle must ship them. Sampling (`NATIVE_SAMPLE=1`) goes only in the sample bundle. |
| Continuation + DPO | `train.py --dpo PAIRS [--dpo-beta 0.1 --dpo-sft 0.2]`, `bundle.py --continue-from gs://CKPT` (1 epoch, lr 4e-6, min-lr 0.05, warmup 0.02, EMA 0.999), `train/test_dpo.py` | DPO with the reference log-probs computed once before training (no second model on the GPU). **The DPO path has not run on a GPU yet**: its memory probe is CUDA-only. |
| Retry on a runtime signal | `eval/run.py`, `eval/run_batched.py`: `NATIVE_RETRY=1` (`NATIVE_RETRY_MAX`) | resample once on an error, refusal or empty reply, excluding the failed call; off by default |
| Scoring options | `train/vm/score_ckpt.sh --fast-kernels`, `--dtype` | opt-in; defaults unchanged |
| Gold conventions | `eval/regen.py`: `decline-any-reason` (N7), `superlative` widened (G1), `after-series-ask` (G2); SPEC §14.1 C1 to C6 |  |

## Next steps, in order (each paid step needs the owner's go; costs are estimates)

1. **Score S2 live on val v7.4 / nt15** (~$1, ~15 min).
   - The bundle is built locally at `/dev/shm/stage15/bundles-nt15/val`, but that path does not survive a new container. To rebuild it: `BUNDLE_NATIVETOOLS=<nt15 binary> BUNDLE_STAGE=/dev/shm/stage15 BUNDLES_DIR=/dev/shm/stage15/bundles-nt15 ./bundles.sh --sets val`. Build the binary with `cargo build --release -p centraid-nativetools`.
   - Score it: `BUNDLES_DIR=/dev/shm/stage15/bundles-nt15 BUNDLE_STAGE=/dev/shm/stage15 JOB=p7-i2e4 BUCKET=centraid-train-clawgnition STREAM=0 ./score_ckpt.sh gs://centraid-train-clawgnition/soups/soup2 --name soup2-nt15-v74 --sets val --bundles-prefix bundles-nt15 --watch`.
   - Compare it paired against S2's nt12 run rescored on v7.4 (541). If nt15's prompt change costs more than it fixes, stop and bring it to the owner.
2. **Screen** (~$2): S2 greedy over `roll-screen`. The bundle needs `BUNDLE_WORLDS=<regen/worlds>`; use `--new-vm` and a fresh `--name`. The exact commands are in README "Rollouts".
3. **Sample** (~$5–9): `rollout.py sets --sample --screen-report …` (k 6, frac 0.3), with a bundle built with `BUNDLE_EVAL_ENV='{"NATIVE_SAMPLE": "1"}'`.
4. **Export** (CPU): `rollout.py export … --worlds <regen/worlds>`, using the same nt15 binary that scored. Report the RFT record and pair counts before training.
5. **RFT continuation** of S2 (~$3–5): `bundle.py --continue-from gs://…/soups/soup2` on the verified rollouts plus the skill sessions plus a replay slice of the i2 train data, about 6–8k sessions or ~15M tokens. Score both the final checkpoint and its `-ema` twin. Then soup the result with S2 if that helps (`train/soup.py`, CPU, ~$1 to score).
6. **DPO** (~$2–3) on the best model so far, with the exported pairs. Check GPU memory on the first steps.
7. **Retry** (~$1): score the best model once with `NATIVE_RETRY=1` in the eval env.
8. **Freeze test and score it** before any milestone claim.
9. Later levers, if ~88 % stalls:
   - a second run on another data mix, as a new soup member;
   - fast kernels in training, which makes two runs per release affordable;
   - then 1.7B.

Expected from steps 5–7: about 86–88 % on val (RFT +2–4 points, DPO +1–3, retry +0.5–1). Every claim needs a paired comparison.

## Open owner questions (none applied)

1. A bare perfect tense ("how many times has tobi had football training") as a window to today. Today it is "trace unsourced", so it stays under-trained. Recommend yes: a gold and runtime change for nt16.
2. Series-ask options in date order, upcoming first (B-E093). Recommend yes, display only.
3. `regen.is_messaging` does not read "remind her about it" or "remind jordan about the rent". Gold is already right; only the train rewrite misses them.
4. Optional: warn when a task is created with a past due date (an N5 side effect in test-B-075).
5. D-E043 t3 ("how many do i have a cadence for" after a count) counts everyone, not the set just counted. Narrowing it would be a val reword; recommend leaving it.
6. Kept as built unless the owner says otherwise:
   - R3d's menu-fairness rule is narrowed to words of 4+ letters for containers and 5+ letters for whole words. The broad version changed 1,214 of 5,523 train vault lines.
   - R1s is on in every mode.

## Where everything is

**In the repo** (this commit):

- runtime: `crates/nativetools`;
- data tools: `authored/`;
- eval: `eval/`, including `replay.py`, `regen.py refreeze` and `rollout.py`;
- trainer: `train/`, including `train.py --ema --dpo`, `soup.py`, `bundle.py` and `vm/`.

**In GCS** (`gs://centraid-train-clawgnition`, project `centraid`):

| path | what |
| --- | --- |
| `soups/soup2/` (`soup1/`, `soup3/`) | S2 and its siblings, plain checkpoints |
| `p7-r3/avg/ckpt-avg/`, `p7-i2e4/avg/ckpt-avg/`, `p7-r2/out/ckpt-100/` | S2's three members |
| `p7-i2e4/job/bundle.dat` | the i2 bundle: code, runtime, and the train data as trained (the replay slice for step 5) |
| `score/<name>/` | every scoring run |
| `i3-backup/phase7/` | the scratch tree of iterations 1–3, including `regen/worlds` (the collision worlds the rollout sets need). **Val runs and gold are inside: never give them to a data author.** |

**Only in the session scratch** (`$S/phase7/p0/`, about 38 MB), not yet backed up:

- the fresh-prompt sources (`fresh_new/`, 2,856 sessions);
- their nt15 gold (`built/`, `built-k1/`);
- the audit reports (`audit/`, which quote val);
- the briefs. The screen set in the repo carries what steps 2–4 need. Back these up to `gs://…/p0-backup/` on the owner's go, or they are lost with the container.

**Infrastructure.** Scoring and training run on GCP Spot via `train/vm/`; see `README.md` there.

- Log in with the service account: `cd train/vm; unset CLOUDSDK_AUTH_ACCESS_TOKEN; source ./common.sh; sa_login`.
- The VM `ct-train-p7-i2e4` (us-central1-a) is TERMINATED with its disk kept.
- After scoring, stop it explicitly: `gcloud compute instances remove-metadata ct-train-p7-i2e4 --zone us-central1-a --keys=mode,manifest --project centraid`, then `gcloud compute instances stop ct-train-p7-i2e4 --zone us-central1-a --project centraid --discard-local-ssd=true --quiet`.
- Modal is not reachable from the cloud sandbox: its API is gRPC, which the proxy does not carry.

## Known failing checks (not this phase's; fix or rule)

- `train/test_trace3.py` `LlamaBackendStub`: 2 tests. The llama.cpp think grammar refuses a golden think. Scoring uses the HF backend, so no score is affected.
- `cargo test -p centraid-evalsuite --test bins` `validate_suite_is_clean_on_all_three_corpora`: suite.json turn s85/t1 is advisory DEFECTS.md #B9. It needs `target/eval-world` built first.
- `eval/build_sets.py check`: the 9 structural test-redesign failures above.
- `data/README.md` says AMB drills are never kept. That predates the composed ask and should be re-checked against a train build.
- Run the trainer tests from inside `train/` (`python -m unittest test_batching`). From the parent folder, `import train` resolves to the package and three `test_batching` tests error.

## Rules the owner set (keep them)

- Commits and pushes:
  - Never commit or push unless the owner says so, and scope commits to what is named.
  - Use Conventional Commits, ≤ 100 chars, citing (#1044).
  - Never use `--no-verify` without asking.
  - Run `cargo xtask gate --profile local` before a commit.
- Ask before any training launch, GPU scoring run, VM start or bucket upload. Stop VMs when done.
- Subagents are Sonnet only. **Authors of training data never open val/test gold, run outputs or the audit reports** (`eval/sets/val.jsonl`, `eval/sets/test.jsonl`, `score/`, `i3-backup/`, `p0/audit/`). Runtime agents don't either, and none of them use git.
- Test is scored only at milestones; every fix is derived on val.
- Never save credentials; use environment variables only. A credential posted in chat is to be rotated, not used.
- Back every claim with a paired comparison: sessions won and lost, z = (w − l)/√(w + l). |z| < 2 is noise.
