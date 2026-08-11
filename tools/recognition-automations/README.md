# Recognition automation model sources

This directory owns build-time source, optional local model assets, and live-model tests for Centraid's self-contained `photo-ocr`, `embed-image`, `embed-text`, `faces`, and `transcript` automation handlers. Nothing here listens on a port and the gateway does not call a separate inference process.

## Build the shipped handlers

Source handlers live in `automation-handlers/`. Bundle them into the blueprint tree with:

```sh
bun run --cwd tools/recognition-automations build:automations
```

The output is one release-managed `handler.js` per recipe under `packages/blueprints/automations/<id>/automations/<id>/`. At runtime a handler reads source material with `ctx.vault.content`, runs its own implementation, and persists through `ctx.vault.invoke`. Large third-party libraries and model assets are resolved from the shared pinned `runtime/` rather than copied into every handler. There is no service client, reserved fetch executor, `ctx.infer`, or `ctx.enrich`.

## Install optional local assets

```sh
bun run --cwd tools/recognition-automations setup
```

`runtime/` is deliberately not a workspace package. Setup installs the image, PDF.js, ONNX, FFmpeg, and Transformers.js dependencies there, then downloads pinned weights and auxiliary files beneath `runtime/models/`. A root `bun install` therefore does not acquire optional native ML dependencies or weights.

Handlers resolve a sibling `runtime/` by default. Set `CENTRAID_AUTOMATION_RUNTIME_DIR` to another absolute or working-directory-relative local asset directory when the installed handler lives elsewhere. This is only an asset-location override; no inference request crosses a service boundary. Transcript decoding uses a short-lived, handler-owned FFmpeg child with stdin/stdout pipes before the handler runs Whisper in its own worker; no daemon, socket, or remote endpoint exists.

See `LICENSES.md` and `models.lock.json` for model versions, hashes, upstream locations, and licences.

## Capability status

- `embed-image` / `embed-text`: bundled CLIP implementation and local weights.
- `photo-ocr`: bundled PP-OCRv4 orchestration and model implementation for images and PDFs. The handler loads the shared runtime's pinned PDF.js; pages use embedded text where present and locally render image-only pages for OCR.
- `faces`: bundled YuNet detection and SFace recognition.
- `transcript`: bundled Whisper tiny.en ASR. The handler decodes bounded audio or video locally with the runtime's pinned FFmpeg binary, then runs quantized ONNX inference without network access.

## Tests

```sh
bun run --cwd tools/recognition-automations test
bun run --cwd tools/recognition-automations typecheck
bun run --cwd tools/recognition-automations setup
bun run test:enrich:live
```

The default suite uses injected model functions and pure tokenizer/CTC/NMS/geometry tests, so it does not require setup. The weekly/release live lane runs pinned real weights and committed fixtures, including image/PDF OCR, embedding cosine tolerance, face count/geometry, and lock/licence integrity. Missing live evidence is grey rather than green.
