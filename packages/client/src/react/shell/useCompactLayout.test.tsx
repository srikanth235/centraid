import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { COMPACT_MAX_WIDTH, useCompactLayout } from "./useCompactLayout.js";

// A controllable MediaQueryList stand-in: jsdom has no layout, so the only
// honest way to test a breakpoint hook is to own the matcher and fire the
// change ourselves.
function stubMatchMedia(initial: boolean): { set: (v: boolean) => void } {
  let matches = initial;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    // A getter, not a snapshot: the hook re-reads `.matches` from the list it
    // subscribed to, so a captured boolean would never change.
    get matches() {
      return matches;
    },
    media: query,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }));
  return {
    set: (v: boolean) => {
      matches = v;
      const fns = Array.from(listeners);
      act(() => {
        for (const fn of fns) fn();
      });
    },
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

/** Renders the hook's answer into the DOM and reads it back, rather than
 *  writing to a captured variable (which the react-compiler lint rightly
 *  rejects — a render must not mutate anything outside itself). */
function renderProbe(): () => boolean {
  function Probe(): string {
    return useCompactLayout() ? "compact" : "docked";
  }
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<Probe />));
  return () => host?.textContent === "compact";
}

describe("useCompactLayout suite", () => {
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    vi.unstubAllGlobals();
  });

  describe(useCompactLayout, () => {
    it("reports the breakpoint on first paint, with no flash of the wrong layout", () => {
      stubMatchMedia(true);
      expect(renderProbe()()).toBe(true);
    });

    it("follows the viewport across the breakpoint in both directions", () => {
      const mq = stubMatchMedia(false);
      const isCompact = renderProbe();
      expect(isCompact()).toBe(false);
      mq.set(true);
      expect(isCompact()).toBe(true);
      mq.set(false);
      expect(isCompact()).toBe(false);
    });

    it("stays docked where matchMedia is absent (SSR / bare test host)", () => {
      vi.stubGlobal("matchMedia", undefined);
      expect(renderProbe()()).toBe(false);
    });
  });

  // The breakpoint is necessarily written twice — a CSS module cannot read a
  // JS constant. If they drift, the shell mounts a scrim over a docked rail
  // (or leaves a drawer with no way to dismiss it), so pin them together.
  it("agrees with the drawer breakpoint in chrome.module.css", () => {
    // vitest runs this file from two different working directories — the
    // per-package suite (packages/client) and the repo-root diff-coverage run
    // — so the path is resolved against both rather than assuming either. A
    // `?raw` import can't stand in here: the CSS-modules transform claims
    // `.module.css` and hands back the class-name proxy, not the source.
    const candidates = [
      "src/react/shell/chrome.module.css",
      "packages/client/src/react/shell/chrome.module.css",
    ].map((rel) => path.resolve(process.cwd(), rel));
    const cssPath = candidates.find((p) => existsSync(p));
    expect(
      cssPath,
      `chrome.module.css not found from ${process.cwd()}`
    ).toBeDefined();
    const css = readFileSync(cssPath!, "utf8");
    const widths = [
      ...css.matchAll(/@media \(max-width: (?<px>\d+)px\)/gu),
    ].map((m) => Number(m.groups?.px));
    expect(widths.length).toBeGreaterThan(0);
    expect(new Set(widths)).toStrictEqual(new Set([COMPACT_MAX_WIDTH]));
  });
});
