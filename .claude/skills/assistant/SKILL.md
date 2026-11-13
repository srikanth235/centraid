---
name: assistant
description: >-
  How does the on-device assistant work, and how do I change it? Use for Chat, the tool contract or prompt, the pinned model and adapter, the training-data generator, the trainer, evaluation, and the safety rules around cloud jobs, credentials and held-out data.
---

# Assistant

It runs on the phone, writes only on the member's tap, and says what it cannot do. The rules that never bend: [safety.md](safety.md); the product rules: [product.md](product.md); the chat rows in `promises.rs` prove them.

| If you are doing | Read |
| --- | --- |
| Deciding what the assistant may do or say | [product.md](product.md) |
| Following a turn, or changing the chat screens | [runtime.md](runtime.md) |
| Changing the tool contract or the prompt | [contract.md](contract.md) |
| The model pin, the adapter, debug-only loaders | [model.md](model.md) |
| Training data (`crates/datagen`), or a change elsewhere that alters a tool's arguments or results | [data.md](data.md) |
| The trainer (`experiments/adapter-train`) | [training.md](training.md) |
| Scoring and what a number may claim | [eval.md](eval.md) |
| Any cloud job, credential, or held-out set | [safety.md](safety.md) |
