# Third-party models

None of these weights are committed to this repository (see `.gitignore` in this directory) — `bun run setup` downloads each one from the source listed below. Only permissively-licensed models (Apache-2.0/MIT) are used, per issue #724 W8's acceptance criteria. Verified against the upstream repositories/model cards on 2026-09-09.

| Capability | Model | Version id | Licence | Source |
| --- | --- | --- | --- | --- |
| embed-image, embed-text | CLIP ViT-B/32 (OpenAI weights) | `clip-vit-b-32@1` | MIT | Code+weights: [github.com/openai/CLIP](https://github.com/openai/CLIP) (`LICENSE`). ONNX export used by setup: [huggingface.co/immich-app/ViT-B-32__openai](https://huggingface.co/immich-app/ViT-B-32__openai) (visual/textual towers + `vocab.json`/`merges.txt`, the same BPE tokenizer files as OpenAI's `clip/bpe_simple_vocab_16e6.txt.gz`). |
| ocr | PP-OCRv5 mobile detection + recognition | `pp-ocrv5@1` | Apache-2.0 | Model: [github.com/PaddlePaddle/PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) (`LICENSE`). ONNX export used by setup: [huggingface.co/webnn/PP-OCRv5-ONNX](https://huggingface.co/webnn/PP-OCRv5-ONNX), pinned to commit `006b4419a415072fbb16a1d7d0d8548f789a8fae` — `ch_PP-OCRv5_det.onnx` + `ch_PP-OCRv5_rec.onnx`. Character dictionary: PaddleOCR's own PP-OCRv5 keys, `ch_PP-OCRv5_dict.txt`, from the same pinned commit. Superseded `pp-ocrv4@1` in [#1011](https://github.com/srikanth235/centraid/issues/1011). |
| faces (detection) | YuNet | `yunet-arcface@1` | MIT | [github.com/opencv/opencv_zoo](https://github.com/opencv/opencv_zoo), `models/face_detection_yunet/` ("All files in this directory are licensed under MIT License" per that directory's README). File: `face_detection_yunet_2023mar.onnx`. Mirror used by setup: [huggingface.co/opencv/face_detection_yunet](https://huggingface.co/opencv/face_detection_yunet). |
| faces (recognition) | ArcFace ResNet100 (LResNet100E-IR, 512-d) | `yunet-arcface@1` | Apache-2.0 | [github.com/onnx/models](https://github.com/onnx/models), `validated/vision/body_analysis/arcface/` (that model's README states "License: Apache 2.0", as does the repository's own `LICENSE`). File: `arcfaceresnet100-8.onnx`, pinned to commit `4c46cd00fbdb7cd30b6c1c17ab54f2e1f4f7b177`. Superseded SFace in [#1011](https://github.com/srikanth235/centraid/issues/1011): 512-d additive-angular-margin embeddings in place of SFace's 128-d. InsightFace's own `buffalo_l`/`w600k_r50` checkpoint was rejected despite being the stronger model — the InsightFace model zoo licenses its pretrained weights for non-commercial research only, which this table's Apache-2.0/MIT rule does not admit. |
| transcript | Whisper tiny.en (quantized ONNX) | `whisper-tiny.en-q8@1` | MIT | Model and weights: [github.com/openai/whisper](https://github.com/openai/whisper) (`LICENSE`). Transformers.js-compatible ONNX export used by setup: [huggingface.co/onnx-community/whisper-tiny.en](https://huggingface.co/onnx-community/whisper-tiny.en), pinned to commit `2575352d61be1bf7225cf8f8b268a4678025fc58`. |

## Bundled data (this one IS committed)

One third-party dataset is committed to the repository, because the capability it serves is worthless if it needs a download: `place-names` exists so that a coordinate can be named with nothing sent anywhere, and a table that arrives over the network on first use would only move the egress rather than remove it.

| Capability | Dataset | Snapshot | Licence | Source |
| --- | --- | --- | --- | --- |
| place-names | GeoNames `cities15000` (settlements over 15,000 people; 23,527 rows, trimmed to name/lat/lng/US state/country/population) | 2017-02-27 | **CC-BY 3.0 Unported** | [geonames.org](https://www.geonames.org/). Obtained from the npm package [`cities15000@0.0.1`](https://www.npmjs.com/package/cities15000) on registry.npmjs.org, which vendors that snapshot together with the CC-BY 3.0 legal code. |

Attribution to GeoNames is required wherever the data travels, so it ships three times on purpose: in `src/gazetteer-data.ts` beside the table itself, in `packages/blueprints/automations/place-names/LICENSE-GEONAMES.md` inside the automation bundle members install, and in the automation's own member-facing description. Current GeoNames releases are CC-BY **4.0**; this snapshot predates that change and ships under the 3.0 terms its package declares. Refreshing the snapshot means re-deriving the table from a newer dump and restating the licence version in all three places.

## Why CLIP ViT-B/32 and not MobileCLIP

The issue's brief named MobileCLIP as the preferred OpenCLIP-family model. Checked and rejected: Apple's `ml-mobileclip` weights are released under the **Apple Sample Code License** (`LICENSE_weights_data` in [apple/ml-mobileclip](https://github.com/apple/ml-mobileclip)), which is not in the permissive allow-list (Apache-2.0/MIT/BSD) this issue requires. OpenAI's original CLIP ViT-B/32 (MIT, both code and weights) with a reliably-hosted ONNX export was used instead, matching the issue's documented fallback ("otherwise... support a CLIP ViT-B/32 ONNX from a permissive source").

## Runtime dependencies (not models, but also worth recording here)

`packages/model-runtime/runtime/package.json` pins `onnxruntime-node` (MIT, Microsoft), `sharp` (Apache-2.0), `@napi-rs/canvas` (MIT), `pdfjs-dist` (Apache-2.0), `@huggingface/transformers` (Apache-2.0), and `@ffmpeg-installer/ffmpeg` (LGPL-2.1). These are optional local execution dependencies rather than dependencies of this workspace package itself; see `runtime/package.json` and `src/onnx.ts` for why.

## Live-test fixture

The face golden uses OpenCV's `samples/data/lena.jpg` pinned at commit `77dfa297d08fdecdc509fc01ad92a2e9ec776a57` (Apache-2.0). Its source SHA-256 and storage rationale are recorded in `fixtures/README.md`.
