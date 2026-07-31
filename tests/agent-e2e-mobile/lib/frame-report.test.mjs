import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { parseFrameEvidence, readFrameEvidence } from "./frame-report.mjs";

/**
 * The frame-drop probe (`flows/scroll-frames.mjs`) needs a booted simulator, so
 * its parse is the only part that can be verified in CI without a device — and
 * a parser nobody has executed is precisely the thing that quietly returns zero
 * on the night it matters. These run in `bun run scripts:test`.
 *
 * The literal below is the exact string `formatFrameSample` produces
 * (apps/mobile/src/lib/perf/frame-sampler.ts), pinned by an assertion in
 * apps/mobile/src/lib/perf/frame-sampler.test.ts. If that assertion changes,
 * this file must fail.
 */
const CONTRACT_LINE =
  "frames=137 expected=241 elapsed=4016ms fps=34.11 targetHz=60 dropped=43.15%";

describe("parseFrameEvidence", () => {
  it("parses the contract line exactly as apps/mobile emits it", () => {
    const { report } = parseFrameEvidence([CONTRACT_LINE]);
    assert.deepEqual(report, {
      frames: 137,
      expected: 241,
      elapsedMs: 4016,
      fps: 34.11,
      targetHz: 60,
      dropped: 43.15,
      parse: "strict",
    });
  });

  it("parses the line as it appears escaped inside a Maestro hierarchy dump", () => {
    const hierarchy = JSON.stringify({
      attributes: { resourceId: "perf-frame-report", text: CONTRACT_LINE },
    });
    const { report } = parseFrameEvidence([hierarchy]);
    assert.equal(report.parse, "strict");
    assert.equal(report.dropped, 43.15);
    assert.equal(report.targetHz, 60);
  });

  it("keeps targetHz, because dropped% has a per-device denominator", () => {
    // 60 fps on a 120 Hz ProMotion display is a 50% drop, not a clean run. A
    // reader that only got `dropped` could not tell this from a 60 Hz device.
    const { report } = parseFrameEvidence([
      "frames=300 expected=600 elapsed=5000ms fps=60.00 targetHz=120 dropped=50.00%",
    ]);
    assert.equal(report.targetHz, 120);
    assert.equal(report.dropped, 50);
  });

  it("falls back to an independent read when the line is split or reformatted", () => {
    const mangled = `<text>dropped=12.50%</text>\n<text>targetHz=90</text>`;
    const { report } = parseFrameEvidence([mangled]);
    assert.equal(report.parse, "degraded");
    assert.equal(report.dropped, 12.5);
    assert.equal(report.targetHz, 90);
    // The fields the degraded path cannot recover are -1, never 0 — a zero
    // would be indistinguishable from a real measurement of zero.
    assert.equal(report.frames, -1);
    assert.equal(report.fps, -1);
  });

  it("returns null rather than zero when nothing matched", () => {
    // The whole point: "we could not see the frames" must not read as "no
    // frames were dropped". The flow fails the run on a null.
    const { report } = parseFrameEvidence([
      "<hierarchy>nothing here</hierarchy>",
    ]);
    assert.equal(report, null);
  });

  it("takes the newest report when a run wrote several", () => {
    const { report } = parseFrameEvidence([
      "frames=1 expected=2 elapsed=10ms fps=1.00 targetHz=60 dropped=50.00%",
      CONTRACT_LINE,
    ]);
    assert.equal(report.dropped, 43.15);
  });

  it("reports the highest People row index as a lower bound on seeded rows", () => {
    // Positional row ids are how the flow states its D6 volume: the real seeded
    // total is not observable from the device, but "we scrolled past at least
    // this many" is.
    const { peopleRowsObserved } = parseFrameEvidence([
      `id="people-directory-row-0" id="people-directory-row-7"`,
      `id="people-directory-row-41"`,
    ]);
    assert.equal(peopleRowsObserved, 42);
  });

  it("reports zero rows observed when People was never on screen", () => {
    const { peopleRowsObserved } = parseFrameEvidence([CONTRACT_LINE]);
    assert.equal(peopleRowsObserved, 0);
  });

  it("ignores the merge-picker's twin list, which is not the directory", () => {
    // `people-merge-directory-row-<n>` is the merge sheet, a different surface.
    // Counting it would inflate the claimed volume of the directory fling.
    const { peopleRowsObserved } = parseFrameEvidence([
      `id="people-merge-directory-row-900"`,
    ]);
    assert.equal(peopleRowsObserved, 0);
  });
});

describe("readFrameEvidence", () => {
  it("reads only files written since the phase began", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "frame-report-"));
    const debugDir = path.join(root, "maestro-debug", "07-fling-photos");
    await fs.mkdir(debugDir, { recursive: true });

    const stale = path.join(debugDir, "old-hierarchy.json");
    await fs.writeFile(
      stale,
      "frames=1 expected=2 elapsed=10ms fps=1.00 targetHz=60 dropped=99.00%"
    );
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(stale, old, old);

    const since = Date.now() - 5_000;
    await fs.writeFile(
      path.join(debugDir, "new-hierarchy.json"),
      CONTRACT_LINE
    );

    const { report } = await readFrameEvidence(root, since);
    assert.equal(
      report.dropped,
      43.15,
      "the previous phase's report must not leak forward"
    );

    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns null when the debug directory does not exist", async () => {
    const { report, peopleRowsObserved } = await readFrameEvidence(
      path.join(os.tmpdir(), "frame-report-absent-dir"),
      0
    );
    assert.equal(report, null);
    assert.equal(peopleRowsObserved, 0);
  });
});
