import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EMPTY_HEALTH, ERROR_HEALTH } from "../../surface-copy.js";
import {
  clearRouteSignals,
  clearVitals,
  lastReadLine,
  LOADING_COUNT_LINE,
  publishRouteSignals,
  publishRouteVerbs,
  publishVitals,
  readAllVerbs,
  readAllVitals,
  readVitals,
  resetVitals,
  subscribeVitals,
} from "./routeVitals.js";
import { readRouteHealth, resetStatus } from "./statusChannel.js";

describe("route vitals", () => {
  beforeEach(() => {
    resetVitals();
    resetStatus();
  });
  afterEach(() => {
    resetVitals();
    resetStatus();
  });

  it("starts silent, so the bar falls back to the page's static definition", () => {
    expect(readVitals("approvals")).toBeUndefined();
  });

  it("carries the page's own count line in ready, full and empty", () => {
    publishVitals("approvals", {
      count: "3 decisions waiting · 2 standing grants",
      state: "ready",
    });
    expect(readVitals("approvals")).toStrictEqual({
      count: "3 decisions waiting · 2 standing grants",
      state: "ready",
    });
  });

  it("owns the loading line itself, whatever the route passed", () => {
    publishVitals("atlas", { count: "9 kinds", state: "loading" });
    expect(readVitals("atlas")?.count).toBe(LOADING_COUNT_LINE);
    expect(LOADING_COUNT_LINE).toBe("Reading from the gateway");
  });

  it("says when the page was last right, in the error state", () => {
    const at = new Date(2026, 7, 12, 9, 12);
    publishVitals("insights", { lastReadAt: at, state: "error" });
    expect(readVitals("insights")?.count).toBe(lastReadLine(at));
    expect(lastReadLine(at)).toContain("Last read at");
    publishVitals("connectors", { state: "error" });
    expect(readVitals("connectors")?.count).toBe("");
  });

  it("wakes subscribers on a change, and stays quiet on a repeat", () => {
    const seen = vi.fn<() => void>();
    const off = subscribeVitals(seen);
    publishVitals("household", { count: "4 devices", state: "ready" });
    publishVitals("household", { count: "4 devices", state: "ready" });
    expect(seen).toHaveBeenCalledOnce();
    off();
    publishVitals("household", { count: "8 devices", state: "full" });
    expect(seen).toHaveBeenCalledOnce();
  });

  it("hands the bar one snapshot object, replaced rather than mutated", () => {
    const before = readAllVitals();
    publishVitals("atlas", { count: "9 kinds", state: "ready" });
    expect(readAllVitals()).not.toBe(before);
  });

  it("drops a page's vitals and verbs when its route unmounts", () => {
    publishVitals("atlas", { count: "9 kinds", state: "ready" });
    publishRouteVerbs("atlas", { onSecondary: vi.fn<() => void>() });
    clearVitals("atlas");
    expect(readVitals("atlas")).toBeUndefined();
    expect(readAllVerbs().atlas).toBeUndefined();
  });

  describe("publishRouteSignals — one call, both channels", () => {
    it("sets the count line and the health line together", () => {
      publishRouteSignals("automations", {
        count: "6 automations · 1 failing · 1 paused",
        health: {
          action: { label: "Open the failure", run: vi.fn<() => void>() },
          detail: "Weekly digest has failed its last 3 runs, since 4 August.",
          label: "1 automation is failing",
        },
        state: "ready",
        tone: "net",
      });
      expect(readVitals("automations")?.count).toBe(
        "6 automations · 1 failing · 1 paused"
      );
      expect(readRouteHealth()?.text).toBe(
        "1 automation is failing · Weekly digest has failed its last 3 runs, since 4 August."
      );
      expect(readRouteHealth()?.action?.label).toBe("Open the failure");
      expect(readRouteHealth()?.tone).toBe("net");
    });

    it("takes the generic sentence in empty, loading and error — and offers no verb there", () => {
      const health = {
        detail: "Its token expired on 9 August.",
        label: "Gmail needs re-authorization",
      };
      publishRouteSignals("connectors", { state: "empty", health });
      expect(readRouteHealth()).toStrictEqual({ text: EMPTY_HEALTH });
      publishRouteSignals("connectors", { state: "loading", health });
      expect(readRouteHealth()?.action).toBeUndefined();
      publishRouteSignals("connectors", { state: "error", health });
      expect(readRouteHealth()).toStrictEqual({ text: ERROR_HEALTH });
      expect(EMPTY_HEALTH).toBe("Nothing to attend to");
      expect(ERROR_HEALTH).toBe("This page could not load");
    });

    it("says nothing at all in ready when the route has no health to report", () => {
      publishRouteSignals("atlas", { count: "9 kinds", state: "ready" });
      expect(readRouteHealth()).toBeNull();
    });

    it("clears both channels on unmount", () => {
      publishRouteSignals("household", {
        count: "4 devices · 2 people · 1 pending",
        health: { detail: "Ana asked to connect.", label: "1 request pending" },
        state: "ready",
      });
      clearRouteSignals("household");
      expect(readVitals("household")).toBeUndefined();
      expect(readRouteHealth()).toBeNull();
    });
  });
});
