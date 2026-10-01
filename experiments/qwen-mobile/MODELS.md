# Small on-device models, 2026-09

The candidate landscape for the frame task's shipped model: a 0.3–3 B instruct model, quantised, running offline on a phone inside Centraid.

**Read the source column.** Several widely-cited roundups in this space are wrong about sizes, licences and release dates. Everything marked **[P]** was read from a primary source in this session — the Hugging Face model API (`/api/models/<id>`, which returns the repo's own `config.json` metadata, licence tag, gated flag and `safetensors.total`), a raw `config.json`, or a raw file listing with blob sizes. Everything marked **[S]** came from a vendor blog or a secondary roundup and was **not** independently checked; treat it as a claim, not a fact. Everything marked **[C]** is computed from **[P]** numbers.

---

## 1. The finding that should change the shortlist

**Q4 on-disk size tracks RESIDENT parameters, not "effective" parameters.** Measured from the vendors' own published GGUFs **[P]**:

| model | resident params | Q4_K_M GGUF | MB per billion resident params |
| --- | --: | --: | --: |
| `ibm-granite/granite-4.0-h-350m` | 0.34 B | **223 MB** | 656 |
| `Qwen/Qwen3.5-0.8B` | 0.87 B | **533 MB** | 613 |
| `LiquidAI/LFM2.5-2.6B` | 2.70 B | **1 674 MB** | 620 |
| `google/gemma-4-E2B-it` | 5.12 B | **3 107 MB** | 607 |

The ratio is flat at ~0.61 GB per billion **resident** parameters. Gemma 4 E2B is marketed as "effective 2 B" because Per-Layer Embeddings mean only ~2.3 B participate in the compute; the other ~2.8 B are per-layer embedding tables that still have to be **stored**.

So the claim that E2B "loads under 1 GB text-only" **[S]** does not correspond to any artefact I could find. Every published E2B artefact, checked directly **[P]**:

| artefact | size |
| --- | --: |
| `google/gemma-4-E2B-it-qat-q4_0-gguf` — Google's own QAT GGUF | **3 350 MB** |
| `unsloth/gemma-4-E2B-it-GGUF` Q4_K_M | 3 107 MB |
| `ggml-org/gemma-4-E2B-it-GGUF` Q4_0 | 2 841 MB |
| `google/gemma-4-E2B-it-qat-mobile-ct` — the "mobile" checkpoint | **2 672 MB** |

The smallest thing Google publishes for E2B is **2.67 GB**. A sub-1 GB figure, if it is real, must come from a LiteRT-LM runtime that streams or offloads the PLE tables — which is a Google-runtime property, not a property of the weights, and **llama.cpp cannot do it**. Centraid's mobile stack is not LiteRT-LM.

**Consequence for the plan.** On the size budget that is the whole point of the exercise, Gemma 4 E2B is the _largest_ of the four shortlisted arms by 5.8x over Granite Nano and 5.8x over Qwen 0.8B — not the on-device winner its marketing implies. It is a fine _quality_ datapoint and it is genuinely Apache-2.0, but it should not head the shortlist on size grounds. If a Gemma is wanted in the ~1 B band, the only one that exists is **Gemma 3 1B**, which is gated and under the restrictive Gemma Terms **[P]** — i.e. Gemma offers either the right size with the wrong licence, or the right licence with the wrong size.

_Caveat, stated honestly:_ "I could not find it" is not "it does not exist". I enumerated every `google/gemma-4-E2B*` repository **[P]** and none is under 2.6 GB, but a LiteRT-LM `.litertlm` bundle could live outside the Hub.

---

## 2. The shortlist

All four are in the 0.3–3 B band and all four converted-or-convertible to GGUF.

### `ibm-granite/granite-4.0-h-350m` — Granite 4.0 Nano

|  |  |
| --- | --- |
| params | **340 332 224** (0.34 B) **[P]** |
| architecture | `GraniteMoeHybridForCausalLM`, `model_type: granitemoehybrid` **[P]** — hybrid Mamba-2 / transformer **[S]** |
| licence | **apache-2.0** **[P]** |
| gated | no **[P]** |
| Q4_K_M | **223 MB**; Q4_0 216 MB; Q8_0 366 MB; bf16 685 MB — from `ibm-granite/granite-4.0-h-350m-GGUF` **[P]** |
| llama.cpp | first-party GGUF repo published by IBM **[P]**. IBM also ship a **non-hybrid twin**, `ibm-granite/granite-4.0-350m` (0.35 B, apache-2.0 **[P]**), explicitly for toolchains where Mamba-2 is not optimised **[S]** |
| family range | 350 M → 1.5 B, each in an `-h` hybrid and a plain variant **[S]** |

**Why it matters most.** It is the direct test of the capacity hypothesis (§4): is ~350 M enough for an ontology-constrained parse? At 223 MB it is 14x smaller than Gemma 4 E2B and it is the cheapest arm in the sweep to train. If it lands close to the 0.8 B arm, it is the shipping answer and the rest of the bake-off is a formality.

### `Qwen/Qwen3.5-0.8B`

|  |  |
| --- | --- |
| params | **873 438 784** (0.87 B) **[P]** |
| architecture | `Qwen3_5ForConditionalGeneration`, `model_type: qwen3_5`, text config `qwen3_5_text` **[P]**. **Vision-language checkpoint** — `vision_config` present, 12-layer ViT **[P]** |
| text stack | 24 layers, hidden 1024, head_dim 256, 8 Q heads / 2 KV heads, **vocab 248 320**, tied embeddings, `max_position_embeddings` 262 144 **[P]** |
| hybrid | `layer_types` is 3 x `linear_attention` then 1 x `full_attention`, repeated 6 times; `full_attention_interval: 4` **[P]**. The linear layers are Gated DeltaNet **[S]** |
| licence | **apache-2.0** **[P]** |
| Q4_K_M | **533 MB** text-only (+205 MB mmproj, not needed) — `unsloth/Qwen3.5-0.8B-GGUF` **[P]**. `ggml-org/Qwen3.5-0.8B-GGUF` publishes Q4_0 at 563 MB **[P]** |
| llama.cpp | upstream support; a build older than the Feb-2026 DeltaNet fixes loops **[S]** |
| family range | 0.8 B, 2 B, 4 B, 9 B, released 2026-03-02 **[S]**; the 0.8 B and 2 B repos were created 2026-02-28 **[P]** |

**Currency, verified.** Qwen3.5 is **still** the newest Qwen with a small tier as of 2026-09-22. Qwen3.6 (27 B, 35B-A3B) and Qwen3.8 (27 B) exist **[P]** but ship **nothing under 27 B** — `Qwen/Qwen3.6-0.8B`, `-1B`, `-2B`, `-4B` and the Qwen3.8 equivalents all 404 **[P]** — and Qwen3.6-27B _still reports_ `model_type: qwen3_5` **[P]**, i.e. the 3.6 and 3.8 series are the same architecture, not a new one.

**Note for LoRA.** Only 6 of 24 layers carry `q/k/v/o_proj`. A Llama-shaped target list adapts a quarter of the depth and says nothing about it. See `lora_targets.py`.

### `LiquidAI/LFM2.5-2.6B`

|  |  |
| --- | --- |
| params | **2 697 198 592** (2.70 B) **[P]** |
| architecture | `Lfm2ForCausalLM`, `model_type: lfm2` **[P]** — short-convolution / attention hybrid **[S]** |
| licence | **`other`** on the Hub **[P]** = LFM Open License v1.0 **[S]**. Apache-derived, but free commercial use reportedly **ends above $10 M annual revenue** **[S, unverified — read the licence text before this arm can win]** |
| Q4_K_M | **1 674 MB**; Q4_0 1 594 MB; Q8_0 2 875 MB; F16 5 403 MB — `LiquidAI/LFM2.5-2.6B-GGUF` **[P]** |
| llama.cpp | first-party, day one; `lfm2` is an upstream architecture **[P]** (`llama-cli -hf LiquidAI/...-GGUF` documented) |
| on-phone | ~30 tok/s under 2.5 GB **[S, vendor-reported]**; earlier LFM2 benchmarks on a Galaxy S24 Ultra claim the Pareto frontier for prefill and decode against size **[S, vendor-reported]** |
| family | LFM2.5 spans 230 M → 2.6 B dense plus an 8B-A1B MoE **[P, from the org listing]**. **`LiquidAI/LFM2.5-230M` exists** (2026-06-24) and is a closer size match to Granite Nano than the 2.6 B is |

**The most on-device-specialised vendor in the band**, and the only one whose licence is a live commercial question. Note the org listing also carries `LFM2.5-Encoder-230M` and `-350M` **[P]** — encoder models, relevant to §4.

### `google/gemma-4-E2B-it`

|  |  |
| --- | --- |
| params | **5 123 178 051** (5.12 B resident) **[P]**; ~2.3 B effective via PLE **[S]** |
| architecture | `Gemma4ForConditionalGeneration`, `model_type: gemma4` **[P]**. Multimodal: `vision_config` **and** `audio_config` **[P]** |
| text stack | 35 layers, hidden 1536, intermediate 6144, **vocab 262 144**, `vocab_size_per_layer_input: 262144` (the PLE tables), `num_kv_shared_layers: 20`, `enable_moe_block`, `num_experts`, **`final_logit_softcapping`** **[P]** |
| licence | **apache-2.0** **[P]** — Gemma 4 did move off the Gemma Terms **[P, the Hub licence tag]** |
| gated | no **[P]** |
| Q4_K_M | **3 107 MB** — see §1 |
| family | E2B and E4B created 2026-03-02; a `gemma4_unified` 12 B created 2026-05-23 **[P]**. **No `gemma-4-1B`** — `google/gemma-4-1B-it` 404s **[P]** |

**Two hazards, both structural.** (1) The size finding in §1. (2) `final_logit_softcapping` in the config **[P]** plus Gemma's reputation as the fp16-overflow family **[S]** — and Kaggle's free GPUs (P100 sm_60, T4 sm_75) have **no bf16**, so there is nothing to hide an overflow behind. Any fine-tune of this arm must watch for a non-finite loss and stop, rather than report a number produced by NaNs.

---

## 3. Ruled out, one line each

| model | why not |
| --- | --- |
| `google/gemma-3-1b-it` | The only Gemma in the ~1 B band (1.0 B **[P]**) but **gated** and under the restrictive **Gemma Terms** **[P]** — wrong licence for a shipping product, and it needs a human to accept terms before an unattended notebook can fetch it. |
| `google/gemma-4-E4B-it` | 8.00 B resident **[P]**; does not fit a 16 GiB card for training and is far past the size budget. |
| `HuggingFaceTB/SmolLM2-1.7B-Instruct` / `-360M` | Apache-2.0 **[P]** and a clean dense `LlamaForCausalLM` control arm, but 2024-vintage; superseded by Granite 4.0 Nano as the tiny-capacity probe. |
| `HuggingFaceTB/SmolLM3-3B` | Newest SmolLM (3.08 B, apache-2.0 **[P]**) but the family **dropped the small sizes** — v3 ships only at 3 B **[S]**, above the band. |
| `meta-llama/Llama-3.2-1B-Instruct` | Older generation (Sept 2024), **gated** **[P]**, `llama3.2` community licence with a 700 M MAU clause **[S]**. |
| `microsoft/Phi-4-mini-instruct` | MIT **[P]** and strong, but 3.84 B **[P]** — above the band. Also defaults to FlashAttention, which sm_60/sm_75 lack **[S]**. |
| Tiny Aya | CC-BY-NC — non-commercial, disqualified for a shipping product **[S]**. |
| Meta Muse Glimmer 30B | ~20 GB at 4-bit, needs a 24 GiB GPU **[S]** — two orders of magnitude outside the mobile target. |
| `ibm-granite/granite-4.2-3b` | Apache-2.0, dense `GraniteForCausalLM`, 3.66 B **[P]** — the newest Granite, but above the band; the 4.0 Nano tier is the on-device one. |

---

## 4. Prior art, and what to revisit

Recorded because it bears directly on the shortlist, **not** as a work item. None of this was verified in this session — all **[S]**, relayed from the lane's coordinator.

**Microsoft Mu** — a **330 M encoder-decoder** shipped in Windows for exactly our task shape: natural language → a narrow settings ontology → a structured action. Published results: ~**47% lower first-token latency** and ~**4.7x decode speed** against a decoder-only model of similar size on NPU, and **near-parity with a fine-tuned Phi-3.5-mini at roughly one-tenth the size**. The weights are not public, so it is not usable, but it is strong evidence that (a) ~300–400 M is enough capacity for an ontology-constrained parse, and (b) encoder-decoder may beat decoder-only on _latency_ at this size.

**T5 vs GPT-2 on FRAME semantic parsing** — our exact task shape. Published comparison:

| model       | params | frame-sense accuracy |  F1 |
| ----------- | -----: | -------------------: | --: |
| T5-small    |  120 M |                  82% | 79% |
| GPT-2 large |  770 M |                  82% | 77% |
| GPT-2 small |  117 M |                  77% | 59% |

~6x parameter saving for equal quality, from the encoder-decoder shape rather than from scale. Note the _F1_ column: GPT-2 small at the same size as T5-small loses 20 points of F1 while losing only 5 of accuracy — the decoder-only model gets the frame right and the _slots_ wrong, which is precisely our failure mode.

**Pointer / copy mechanisms** are the textbook fix for long-tail entity grounding, and long-tail entity grounding is our weakest measured area: literal grounding went 1.8% → 17.6% in the encoder lane and is still poor. `§Coverage` in `verify_corpus.py` shows the same thing from the data side — 40.7% of distilled training rows carry a quoted literal the model must copy out of the request.

**Revisit all three if the decoder-only arms show latency problems or literal-grounding problems.** Two independent lines of evidence point at encoder-decoder plus copy for this task at this size. Adding such an arm is a separate decision and is deliberately not part of the current sweep.

---

## 5. How these facts were obtained

Reproduce any **[P]** row:

```sh
curl -s "https://huggingface.co/api/models/Qwen/Qwen3.5-0.8B" | jq \
  '{type: .config.model_type, arch: .config.architectures,
    licence: .cardData.license, gated: .gated, params: .safetensors.total}'

curl -s "https://huggingface.co/Qwen/Qwen3.5-0.8B/raw/main/config.json"

# published GGUF sizes, the only honest source for "how big is it on a phone"
curl -s "https://huggingface.co/api/models/unsloth/Qwen3.5-0.8B-GGUF?blobs=true" | jq -r \
  '.siblings[] | select(.rfilename|endswith(".gguf")) | "\(.size/1e6|floor) MB \(.rfilename)"'
```

`safetensors.total` is the repository's real parameter count, which is why it disagrees with marketing names (`E2B` → 5.12 B). `?blobs=true` is what makes the size table above measurements rather than estimates — quote it, not a vendor's headline number.
