import { promises as fs } from "node:fs";
import path from "node:path";

const REPORT_LINE =
  /frames=(?<frames>\d+)\s+expected=(?<expected>\d+)\s+elapsed=(?<elapsed>\d+)ms\s+fps=(?<fps>[\d.]+)\s+targetHz=(?<targetHz>\d+)\s+dropped=(?<dropped>[\d.]+)%/u;
const DROPPED_ONLY = /dropped=(?<dropped>[\d.]+)%/u;
const TARGET_HZ_ONLY = /targetHz=(?<targetHz>\d+)/u;
const PEOPLE_ROW_INDEX = /people-directory-row-(?<index>\d+)/gu;

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

export async function readFrameEvidence(runDir, sinceMs) {
  const debugRoot = path.join(runDir, "maestro-debug");
  const files = await filesNewerThan(debugRoot, sinceMs);
  const texts = await Promise.all(
    files.map((entry) => fs.readFile(entry.file, "utf8").catch(() => ""))
  );
  return parseFrameEvidence(texts);
}

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
