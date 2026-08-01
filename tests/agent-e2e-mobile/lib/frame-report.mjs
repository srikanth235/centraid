import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Parse the mobile frame-sampler's readout out of Maestro's debug output
 * (issue #659 R3c).
 *
 * This lives in `lib/` rather than inside the flow because it is the one part
 * of the frame-drop probe that can be verified WITHOUT a booted simulator, and
 * a parser that has never been executed is exactly the kind of thing that
 * quietly returns zero on the night it matters. `frame-report.test.mjs` runs it
 * against synthetic debug trees in `bun run scripts:test`.
 *
 * The string it looks for is produced by `formatFrameSample` in
 * `apps/mobile/src/lib/perf/frame-sampler.ts` and pinned by an assertion in
 * `apps/mobile/src/lib/perf/frame-sampler.test.ts`:
 *
 *   frames=137 expected=241 elapsed=4016ms fps=34.11 targetHz=60 dropped=43.15%
 *
 * That test is the contract. If a different shape is needed, change it there.
 */

/** The exact line `formatFrameSample` emits. */
const REPORT_LINE =
  /frames=(?<frames>\d+)\s+expected=(?<expected>\d+)\s+elapsed=(?<elapsed>\d+)ms\s+fps=(?<fps>[\d.]+)\s+targetHz=(?<targetHz>\d+)\s+dropped=(?<dropped>[\d.]+)%/u;
/** Independent fallbacks, in case a change splits or escapes the line. */
const DROPPED_ONLY = /dropped=(?<dropped>[\d.]+)%/u;
const TARGET_HZ_ONLY = /targetHz=(?<targetHz>\d+)/u;
const PEOPLE_ROW_INDEX = /people-directory-row-(?<index>\d+)/gu;

/** Every file under `dir` modified since `sinceMs`, oldest first. */
async function filesNewerThan(dir, sinceMs) {
  const entries = await fs
    .readdir(dir, { withFileTypes: true })
    .catch(() => []);
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return filesNewerThan(full, sinceMs);
      const stat = await fs.stat(full).catch(() => null);
      if (!stat || stat.mtimeMs < sinceMs) return [];
      return [{ file: full, mtimeMs: stat.mtimeMs }];
    })
  );
  return nested.flat().sort((left, right) => left.mtimeMs - right.mtimeMs);
}

/**
 * Recover the newest frame report written since `sinceMs`, plus the highest
 * People row index seen. Returns `report: null` when nothing parsed — never a
 * zero, which the caller would be entitled to read as "no drops".
 * Consumed by tests/agent-e2e-mobile/flows/scroll-frames.mjs.
 */
export async function readFrameEvidence(runDir, sinceMs) {
  const debugRoot = path.join(runDir, "maestro-debug");
  const files = await filesNewerThan(debugRoot, sinceMs);
  const texts = await Promise.all(
    files.map((entry) => fs.readFile(entry.file, "utf8").catch(() => ""))
  );
  return parseFrameEvidence(texts);
}

/**
 * Pure core of `readFrameEvidence`, over already-read file contents in
 * oldest-first order. Exported so the contract can be tested without a device.
 * Consumed by frame-report.test.mjs.
 */
export function parseFrameEvidence(texts) {
  let report = null;
  let maxRowIndex = -1;
  for (const text of texts) {
    const strict = REPORT_LINE.exec(text);
    if (strict?.groups) {
      report = {
        frames: Number(strict.groups.frames),
        expected: Number(strict.groups.expected),
        elapsedMs: Number(strict.groups.elapsed),
        fps: Number(strict.groups.fps),
        targetHz: Number(strict.groups.targetHz),
        dropped: Number(strict.groups.dropped),
        parse: "strict",
      };
    } else {
      // Degraded read: the two fields that carry the meaning, found
      // independently. Better than failing a run over a formatting change, and
      // labelled so the artifact says which path produced the number.
      const dropped = DROPPED_ONLY.exec(text)?.groups?.dropped;
      const targetHz = TARGET_HZ_ONLY.exec(text)?.groups?.targetHz;
      if (dropped !== undefined) {
        report = {
          frames: -1,
          expected: -1,
          elapsedMs: -1,
          fps: -1,
          targetHz: targetHz === undefined ? -1 : Number(targetHz),
          dropped: Number(dropped),
          parse: "degraded",
        };
      }
    }
    for (const match of text.matchAll(PEOPLE_ROW_INDEX)) {
      maxRowIndex = Math.max(maxRowIndex, Number(match.groups?.index));
    }
  }
  return { report, peopleRowsObserved: maxRowIndex + 1 };
}
