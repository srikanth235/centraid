# Notes for the second container (vanilla sweep B)

## Measured model sizes — Gemma 4 E2B is the BIGGEST, not the smallest

From vendors' own published GGUFs via the HF API (`/api/models/<id>?blobs=true`), not a secondary source:

| model              | resident params | Q4_K_M on disk |
| ------------------ | --------------- | -------------- |
| granite-4.0-h-350m | 0.34 B          | 223 MB         |
| Qwen3.5-0.8B       | 0.87 B          | 533 MB         |
| LFM2.5-2.6B        | 2.70 B          | 1674 MB        |
| gemma-4-E2B-it     | 5.12 B          | 3107 MB        |

Roughly 0.61 GB per billion RESIDENT params. "E2B" means ~2.3 B _effective_ via Per-Layer Embeddings, but the other ~2.8 B are embedding tables that still occupy disk. Google's own QAT q4_0 GGUF is 3350 MB; the "mobile-ct" checkpoint is 2672 MB. A widely-repeated "<1 GB text-only" figure corresponds to no artefact on the Hub — if real it is a LiteRT-LM runtime property (PLE streaming) that llama.cpp cannot do, and this project's mobile stack is not LiteRT-LM.

**Consequence: Gemma 4 E2B is DEMOTED from priority 1 to a quality reference point.** Still run it — a 5 B-resident Apache-2.0 model's score is a useful datapoint on what capacity buys — but budget 3.1 GB of disk for it and do not treat it as the leading mobile candidate.

## Revised order for container B

1. **Ceiling probe** (largest model that fits; subset of 40 sessions per corpus; both arms) — now FIRST, not last. It is the highest-value number available: it separates "the task is sound, small models just need distillation" from "the frame design or doctrine prompt is the problem, and fine-tuning cannot fix it". Get it out early.
2. **LFM2.5-2.6B** (1674 MB).
3. **Gemma 4 E2B** (3107 MB), as a quality reference.

## Other measured facts

- `google/gemma-4-1B-it` does not exist. Gemma 4's smallest is E2B. The only ~1 B Gemma is `gemma-3-1b-it` — gated, restrictive Gemma Terms, not Apache 2.0.
- `Qwen3.6-0.8B/1B/2B/4B` and the Qwen3.8 equivalents all 404. Qwen3.6-27B still reports `model_type: qwen3_5`, so 3.6/3.8 are the same architecture. Qwen3.5-0.8B (2026-02-28) is the newest small Qwen.
- Qwen3.5-2B is hybrid (18 linear_attention + 6 full_attention layers, Gated-DeltaNet family). llama.cpp b217f81c266 supports it as `LLM_ARCH_QWEN35`, measured 8.7 tok/s decode / 30-39 tok/s prefill on 2 CPU threads.
- **NEVER pass `--cache-reuse`.** On this architecture llama-server prints "cache_reuse is not supported by this context, it will be disabled" and then returns slot-history-dependent, non-deterministic answers for identical prompts. Verify determinism by running one corpus twice.

## How to use the harness

```
python3 mkschema.py --prove            # must print 434/434 before trusting anything
# start: llama-server -m MODEL.gguf -t 4 -tb 4 -c 16384 -np 4 --port 8080 --no-webui
#   NEVER pass --cache-reuse.
python3 run_qwen.py --corpus all --slots 4 --out out/<tag> --arm zero --model-name <tag>
python3 run_qwen.py --corpus all --slots 4 --out out/<tag>-knn --arm knn --shots 6 --model-name <tag>
./score.sh out/<tag>                   # renders + runs the repo's run-model
python3 summary.py out/<tag>           # parse rate, abstentions, latency split
```

Use `--limit` for the subset ceiling probe; it takes the first N turns of the sorted corpus.

## The four things that make the two halves comparable — do not vary them

1. The system prompt is the generated `Doctrine.swift` text read by `doctrine.py`, not a retyped copy.
2. The grammar is `mkschema.schema()`, derived from `frame.py`.
3. The run is FREE-RUNNING: `prev_used` is the harness's own rendered canonical, never gold.
4. Raw model text is appended to the stream file before anything parses it, and a failure is written with `error` set and never retried or repaired.
