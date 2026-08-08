# Third-party models

None of these weights are committed to this repository (see `.gitignore` in this directory) — `bun run setup` downloads each one from the source listed below. Only permissively-licensed models (Apache-2.0/MIT) are used, per issue #724 W8's acceptance criteria. Verified against the upstream repositories/model cards on 2026-08-07.

| Capability | Model | Version id | Licence | Source |
| --- | --- | --- | --- | --- |
| embed-image, embed-text | CLIP ViT-B/32 (OpenAI weights) | `clip-vit-b-32@1` | MIT | Code+weights: [github.com/openai/CLIP](https://github.com/openai/CLIP) (`LICENSE`). ONNX export used by setup: [huggingface.co/immich-app/ViT-B-32__openai](https://huggingface.co/immich-app/ViT-B-32__openai) (visual/textual towers + `vocab.json`/`merges.txt`, the same BPE tokenizer files as OpenAI's `clip/bpe_simple_vocab_16e6.txt.gz`). |
| ocr | PP-OCRv4 detection + recognition | `pp-ocrv4@1` | Apache-2.0 | Model: [github.com/PaddlePaddle/PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) (`LICENSE`). ONNX export used by setup: [huggingface.co/SWHL/RapidOCR](https://huggingface.co/SWHL/RapidOCR), `PP-OCRv4/ch_PP-OCRv4_det_infer.onnx` + `PP-OCRv4/ch_PP-OCRv4_rec_infer.onnx` (RapidOCR project itself is also Apache-2.0). Character dictionary: PaddleOCR's own [`ppocr/utils/ppocr_keys_v1.txt`](https://github.com/PaddlePaddle/PaddleOCR/blob/main/ppocr/utils/ppocr_keys_v1.txt). |
| faces (detection) | YuNet | `yunet-sface@1` | MIT | [github.com/opencv/opencv_zoo](https://github.com/opencv/opencv_zoo), `models/face_detection_yunet/` ("All files in this directory are licensed under MIT License" per that directory's README). File: `face_detection_yunet_2023mar.onnx`. Mirror used by setup: [huggingface.co/opencv/face_detection_yunet](https://huggingface.co/opencv/face_detection_yunet). |
| faces (recognition) | SFace | `yunet-sface@1` | Apache-2.0 | [github.com/opencv/opencv_zoo](https://github.com/opencv/opencv_zoo), `models/face_recognition_sface/` ("All files in this directory are licensed under Apache 2.0 License" per that directory's README). File: `face_recognition_sface_2021dec.onnx`. Mirror used by setup: [huggingface.co/opencv/face_recognition_sface](https://huggingface.co/opencv/face_recognition_sface). |
| transcript | (proxy only — no bundled model) | `whisper-proxy@1` | n/a | Forwards to whatever OpenAI-compatible `/v1/audio/transcriptions` endpoint the operator points `ENRICH_SERVICE_TRANSCRIPT_URL` at. This service ships no ASR weights of its own. |

## Why CLIP ViT-B/32 and not MobileCLIP

The issue's brief named MobileCLIP as the preferred OpenCLIP-family model. Checked and rejected: Apple's `ml-mobileclip` weights are released under the **Apple Sample Code License** (`LICENSE_weights_data` in [apple/ml-mobileclip](https://github.com/apple/ml-mobileclip)), which is not in the permissive allow-list (Apache-2.0/MIT/BSD) this issue requires. OpenAI's original CLIP ViT-B/32 (MIT, both code and weights) with a reliably-hosted ONNX export was used instead, matching the issue's documented fallback ("otherwise... support a CLIP ViT-B/32 ONNX from a permissive source").

## Runtime dependencies (not models, but also worth recording here)

`tools/enrichment-service/runtime/package.json` pins `onnxruntime-node` (MIT, Microsoft) and `sharp` (Apache-2.0) — both already used elsewhere in this monorepo (`packages/gateway`, `apps/extension` for sharp). Neither is a dependency of this workspace package itself; see `runtime/package.json` and `src/onnx.ts` for why.

## Live-test fixture

The face golden uses OpenCV's `samples/data/lena.jpg` pinned at commit `77dfa297d08fdecdc509fc01ad92a2e9ec776a57` (Apache-2.0). Its source SHA-256 and storage rationale are recorded in `fixtures/README.md`.
