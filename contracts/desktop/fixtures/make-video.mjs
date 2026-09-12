/*
 * Regenerate `arriving.webm`, the fixture the desktop's media e2e streams
 * (#1020 wave 3 lane F).
 *
 * The file is COMMITTED rather than generated at test time, and that is the
 * point: the e2e's claim is about `centraid://` serving a blob whose bytes are
 * still arriving, and a test that first has to encode a video depends on an
 * encoder the runner may not have. This container's only ffmpeg is the one
 * Playwright ships for screen recording, which is built `--disable-everything`
 * with exactly one decoder (mjpeg) and one encoder (libvpx) — so the frames are
 * JPEGs and the output is VP8/WebM, and neither choice is aesthetic.
 *
 * Run it only to change the fixture:
 *
 *     node contracts/desktop/fixtures/make-video.mjs \
 *       --ffmpeg /path/to/ffmpeg --out contracts/desktop/fixtures/arriving.webm
 *
 * Then re-record the digest in `arriving.json` (this script writes it) and say
 * in the receipt what changed. Nothing in CI runs this.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;

function flag(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

const FFMPEG = flag("ffmpeg", "/opt/pw-browsers/ffmpeg-1011/ffmpeg-linux");
const OUT = flag("out", path.join(HERE, "arriving.webm"));
const WIDTH = 160;
const HEIGHT = 120;
const FPS = 15;
/** Twenty seconds, so a seek to 70% lands well past a 30% prefix. */
const FRAMES = FPS * 20;

// `jpeg-js` is reached by path rather than imported by name: it is a
// transitive dependency of the repository's toolchain, not a declared one, and
// this script runs by hand. A missing module here is a clear error from a
// script nobody's build depends on.
const { default: jpeg } = await import(
  path.join(HERE, "../../../node_modules/jpeg-js/index.js")
);

const ffmpeg = spawn(
  FFMPEG,
  [
    "-f",
    "image2pipe",
    // The demuxer does not probe the codec out of a pipe, so it is named.
    "-c:v",
    "mjpeg",
    "-framerate",
    String(FPS),
    "-i",
    "pipe:0",
    "-c:v",
    "libvpx",
    "-b:v",
    "90k",
    "-deadline",
    "realtime",
    "-cpu-used",
    "8",
    // A keyframe every second, so a seek has somewhere to land.
    "-g",
    String(FPS),
    "-f",
    "webm",
    "-y",
    OUT,
  ],
  { stdio: ["pipe", "inherit", "inherit"] }
);
ffmpeg.stdin.on("error", () => undefined);

for (let frame = 0; frame < FRAMES; frame += 1) {
  const data = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const at = (WIDTH * y + x) << 2;
      // A moving gradient: every frame differs, so a decoder that produced the
      // same picture twice would be visible.
      data[at] = (frame * 7) % 256;
      data[at + 1] = (x + frame) % 256;
      data[at + 2] = (y * 3) % 256;
      data[at + 3] = 255;
    }
  }
  const encoded = jpeg.encode({ data, width: WIDTH, height: HEIGHT }, 80);
  if (!ffmpeg.stdin.write(encoded.data)) {
    // One frame at a time: the encoder's backpressure is the whole point, and
    // buffering three hundred JPEGs to "parallelise" a pipe would be slower as
    // well as pointless.
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      ffmpeg.stdin.once("drain", resolve);
    });
  }
}
ffmpeg.stdin.end();
const code = await new Promise((resolve) => {
  ffmpeg.on("exit", resolve);
});
if (code !== 0) throw new Error(`ffmpeg exited ${code}`);

const bytes = fs.readFileSync(OUT);
const digest = createHash("sha256").update(bytes).digest("hex");
fs.writeFileSync(
  path.join(HERE, "arriving.json"),
  `${JSON.stringify(
    {
      file: path.basename(OUT),
      sha256: digest,
      byte_size: bytes.length,
      media_type: "video/webm",
      width: WIDTH,
      height: HEIGHT,
      duration_seconds: FRAMES / FPS,
    },
    null,
    2
  )}\n`
);
process.stdout.write(`${digest}  ${bytes.length} bytes\n`);
