/**
 * Snapshot-style tests naming scaffold-defaults.ts (issue #545 B13).
 */

import { describe, expect, it } from "vitest";

import {
  AUTOMATIONS_README,
  DEFAULT_APP_CSS,
  README_TEMPLATE,
} from "./scaffold-defaults.js";

describe("scaffold-defaults", () => {
  it("DEFAULT_APP_CSS is a design-token-driven stylesheet (no hex literals)", () => {
    expect(DEFAULT_APP_CSS).toContain("--app-hue");
    expect(DEFAULT_APP_CSS).toContain("--accent");
    expect(DEFAULT_APP_CSS).toContain("prefers-reduced-motion");
    expect(DEFAULT_APP_CSS).toContain("720px");
    // Hit targets use rem (≥ 44px at default root) rather than raw px.
    expect(DEFAULT_APP_CSS).toContain("min-height: 2.75rem");
    // Colors come from CSS vars; only ink-inv fallbacks keep a bare #fff.
    expect(DEFAULT_APP_CSS).toContain("var(--accent)");
    expect(DEFAULT_APP_CSS).toContain("var(--text-inv, #fff)");
    expect(DEFAULT_APP_CSS).toMatchSnapshot();
  });

  it("README_TEMPLATE interpolates the app id into layout paths", () => {
    const md = README_TEMPLATE("todos");
    expect(md).toMatch(/^# todos\n/u);
    expect(md).toContain("/centraid/todos/");
    expect(md).toContain("app.json");
    expect(md).toContain("automations/");
    expect(md).toMatchSnapshot();
  });

  it("AUTOMATIONS_README documents the per-automation folder shape", () => {
    expect(AUTOMATIONS_README).toContain("automation.json");
    expect(AUTOMATIONS_README).toContain("handler.js");
    expect(AUTOMATIONS_README).toMatchSnapshot();
  });
});
