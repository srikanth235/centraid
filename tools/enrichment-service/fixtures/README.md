# Live-model fixtures

- `ocr-golden.svg` is a repository-owned synthetic OCR fixture.
- `opencv-lena.jpg.base64` is OpenCV's `samples/data/lena.jpg` at commit `77dfa297d08fdecdc509fc01ad92a2e9ec776a57`, SHA-256 `7de7ed51a1594fff247f4cae2301eceacf5313d6011e37b4a4c8733f7bb72c07`. OpenCV 4.x is Apache-2.0; the upstream licence is recorded in `LICENSES.md`.

The JPEG stays base64-encoded so repository edits remain text-only. The weekly live test decodes it in memory.
