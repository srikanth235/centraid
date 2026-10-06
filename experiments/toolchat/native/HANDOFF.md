# Handoff: the native tool task after iteration 3 (#1044)

State on 2026-10-06, for the next coding agent. Evidence and numbers: [`receipts/issue-1044-native-tool-task.md`](../../../receipts/issue-1044-native-tool-task.md). How the task works (sets, the loop, layout): [`README.md`](README.md). The runtime contract: [`SPEC.md`](SPEC.md). Decisions: [`docs/decisions.md`](../../../docs/decisions.md), #1044 section.

## Where it stands

| model | what | val sessions (655) | wrong writes |
| --- | --- | --- | --- |
| **S2 (current best)** | soup of r3a + i2a + r2 ckpt-100, a third each | **537 (82.0 %)** on nt12; 540 by replay on nt13 | 39 |
| S1 | r3a + i2a, half each | 534 | 45 |
| S3 | r3a 40 % + i2a 60 % | 537 | 45 |
| i2a | p7-i2e4, average of ckpt-075 and ckpt-100 (NEW data) | 502 | 53 |
| r3a | p7-r3, average of ckpt-075 and ckpt-100 (OLD data) | 491 | 41 |
| r2 | p7-r2 ckpt-100 | 467 (nt8) |  |

- Runtime: **nt13** is the crate `crates/nativetools` at this commit (823 tests; `tests/phase9_nt13.rs`). Val gold refreezes byte-identical on it.
- Val is the v7.3 refreeze (`eval/sets/val.jsonl`, sha256 `40d662a9441a…`). **`eval/FROZEN.md` is stale**: it still records 7.1 (`c518b664…`); bring its version line, hash and lineage up to 7.2 (nt8 refreeze) and 7.3 (nt11 rulings) from `docs/decisions.md` and the receipt. **Test is not scored on the phase-7 runtime and not refrozen for it** (owner deferred; step 7).
- 82 % is a val number: every fix, ruling and the soup choice were derived on val. Expect test lower until it is scored.

## What the evidence says (read before planning)

1. **Most of the remaining error is variance, not missing skill.** Two checkpoints of one run disagree on 22–31 sessions; r3a and i2a disagree on 131 sessions (each passes ~half). The union of six runs passes 591 (90 %); pass@5 sampling of one model 528 vs greedy 490. Training memorises (98 % of natural targets repeat, 3–4 epochs), so which borderline session passes is training noise.
2. **That is why the soup works.** S2 keeps 420 of the 431 sessions both members pass, wins 95 of the 131 contested (73 %, not the ~50 % of "in between"), and recovers 22 of 93 both-fail. Gain decomposition from i2's ckpt-100 (489) to S2 (537): same-run averaging +13, cross-run (different data mix) +32, a third member +3. **More soups of the existing checkpoints are spent** (S2/S3 +3 over S1, noise).
3. **i2's regressions** (NEW vs OLD data): churn + "commits more" (rows 835 → 907, asks 11 → 7, wrong writes 41 → 53) + the dead-end cut (teaches decline after a hint instead of search). Natural share 50 → 67 % doubled exposure. Not the runtime, not the paraphrase labels.
4. **S2's 118 failures**: 47 pass in some other run (residual variance), 64 never pass in any of six runs (hard core: capability, gold, runtime), 30 end in an empty read or a runtime error. Worst tags: balance values 16/22, repair 42/56, empty 29/37, compute 37/47.
5. **nt13 bought +2 to +3 sessions by replay** (expected +6–10): replay cannot credit a turn whose later steps the recorded model wrote for the old reply, and S2 already passed part of the target. The replay's down-flips were all replay artefacts (renumbered rows, a recorded repeat after a now-successful call), none an nt13 error.
6. **One fresh run on today's data gives ~490–502, not S2.** S2 is reproducible only by re-averaging its three stored members. To get S2-level from scratch: (a) turn S2 into data (rejection-sampled rollouts, below), (b) soup as recipe (EMA in every run, two runs on different mixes), (c) less memorisation (fewer repeats, fresh rewording per epoch). (a) is the next step; (b)'s EMA is in the trainer.

## Next steps, in order (each paid step needs the owner's go)

1. **Owner rulings (4, pending):**
   1. Group balance with no person named → the user's own position. Recommend yes (runtime + gold).
   2. "Counting heads" (who's in … counting heads): list rows or a count? Recommend keep gold (rows).
   3. Early link to the notebook being browsed: recommend keep gold.
   4. R6 offer-then-confirm (plan a new event after the runtime's own offer): informational; gold already wants the create, nt13 makes it reachable. Apply accepted ones to the runtime and val (`eval/regen.py refreeze`, a new FROZEN.md version + `docs/decisions.md` entry).
2. **Score S2 live on val with nt13** (~$1, GPU; fold into the next scoring run). Baseline for what follows.
3. **Rejection-sampled rollouts from S2 on fresh prompts** (~$25–30). Prompts must be new: train sessions are memorised.
   - Fresh rewording of train-world messages (Haiku/Sonnet authors, train worlds only, never val/test) and drills with a new seed (`authored/gen/drills.py gen --seed <new>`).
   - Sample k = 4–8 per session (`NATIVE_SAMPLE=1` in `--eval-env`; a set file with ids `<id>-s<k>`, as `score-valx5` did), keep the sessions whose every turn passes the runtime-derived gold; keep the failed ones too (for DPO).
4. **RFT run from base** (~$10–15): existing train data + the verified rollouts, **with `--ema 0.999`**. If it reaches ~530 alone, S2 is reproducible from data. Score `ckpt-100` and `ckpt-100-ema`, then soup it with S2 (`train/soup.py`), which needs a diverse member.
5. **DPO** on the same rollouts (pass vs fail on one prompt). The trainer has no DPO loss yet: that is code to write.
6. **Retry on a runtime signal** at inference: on an empty or error reply, resample once. 30 of S2's failures end that way. A harness change plus a $1 score. Verifier best-of-k is the bigger version, with a k× latency cost on device: the owner's call.
7. **Freeze test (#4) and score it** before any milestone claim.
8. **Paused by the owner**: fast kernels smoke test (`bundle.py --fast-kernels`, flash-linear-attention + causal-conv1d, ~2–4× faster training). Makes "two runs per release" affordable. 1.7B waits until the 0.8B variance levers are spent.

## Where everything is

**In the repo** (this commit): runtime `crates/nativetools`; data tools `authored/`; eval `eval/` (`replay.py` rescoring a recorded run under a new runtime on CPU in ~2 min, `regen.py refreeze`); trainer `train/` (`train.py --ema`, `soup.py`, `bundle.py`, `vm/`). `data/` holds the **r1** build (`data/README.md`); the i2 train file is inside the i2 job bundle (below).

**In GCS** (`gs://centraid-train-clawgnition`, project `centraid`):

| path | what |
| --- | --- |
| `soups/soup2/` (`soup1/`, `soup3/`) | S2 and its siblings, plain checkpoints |
| `p7-r3/avg/ckpt-avg/`, `p7-i2e4/avg/ckpt-avg/`, `p7-r2/out/ckpt-100/` | S2's three members |
| `p7-i2e4/job/bundle.dat` | the i2 bundle: code, runtime, train data as trained |
| `score/<name>/` | every scoring run (`summary.json`, runs) |
| `bundles-nt12/` | the staged eval bundles per set for nt12 (build `bundles-nt13` with `train/vm/bundles.sh` before scoring on nt13) |
| `i3-backup/phase7/` | the whole scratch tree of iterations 1–3: analysis scripts (`i3/an/`, `REGRESSIONS.md`), recorded val runs and scores (`i3/w/`), the nt13 acceptance check (`i3/nt13/check.sh`, `check/`), the i2 data pipeline (`i2/pipeline.sh`, `i2/data/`), briefs. **Val runs and gold are inside: never give them to a data author.** |
| `i2-backup/` | the older backup (nt11, nt12 binaries, val v7.3 work) |

**Infrastructure.** Scoring and training run on GCP Spot via `train/vm/` (`README.md` there). Log in with the service account: `cd train/vm; unset CLOUDSDK_AUTH_ACCESS_TOKEN; source ./common.sh; sa_login`. Score a checkpoint on val:

```
BUNDLES_DIR=<stage>/bundles-nt13 BUNDLE_STAGE=<stage> JOB=p7-i2e4 BUCKET=centraid-train-clawgnition STREAM=0 \
  ./score_ckpt.sh gs://centraid-train-clawgnition/soups/soup2 --name soup2-nt13 --sets val --bundles-prefix bundles-nt13 --watch
```

The VM (`ct-train-p7-i2e4`, us-central1-a, TERMINATED, disk kept) stays RUNNING after scoring: stop it explicitly (`gcloud compute instances remove-metadata ct-train-p7-i2e4 --zone us-central1-a --keys=mode,manifest --project centraid` then `gcloud compute instances stop ct-train-p7-i2e4 --zone us-central1-a --project centraid --discard-local-ssd=true --quiet`). Modal is not reachable from the cloud sandbox (its API is gRPC, which the proxy does not carry).

## Known failing checks (not this iteration's; fix or rule)

- `train/test_trace3.py` `LlamaBackendStub`: 2 tests. The llama.cpp think grammar refuses a golden think (`find ('kind', 'when', 'where') | day+9 | n,o,n,e`). Scoring uses the HF backend (llguidance), so no score is affected; the llama path is behind the trace.
- `cargo test -p centraid-evalsuite --test bins` `validate_suite_is_clean_on_all_three_corpora`: suite.json turn s85/t1 implies an order with `ordered` unset (advisory DEFECTS.md #B9). It also needs `cargo run -p centraid-evalworld --bin build-eval-world -- target/eval-world` first. Everything else in `cargo xtask gate --profile local` passes (fmt, clippy, rules, ledgers, restore-drill).

## Rules the owner set (keep them)

- Never commit or push unless the owner says so; scope commits to what is named. Conventional Commits, ≤ 100 chars, cite (#1044). Never `--no-verify` without asking. `cargo xtask gate --profile local` before a commit.
- Ask before any training launch, GPU scoring run or VM start; stop VMs when done.
- Subagents are Sonnet only. **Authors of training data never open val/test gold or run outputs** (`eval/sets/val.jsonl`, `eval/sets/test.jsonl`, `score/`, `i3-backup/`); runtime agents do not either, and do not use git.
- Test is scored only at milestones; every fix is derived on val.
- Never save credentials; environment variables only. A credential posted in chat is to be rotated, not used.
- Paired comparisons for every claim: sessions won and lost, z = (w − l)/√(w + l); |z| < 2 is noise.
