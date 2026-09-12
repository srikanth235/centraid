# `contracts/desktop/` — the desktop seat's fixtures

Files the desktop seat's tests read, committed so the claim does not depend on the machine that makes it ([#1020](https://github.com/srikanth235/centraid/issues/1020) wave 3, lane F).

| File | What it pins | Who reads it |
| --- | --- | --- |
| `socket-catalogue.json` | every **named statement** the seat socket will answer, with its projection, predicate and keyset | `crates/centraid/tests/no_listener.rs` (against `centraid seat --print-catalogue`), `desktop/renderer/src/apps/tally/fold.test.ts` |
| `fixtures/arriving.webm` | a 20-second VP8/WebM video, 227,977 bytes | `desktop/e2e/media-seek.e2e.ts` |
| `fixtures/arriving.json` | that file's `sha256`, byte size, media type and duration | the same, which refuses to run if the two disagree |
| `fixtures/make-video.mjs` | how to regenerate it | a person, by hand. Nothing in CI runs it |

## Why the catalogue is a fixture

The socket carries a statement **name** and the sidecar holds the shape, so the catalogue _is_ the read surface. Committing it makes three things checkable at once: that the binary still serves what it says (`centraid seat --print-catalogue` must equal this file), that every statement projects the two columns its keyset compares, and that the renderer's fold is tested against the columns it will really be handed rather than a list retyped in a test.

Regenerate it deliberately, and say in the receipt what changed:

```sh
cargo run -p centraid -- seat --print-catalogue > contracts/desktop/socket-catalogue.json
bun run format
```

## Why the video is committed rather than generated

The e2e's claim is that `centraid://` serves a blob whose bytes are _still arriving_. A test that first has to encode a video depends on an encoder the runner may not have — and this container's only ffmpeg is the one Playwright ships for screen recording, built `--disable-everything` with exactly one decoder (mjpeg) and one encoder (libvpx). So the frames are JPEGs and the output is VP8/WebM, neither choice is aesthetic, and the result is committed.

The e2e writes a prefix of it to `<data-dir>/blobs/<digest>.partial` beside a declared `<digest>.total`, appends the rest on a timer, and renames the prefix to `<digest>` when the last byte lands — which is what an `iroh-blobs` transfer does when a blob verifies. That layout is documented as normative in `crates/centraid/src/cmd/seat/blob.rs`, not invented here.
