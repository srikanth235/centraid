# Issue #1092 — S2 on the phone, with the free reply and attachments off

[#1092](https://github.com/srikanth235/centraid/issues/1092) is the follow-up to [#1088](https://github.com/srikanth235/centraid/issues/1088)'s umbrella receipt ([issue-1088-one-assistant-plane.md](issue-1088-one-assistant-plane.md)), which is frozen on `main` since [#1087](https://github.com/srikanth235/centraid/pull/1087) merged. Rulings: [R-1088-18](../docs/decisions.md#one-assistant-plane-1088) and [R-1088-19](../docs/decisions.md#one-assistant-plane-1088).

## Checklist

- [x] S2 converted to the phone's `Q4_0` GGUF at the llama.cpp commit the engine vendors, published public (Apache-2.0)
- [x] Val v7.4 scored through `assist-step`, the phone's own decode step
- [x] `ChatModelAsset` pins S2 by commit, sha256 and size
- [x] The free reply removed and attachments switched off, because S2 writes no prose (R-1088-19)
- [ ] On-device measurement (memory at the 8,192-token context, first token, a full turn)
- [ ] The SwiftUI change compiled (no Xcode here)
- [ ] A model that keeps general chat (S3: LoRA, or mixed general-chat data) to bring the free reply and attachments back

## What changed

- **The model.** `train/to_gguf.py` converted `srikanth235/centraid-native-models@s2` (`430867aaf294`) to `centraid-native-s2-Q4_0.gguf`: 563,036,224 bytes, sha256 `b1be1e45024c8e98f670d456edfdf261c786878dd8260117806e285af8e9f668`. A second conversion, made to write the published sidecar with `--data-version data-v7`, gave the same sha256, and that second file is the one on the Hub (its LFS sha256 equals the scored file's). It is public at `srikanth235/centraid-native-gguf`, tag `s2-q4_0`, commit `657a377d0204cc6cc14563fc9d0fe78ccc8fafd9`; the card (commit `517d8fbc82ee`) states the val score and that the model is for the tool task only. An anonymous download returns the pinned size.
- **The pin.** `ChatModelAsset` names that commit, file, digest and size (`32ed1ddb2`).
- **The free reply** is deleted: a model `decline out_of_scope` gets the runtime's sentence, with no second generation (`9e2e457dd`).
- **Attachments** are off behind one switch on each side (`centraid_core::assist::attach::OFFERED`, `ChatMachine.ATTACHMENTS_OFFERED`, both false): the core refuses a send carrying an attachment with `AttachmentUnsupported`, a load attaches no projector, and the shell draws no attach menu (`ChatState.attach_offered = 48`, additive) and so never starts the projector download (`9e2e457dd`, `427298ccc`). The attachment code stays for S3; `Hub::offer_attachments` turns it on for one handle, which the tests of the dormant path use.
- **Tests and docs.** The free-reply and attachment tests in `crates/core/tests/assist_native.rs` and `crates/core-ffi/tests/assist.rs` now pin the canned sentence, the refusal and the absent projector; `crates/assist-llama/tests/real_model.rs` lost its free-reply case; `crates/assist/README.md` and `docs/release/v1-handoffs.md` (row 4.7) say what the phone now does.

## Evidence

- **Val v7.4 through the phone's decode** (`eval/run.py --model gguf`, `assist-step` built with `-C target-cpu=native`, two processes of two threads, greedy, 8 shards of every eighth session): **557 / 655 sessions (85.0 %, 95 % CI 82.1–87.6 %)**; turns 1,912 / 2,055; clean turns 1,805 / 1,903; 33 wrong writes; under-asks 5 / 112, over-asks 12 / 1,943; no think cut. 2,229 steps, 4,224,896 prompt tokens, 62,337 generated, 14.7 s a step on this 4-core CPU. S2's own recorded outputs (the training harness's free decoding), replayed on the current runtime against the same v7.4 gold: 542 / 655 (82.7 %); its live score, 537 / 655, was on v7.3 gold (`issue-1044-native-tool-task.md`, phase 0 table). The two decodes differ in more than the quantization (the phone's step compiles the think without the session's grounded compile op, and a replay keeps the old outputs where a live run would generate anew), so the comparison is of what the phone runs against the model's own best number on the same gold.
- **No prose.** S2's unquantized weights (transformers, float32, greedy) on the free-reply prompt as it was (`chat_prompt`, `CHAT_SYSTEM`): 0 of 5 questions ("hi", "what can you do?", "tell me a joke", "text Sam that I'm running late", "how are you today?") got a sentence; "hi", "what can you do?" and "how are you today?" looped an `intent:` think to the 160-token cap, "tell me a joke" wrote one think and then looped `<function=answer>` calls to the cap, and "text Sam…" wrote a `decline` call and stopped (47 tokens; `freereply/s2.txt`). The `Q4_0` file with unsloth's `mmproj-F16`, asked to describe a photograph (`crates/assist-llama/tests/real_vision.rs`): the projector attaches, and the model writes `intent: read "What is in"` and a looping tool call to the length cap: 120 tokens, `Finish::Length`, 1,433 MB resident, run on `75f6c8668` (`vision-s2.log` in the root's scratchpad: `cargo test --release -p centraid-assist-llama --features engine --test real_vision -- --ignored` with `CENTRAID_ASSIST_MODEL` the S2 file and `CENTRAID_ASSIST_MMPROJ` unsloth's projector).

## Verification

```
cargo xtask gate --profile local        # PASS on 75f6c8668 (test 1306.7 s; total 1479.8 s)
cargo xtask gate --profile mobile-jvm   # PASS (77.9 s of 420 s)
cargo clippy -p centraid-assist-llama -p centraid-core-ffi --all-targets --features centraid-core-ffi/llama -- -D warnings   # clean
```

## Audit

**PASS**

Audited 2026-10-09 by a reviewer who did not write the receipt, against `32ed1ddb2`, `9e2e457dd`, `427298ccc`, `75f6c8668` and `33a69304b` plus the follow-up's staged changes, and the root's evidence files (`s2-val/score.json` and the shard stats and logs, `score-one.sh`, `score-shards.sh`, the GGUF sidecars local and on the Hub, `s2-convert.log`, `freereply/probe.py` and `s2.txt`, `vision-s2.log`, `receipts/issue-1044-native-tool-task.md`). A first pass was REFUTED on four counts, all fixed before this one: the comparison set 557 on v7.4 beside 537 on v7.3 (now 542 on the same gold, 537 named as the v7.3 live score); "two conversions" lacked evidence (the Hub sidecar, `data_version: data-v7`, carries the scored file's sha256); the probe wording overcounted the looping thinks; diff items went unnamed.

- **Checklist.** HELD. The checked items match the diff and the Hub; the open ones claim nothing.
- **What changed.** HELD. `sha256sum` and `stat` of the scored GGUF, the sidecar, the Hub's LFS record (tag `s2-q4_0` at `657a377d`, public, `license:apache-2.0`) and `ChatModelAsset.kt` agree. `attach::OFFERED` and `ChatMachine.ATTACHMENTS_OFFERED` are false; `send` refuses `AttachmentUnsupported` before resolving anything; a load attaches no projector; `attach_offered = 48` is additive; the tests and docs it names are in the diff.
- **Evidence: val.** HELD. `score.json` matches every number given; the eight shard stats sum to 2,229 steps, 4,224,896 prompt tokens, 62,337 generated, 14.67 s a step, no think cut; 542 / 655 and 537 match `issue-1044-native-tool-task.md:220-223`.
- **Evidence: no prose.** HELD. `probe.py` holds the deleted `CHAT_SYSTEM` character for character; `s2.txt` and `vision-s2.log` show what the receipt says (the vision run's assertion fails on `Length`, as it should). The log does not name its commit.
- **Verification.** Not re-run (the machine was busy); the gate lines are consistent with `75f6c8668`, and the later commits are docs only.
