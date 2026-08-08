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

## Real-weight evidence

The formerly unverified tensor-layout assumptions are closed by the weekly/manual live lane. `models.lock.json` pins every weight and auxiliary file by SHA-256 and licence; `src/model-goldens.live.test.ts` runs the actual CLIP, PP-OCRv4, YuNet, and SFace exports over committed fixtures and asserts the exact capability/model handshake, OCR text and box tolerance, embedding cosine tolerance, and face count/geometry. Run it after model or preprocessing changes and before a release:

```sh
bun run --cwd tools/enrichment-service setup
bun run test:enrich:live
```

The scheduled workflow is `.github/workflows/enrichment-live-weekly.yml`. Its evidence appears in the test-health report with an eight-day freshness window; absence is grey, never green. The deterministic default suite remains weight-free. Detection boxes remain intentionally axis-aligned (see `src/ocr-postprocess.ts`), so angled/curved OCR quality is dogfood judgement rather than a CI law.
