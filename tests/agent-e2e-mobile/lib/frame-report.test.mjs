import { mkdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

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
 *
 * Runner: VITEST, like its siblings in `tests/agent-e2e-shared/` — this
 * directory is inside `scripts/test-report/vitest.config.ts`'s project glob, so
 * a `node:test` file here registers under two runners and vitest reports
 * "No test suite found" while the assertions run invisibly under the other one.
 * One runner, per TESTING.md.
 */

const CONTRACT_LINE =
  "frames=137 expected=241 elapsed=4016ms fps=34.11 targetHz=60 dropped=43.15%";

describe("parseFrameEvidence", () => {
  test("parses the contract line exactly as apps/mobile emits it", () => {
    const { report } = parseFrameEvidence([CONTRACT_LINE]);
    expect(report).toStrictEqual({
      frames: 137,
      expected: 241,
      elapsedMs: 4016,
      fps: 34.11,
      targetHz: 60,
      dropped: 43.15,
      parse: "strict",
    });
  });

  test("parses the line as it appears escaped inside a Maestro hierarchy dump", () => {
    const hierarchy = JSON.stringify({
      attributes: { resourceId: "perf-frame-report", text: CONTRACT_LINE },
    });
    const { report } = parseFrameEvidence([hierarchy]);
    expect(report.parse).toBe("strict");
    expect(report.dropped).toBe(43.15);
    expect(report.targetHz).toBe(60);
  });

  test("keeps targetHz, because dropped% has a per-device denominator", () => {
    // 60 fps on a 120 Hz ProMotion display is a 50% drop, not a clean run. A
    // reader that only got `dropped` could not tell this from a 60 Hz device.
    const { report } = parseFrameEvidence([
      "frames=300 expected=600 elapsed=5000ms fps=60.00 targetHz=120 dropped=50.00%",
    ]);
    expect(report.targetHz).toBe(120);
    expect(report.dropped).toBe(50);
  });

  test("falls back to an independent read when the line is split or reformatted", () => {
    const mangled = `<text>dropped=12.50%</text>\n<text>targetHz=90</text>`;
    const { report } = parseFrameEvidence([mangled]);
    expect(report.parse).toBe("degraded");
    expect(report.dropped).toBe(12.5);
    expect(report.targetHz).toBe(90);
    // The fields the degraded path cannot recover are -1, never 0 — a zero
    // would be indistinguishable from a real measurement of zero.
    expect(report.frames).toBe(-1);
    expect(report.fps).toBe(-1);
  });

  test("returns null rather than zero when nothing matched", () => {
    // The whole point: "we could not see the frames" must not read as "no
    // frames were dropped". The flow fails the run on a null.
    const { report } = parseFrameEvidence([
      "<hierarchy>nothing here</hierarchy>",
    ]);
    expect(report).toBe(null);
  });

  test("takes the newest report when a run wrote several", () => {
    const { report } = parseFrameEvidence([
      "frames=1 expected=2 elapsed=10ms fps=1.00 targetHz=60 dropped=50.00%",
      CONTRACT_LINE,
    ]);
    expect(report.dropped).toBe(43.15);
  });

  test("reports the highest People row index as a lower bound on seeded rows", () => {
    // Positional row ids are how the flow states its D6 volume: the real seeded
    // total is not observable from the device, but "we scrolled past at least
    // this many" is.
    const { peopleRowsObserved } = parseFrameEvidence([
      `id="people-directory-row-0" id="people-directory-row-7"`,
      `id="people-directory-row-41"`,
    ]);
    expect(peopleRowsObserved).toBe(42);
  });

  test("reports zero rows observed when People was never on screen", () => {
    const { peopleRowsObserved } = parseFrameEvidence([CONTRACT_LINE]);
    expect(peopleRowsObserved).toBe(0);
  });

  test("ignores the merge-picker's twin list, which is not the directory", () => {
    // `people-merge-directory-row-<n>` is the merge sheet, a different surface.
    // Counting it would inflate the claimed volume of the directory fling.
    const { peopleRowsObserved } = parseFrameEvidence([
      `id="people-merge-directory-row-900"`,
    ]);
    expect(peopleRowsObserved).toBe(0);
  });
});

describe("readFrameEvidence", () => {
  test("reads only files written since the phase began", async () => {
    const root = await tempDir("frame-report-");
    const debugDir = path.join(root, "maestro-debug", "07-fling-photos");
    await mkdir(debugDir, { recursive: true });

    const stale = path.join(debugDir, "old-hierarchy.json");
    await writeFile(
      stale,
      "frames=1 expected=2 elapsed=10ms fps=1.00 targetHz=60 dropped=99.00%"
    );
    const old = new Date(Date.now() - 60_000);
    await utimes(stale, old, old);

    const since = Date.now() - 5_000;
    await writeFile(path.join(debugDir, "new-hierarchy.json"), CONTRACT_LINE);

    const { report } = await readFrameEvidence(root, since);
    expect(
      report.dropped,
      "the previous phase's report must not leak forward"
    ).toBe(43.15);
  });

  test("returns null when the debug directory does not exist", async () => {
    const { report, peopleRowsObserved } = await readFrameEvidence(
      path.join(tmpdir(), "frame-report-absent-dir"),
      0
    );
    expect(report).toBe(null);
    expect(peopleRowsObserved).toBe(0);
  });
});
