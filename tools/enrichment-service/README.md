# Enrichment service (reference implementation, issue #724 W8)

A standalone HTTP service that serves `embed-image`, `embed-text`, `ocr`, `faces`, and `transcript` capabilities to the gateway over a small, frozen wire contract. Pure TypeScript on Bun/Node — no Python anywhere.

## Why this package is split in two

- **`tools/enrichment-service/`** (this directory) is a normal Bun workspace package: its TypeScript source is linted, typechecked, and tested by the repo's usual gates. It has **no ML/native dependency** — a root `bun install` never pulls onnxruntime-node or sharp because of this package.
- **`tools/enrichment-service/runtime/`** is a nested directory that is **not** a workspace package (it has no entry in any `workspaces.packages` glob). It holds `onnxruntime-node` and `sharp` — the one native/ML dependency pair this service needs — plus the downloaded model weights. `bun run setup` is the only thing that ever touches it.

See `src/onnx.ts` and `src/preprocess.ts` for how the service resolves those two packages from `runtime/node_modules` at first use (`createRequire` + `import(pathToFileURL(...))`), and `ort-types.d.ts` for the minimal ambient ONNX Runtime types that make this typecheck without the real package installed.

## Setup

```sh
bun run --cwd tools/enrichment-service setup
```

This runs `bun install` inside `runtime/` (installing `onnxruntime-node` + `sharp` there, never at the repo root) and downloads every capability's model weights + auxiliary files (tokenizer vocab/merges, OCR character dictionary) into `runtime/models/`. Already-downloaded files are skipped, so re-running is safe. See `LICENSES.md` for exactly what gets downloaded, from where, and under what licence.

## Serving

```sh
bun run --cwd tools/enrichment-service serve
```

Binds `127.0.0.1` only. Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ENRICH_SERVICE_PORT` | `8787` | Listen port. |
| `ENRICH_SERVICE_TOKEN` | unset | If set, every request must send `Authorization: Bearer <token>`. |
| `ENRICH_SERVICE_TRANSCRIPT_URL` | unset | OpenAI-compatible `/v1/audio/transcriptions` endpoint. `transcript` is only advertised in `/capabilities` when this is set AND the endpoint answers a liveness probe. |
| `ENRICH_SERVICE_MAX_BODY_BYTES` | `67108864` (64MB) | Request body cap. |

Point the gateway at it with:

```sh
CENTRAID_ENRICH_URL=http://127.0.0.1:8787
```

## Wire contract

- `GET /capabilities` → `{"capabilities": {"<cap>": {"model": "<name>@<version>"}}}`, advertising only capabilities whose weights are actually present (and, for `transcript`, whose proxy endpoint is reachable). A capability with missing weights is simply absent from this response — never a fake result ("honest absence").
- `POST /enrich/<cap>` with `{"items": [...]}` → `{"model": "...", "results": [...]}`, one result per item in request order, each either the capability's success shape (with `id`) or `{"id", "error"}`. A single bad/failing item never fails the rest of the batch.
- Unknown or currently-unavailable capability → `404 {"error": "unavailable"}`.
- Optional bearer auth (see `ENRICH_SERVICE_TOKEN` above).
- Single-item requests are handled immediately — there is no batch-accumulation step anywhere in this service.

See `src/types.ts` for the exact per-capability item/result shapes.

## Models

See `LICENSES.md` for the full table (model, version id, licence, source URL) and the note on why CLIP ViT-B/32 was used instead of the issue's first-choice MobileCLIP (Apple's weights licence isn't in the permissive allow-list this issue requires).

## Testing

```sh
bun run --cwd tools/enrichment-service test
bun run --cwd tools/enrichment-service typecheck
```

The vitest suite passes with **no** `bun run setup` having ever run — every test either exercises pure math (BPE tokenizer, CTC greedy decode, NMS, DB detection postprocess, YuNet decode, SFace alignment) or route/config logic that only needs the filesystem to confirm weights are _absent_ (the "honest absence" behavior above). Nothing in the suite imports onnxruntime-node or sharp directly — both are always behind the lazy loaders in `src/onnx.ts` / `src/preprocess.ts`.

## Known gaps for whoever wires this up against real weights

`bun run setup` was not executed in the environment this reference implementation was built in (no outbound package install / model download during that pass), so the following assumptions are documented in code but **not** verified against a real forward pass. Confirm each one with the actual downloaded model + a real image/audio sample before trusting output:

- **embed** (`src/capabilities/embed.ts`): assumes the CLIP ONNX export's first output tensor (`session.outputNames[0]`) is the pooled embedding.
- **ocr** (`src/capabilities/ocr.ts`): assumes the detector outputs a single-channel `[1,1,H,W]` probability map at the same resolution as its input, and that the recognizer's class layout is PaddleOCR's `[blank, ...chars, space]` convention with `chars.length + 2` classes. Detection boxes are axis-aligned (a documented simplification vs. PaddleOCR's rotated `minAreaRect` — see the header comment in `src/ocr-postprocess.ts`), so this pass does not recover angled or curved text lines.
- **faces** (`src/capabilities/faces.ts`, `src/face-geometry.ts`): assumes YuNet's 2023mar export produces exactly 9 outputs — `[scores, boxes, landmarks]` per stride, in stride order `8, 16, 32` — and that its box regression is the anchor-free `(cellCenter + delta*stride, exp(whDelta)*stride)` parametrization. Both need confirming against `opencv_zoo`'s own `yunet.py` and the real ONNX output metadata.
- All three ONNX-backed capabilities' input tensor **names** are read from `session.inputNames[0]` defensively rather than hardcoded, which should make them robust to naming even if the above shape assumptions need adjusting.
