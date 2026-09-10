// THE SHELL'S ROOM SWEEP (#1015, Wave 2).
//
// Two claims a mounted test cannot make cheaply for thirty screens, and that
// a review would have to make by eye:
//
//  1. every shell screen's root is one of the six rooms — the rule the other
//     four rules in `scripts/lint-mobile-rooms.mjs` exist to make unnecessary;
//  2. no shell file writes `backTo` or `current` as a string. Audit B7 was
//     thirteen screens saying `backTo="All"`, twelve of them wrong in the
//     visible label and the spoken one together. Inside a room the prop is a
//     `PlaceRef` and a literal cannot typecheck, so this catches the `as` cast
//     that would talk its way around the brand.
//
// It reads the lint's own rules rather than a second copy of them: one
// definition of "a room", checked here per file and reported tree-wide there.

import path from "node:path";

import { describe, expect, it } from "vitest";

import { lintTree } from "../../../../scripts/lint-mobile-rooms.mjs";

const REPO = path.resolve(import.meta.dirname, "../../../..");

/** The trees this lane owns. Every other tree is another lane's wave. */
const SHELL = [
  "apps/mobile/src/screens/",
  "apps/mobile/src/apps/assistant/",
  "apps/mobile/src/apps/automations/",
  "apps/mobile/src/apps/insights/",
];

/**
 * Files this lane has migrated. A file lands here the commit it becomes a
 * room, and NEVER leaves — the list only grows, so a screen cannot quietly
 * fall back out of its room later.
 */
const MIGRATED = [
  "apps/mobile/src/apps/automations/Automations.tsx",
  "apps/mobile/src/apps/insights/GatewayAlerts.tsx",
  "apps/mobile/src/apps/insights/Insights.tsx",
  "apps/mobile/src/apps/insights/GatewayAlerts.tsx",
  "apps/mobile/src/apps/insights/Insights.tsx",
  "apps/mobile/src/screens/Approvals.tsx",
  "apps/mobile/src/screens/SignalNotification.tsx",
  "apps/mobile/src/screens/SystemOnPhone.tsx",
  "apps/mobile/src/screens/connectors/Connectors.tsx",
  "apps/mobile/src/screens/data/Data.tsx",
  "apps/mobile/src/screens/devices/Devices.tsx",
];

const findings = lintTree(REPO).findings.filter((finding) =>
  SHELL.some((tree) => finding.path.startsWith(tree))
);

describe("the shell's rooms", () => {
  it("roots every migrated screen in one of the six rooms", () => {
    const offenders = findings
      .filter((finding) => finding.rule === "screen-root")
      .map((finding) => finding.path);
    expect(offenders.filter((file) => MIGRATED.includes(file))).toStrictEqual(
      []
    );
  });

  it("writes no back destination down as a string, anywhere in the shell", () => {
    expect(
      findings.filter((finding) => finding.rule === "back-literal")
    ).toStrictEqual([]);
  });

  it("hands every gutter to the room in the migrated screens", () => {
    const offenders = findings
      .filter((finding) => finding.rule === "page-margin")
      .map((finding) => finding.path);
    expect(offenders.filter((file) => MIGRATED.includes(file))).toStrictEqual(
      []
    );
  });
});
