# Issue #1088 — S2 on the phone

The follow-up to [#1088](https://github.com/srikanth235/centraid/issues/1088)'s umbrella receipt ([issue-1088-one-assistant-plane.md](issue-1088-one-assistant-plane.md)), which is frozen on `main` since [#1087](https://github.com/srikanth235/centraid/pull/1087) merged. Rulings: [R-1088-18](../docs/decisions.md#one-assistant-plane-1088) and [R-1088-19](../docs/decisions.md#one-assistant-plane-1088).

## Checklist

- [x] S2 converted to the phone's `Q4_0` GGUF at the llama.cpp commit the engine vendors, published public (Apache-2.0)
- [x] Val v7.4 scored through `assist-step`, the phone's own decode step
- [x] `ChatModelAsset` pins S2 by commit, sha256 and size
- [x] The free reply removed and attachments switched off, because S2 writes no prose (R-1088-19)
- [ ] On-device measurement (memory at the 8,192-token context, first token, a full turn)
- [ ] The SwiftUI change compiled (no Xcode here)
- [ ] A model that keeps general chat (S3: LoRA, or mixed general-chat data) to bring the free reply and attachments back

## What changed

- **The model.** `train/to_gguf.py` converted `srikanth235/centraid-native-models@s2` (`430867aaf294`) to `centraid-native-s2-Q4_0.gguf`: 563,036,224 bytes, sha256 `b1be1e45024c8e98f670d456edfdf261c786878dd8260117806e285af8e9f668`. Two conversions gave the same bytes. It is public at `srikanth235/centraid-native-gguf`, tag `s2-q4_0`, commit `657a377d0204cc6cc14563fc9d0fe78ccc8fafd9`; the card (commit `517d8fbc82ee`) states the val score and that the model is for the tool task only. An anonymous download returns the pinned size.
- **The pin.** `ChatModelAsset` names that commit, file, digest and size (`32ed1ddb2`).
- **The free reply** is deleted: a model `decline out_of_scope` gets the runtime's sentence, with no second generation (`9e2e457dd`).
- **Attachments** are off behind one switch on each side (`centraid_core::assist::attach::OFFERED`, `ChatMachine.ATTACHMENTS_OFFERED`, both false): the core refuses a send carrying an attachment with `AttachmentUnsupported`, a load attaches no projector, and the shell draws no attach menu (`ChatState.attach_offered = 48`, additive) and so never starts the projector download (`9e2e457dd`, `427298ccc`). The attachment code stays for S3.

## Evidence

- **Val v7.4 through the phone's decode** (`eval/run.py --model gguf`, `assist-step` built with `-C target-cpu=native`, two processes of two threads, greedy, 8 shards of every eighth session): **557 / 655 sessions (85.0 %, 95 % CI 82.1–87.6 %)**; turns 1,912 / 2,055; clean turns 1,805 / 1,903; 33 wrong writes; under-asks 5 / 112, over-asks 12 / 1,943; no think cut. 2,229 steps, 4,224,896 prompt tokens, 62,337 generated, 14.7 s a step on this 4-core CPU. S2 on the training harness's free decoding: 537 / 655 (82.0 %). The two decodes differ in more than the quantization (the phone's step compiles the think without the session's grounded compile op), so the comparison is of what the phone runs against the number the model was promoted on.
- **No prose.** S2's unquantized weights (transformers, float32, greedy) on the free-reply prompt as it was (`chat_prompt`, `CHAT_SYSTEM`): 0 of 5 questions ("hi", "what can you do?", "tell me a joke", "text Sam that I'm running late", "how are you today?") got a sentence; four looped an `intent:` think to the 160-token cap, one wrote a `decline` call. The `Q4_0` file with unsloth's `mmproj-F16`, asked to describe a photograph (`crates/assist-llama/tests/real_vision.rs`): the projector attaches, and the model writes `intent: read … via: find … kind: photo` and a looping tool call to the length cap.

## Verification

```
cargo xtask gate --profile local        # PASS on 75f6c8668 (test 1306.7 s; total 1479.8 s)
cargo xtask gate --profile mobile-jvm   # PASS (77.9 s of 420 s)
cargo clippy -p centraid-assist-llama -p centraid-core-ffi --all-targets --features centraid-core-ffi/llama -- -D warnings   # clean
```
