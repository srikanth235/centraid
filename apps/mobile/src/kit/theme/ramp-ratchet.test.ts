// THE TYPE RAMP IS THE ONLY SOURCE OF TEXT METRICS.
//
// DESIGN.md, invariant 2: "Every app declares its primary register — reading or
// scanning — and draws every role from the same ramp." A style that types its
// own `fontSize` has left the ramp, and nothing downstream can tell: it does
// not appear in a token diff, `generate:theme` cannot reach it, and the native
// re-lowering (`nativeDelta`) that turns a web rung into a phone rung never
// runs on it.
//
// That is not hypothetical. Both bands hard-coded `fontSize: 11` — the
// handoff's CSS value for the `control` role — while native lowers the same
// role to 13/17/500 and has NO 11px rung at all. The most-used navigation
// labels in the product sat at a size the type system does not contain, and
// the only reason anyone noticed was a member saying the text looked thin.
//
// This test is a RATCHET, not a wall. The 200-odd existing offenders are listed
// below with their current counts; the assertion is that no file exceeds its
// entry and no unlisted file appears. Fixing one means lowering its number,
// which is a one-line diff a reviewer can see. The list may only shrink — an
// entry that reaches zero must be deleted, so the file can never regress.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

const SRC = new URL("../../", import.meta.url).pathname;

/**
 * Files still typing their own text metrics, and how many times.
 *
 * ONLY EVER LOWER A NUMBER. Two entries are permanent and marked so; every
 * other line is debt, and the register it belongs to is already in the ramp.
 */
const ALLOWED: Record<string, number> = {
  // — Permanent: these two OWN the ramp rather than consume it. —
  "kit/theme/tokens.generated.ts": 10, // the generated ramp itself
  "kit/theme/generate.ts": 1, // the generator that emits it

  // — Debt. Migrate to `t(<role>)` and lower the number. —
  "ErrorBoundary.tsx": 3,
  "apps/agenda/AgendaCreateModal.tsx": 7,
  "apps/agenda/AgendaEvent.tsx": 14,
  "apps/agenda/AgendaEventEditor.tsx": 7,
  "apps/agenda/AgendaHome.styles.ts": 16,
  "apps/assistant/Assistant.styles.ts": 1,
  "apps/automations/AutomationThread.tsx": 1,
  "apps/automations/Automations.styles.ts": 5,
  "apps/docs/DocsHome.styles.ts": 15,
  "apps/docs/DocsItemActions.tsx": 4,
  "apps/docs/DocumentViewer.tsx": 2,
  "apps/insights/GatewayAlerts.tsx": 1,
  "apps/insights/Insights.styles.ts": 18,
  "apps/notes/NotesHome.styles.ts": 18,
  "apps/people/PeopleHome.styles.ts": 6,
  "apps/photos/PhotosMoreSheet.tsx": 1,
  "apps/tally/TallyHome.styles.ts": 4,
  "apps/tasks/TasksHome.tsx": 4,
  "kit/components/AudiencePlacementSheet.tsx": 2,
  "kit/perf/FrameProbe.tsx": 1,
  "kit/replica/ReplicaStateCard.tsx": 3,
  "kit/replica/ReplicaStatusBar.tsx": 13,
  "kit/security/AppLock.tsx": 1,
  "kit/theme/index.ts": 1,
  "screens/Capture.tsx": 9,
  "screens/PhoneStorage.tsx": 8,
  "screens/Settings.tsx": 1,
  "screens/home/AllAppsSheet.tsx": 2,
  "screens/home/HomeBand.tsx": 1, // the More "···" glyph — geometry, not text
  "screens/home/SearchOverlay.tsx": 2,
  "screens/home/TileBody.tsx": 5,
  "screens/home/VaultHeader.tsx": 1,
  "screens/home/VaultsSwitcher.tsx": 4,
  "screens/onboarding-styles.ts": 13,
  "screens/scan-ui.tsx": 7,
};

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, found);
    } else if (
      /\.tsx?$/u.test(entry) &&
      !/\.test\.tsx?$/u.test(entry) &&
      !full.includes("/test/")
    ) {
      found.push(full);
    }
  }
  return found;
}

function countFontSizes(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of sourceFiles(SRC)) {
    const hits = readFileSync(file, "utf8").match(/\bfontSize:/gu)?.length ?? 0;
    if (hits > 0) counts.set(path.relative(SRC, file), hits);
  }
  return counts;
}

describe("text metrics come from the ramp, never from a literal", () => {
  const counts = countFontSizes();

  test("no file types more `fontSize` literals than its allowance", () => {
    const over = [...counts]
      .filter(([file, n]) => n > (ALLOWED[file] ?? 0))
      .map(([file, n]) => `${file}: ${n} (allowed ${ALLOWED[file] ?? 0})`);
    expect(
      over,
      "Draw the role with `t(<role>)` instead of typing a size. If you are " +
        "certain this is geometry rather than text, raise the entry and say " +
        "why in a comment beside it."
    ).toStrictEqual([]);
  });

  test("no new file starts typing its own text metrics", () => {
    expect(
      [...counts.keys()].filter((file) => !(file in ALLOWED))
    ).toStrictEqual([]);
  });

  // The ratchet only ratchets if it tightens. A file that has been migrated
  // must lose its entry, or it silently re-earns the right to regress.
  test("the allowance never outruns the debt it describes", () => {
    const slack = Object.entries(ALLOWED)
      .filter(([file, n]) => (counts.get(file) ?? 0) < n)
      .map(([file, n]) => `${file}: allows ${n}, has ${counts.get(file) ?? 0}`);
    expect(
      slack,
      "Lower (or delete) these entries — the work is already done."
    ).toStrictEqual([]);
  });

  test("both bands draw their labels from the ramp", () => {
    for (const band of [
      "screens/home/HomeBand.tsx",
      "apps/photos/PhotosBand.tsx",
    ]) {
      const source = readFileSync(path.join(SRC, band), "utf8");
      expect(source, `${band} must draw the control role`).toContain(
        't("control")'
      );
    }
  });
});
