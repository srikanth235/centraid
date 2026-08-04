import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_PINS } from "./launcherModel.js";
import type { ShellPage } from "./launcherModel.js";
import { usePins } from "./usePins.js";
import type { PinController } from "./usePins.js";

const store = vi.hoisted(() => new Map<string, unknown>());
vi.mock(import("./store.js"), () => ({
  Store: {
    get: <T,>(k: string, d: T): T => (store.has(k) ? (store.get(k) as T) : d),
    set: (k: string, v: unknown) => {
      store.set(k, v);
    },
    remove: (k: string) => {
      store.delete(k);
    },
    removeByPrefix: (prefix: string) => {
      for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
    },
  },
}));

let root: Root | null = null;
let host: HTMLElement | null = null;
let ctl: PinController;

function mount(): void {
  // Assigned from an EFFECT, never from render: a render that mutates
  // something outside itself is a side effect the react-compiler rightly
  // rejects, and it would tear under a re-render.
  function Probe(): null {
    const next = usePins();
    useEffect(() => {
      ctl = next;
    }, [next]);
    return null;
  }
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<Probe />));
}

describe(usePins, () => {
  beforeEach(() => store.clear());
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  it("seeds a first run from the shipped default set", () => {
    mount();
    for (const id of DEFAULT_PINS) expect(ctl.isPinned(id)).toBe(true);
    expect(ctl.isPinned("home")).toBe(true);
  });

  it("reads a stored map back instead of re-seeding", () => {
    store.set("launcher.pins", { starred: true });
    mount();
    expect(ctl.isPinned("starred")).toBe(true);
    expect(ctl.isPinned("assistant")).toBe(false);
  });

  it("persists a pin, because pins are user data", () => {
    mount();
    act(() => ctl.togglePin("starred"));
    expect(ctl.isPinned("starred")).toBe(true);
    expect(store.get("launcher.pins")).toMatchObject({ starred: true });
  });

  it("DELETES the key on unpin rather than storing a false", () => {
    // Absent means unpinned, so the blob stays the size of the member's actual
    // choices — and a destination added in a later build is simply not in it.
    mount();
    // A destination that IS in the default set — `assistant` left it when #707's
    // "the assistant is a pinned app, not a place" landed in the defaults, and
    // toggling an unpinned one would pin it rather than exercise the delete.
    act(() => ctl.togglePin("automations"));
    expect(ctl.isPinned("automations")).toBe(false);
    expect(Object.keys(store.get("launcher.pins") as object)).not.toContain(
      "automations"
    );
  });

  it("refuses to unpin Home — it is in the launcher by law", () => {
    mount();
    act(() => ctl.togglePin("home" as ShellPage));
    expect(ctl.isPinned("home")).toBe(true);
    expect(store.has("launcher.pins")).toBe(false);
  });
});
