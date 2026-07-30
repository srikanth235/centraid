import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as TypeImport_bmsl46 from "../../gateway-client.js";
import type * as TypeImport_t83a9s from "./useAppearance.js";

const { getUserPrefs, saveUserPrefs } = vi.hoisted(() => ({
  getUserPrefs: vi.fn<typeof TypeImport_bmsl46.getUserPrefs>(),
  saveUserPrefs: vi.fn<typeof TypeImport_bmsl46.saveUserPrefs>(),
}));
vi.mock(import("../../gateway-client.js") as Promise<unknown>, () => ({
  getUserPrefs,
  saveUserPrefs,
}));

// Mirrors the CACHE_KEY in useAppearance.ts — bumped for #608 group P.
const CACHE_KEY = "appearance.v2";

/** A controllable `prefers-color-scheme` for the `system` mode. */
function stubScheme(light: boolean): { set: (next: boolean) => void } {
  const listeners = new Set<() => void>();
  let isLight = light;
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return isLight;
    },
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }));
  return {
    set: (next) => {
      isLight = next;
      for (const fn of listeners) fn();
    },
  };
}

let useAppearance: typeof TypeImport_t83a9s.useAppearance;
let root: Root | null = null;
let host: HTMLElement | null = null;
// The client-local store is a plain module now; back it with an in-memory Map.
const store = vi.hoisted(() => new Map<string, unknown>());
vi.mock(import("./store.js"), () => ({
  Store: {
    get: <T,>(k: string, d: T): T => (store.has(k) ? (store.get(k) as T) : d),
    set: (k: string, v: unknown) => store.set(k, v),
  },
}));

describe("useAppearance", () => {
  beforeEach(async () => {
    store.clear();
    getUserPrefs.mockReset().mockResolvedValue({});
    saveUserPrefs.mockReset().mockResolvedValue({});
    ({ useAppearance } = await import("./useAppearance.js"));
  });

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    vi.unstubAllGlobals();
  });

  let ctl: ReturnType<typeof useAppearance>;
  function Harness(): null {
    const nextController = useAppearance();
    useEffect(() => {
      ctl = nextController;
    }, [nextController]);
    return null;
  }

  async function mount(): Promise<void> {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<Harness />);
    });
  }

  describe("useAppearance", () => {
    it("seeds from defaults + the Store cache and writes <html>", async () => {
      store.set(CACHE_KEY, { accent: "rose" });
      await mount();
      expect(ctl.prefs.accent).toBe("rose");
      expect(document.documentElement.dataset.theme).toBe(ctl.prefs.theme);
    });

    it("ignores a cache written in the pre-#608 shape", async () => {
      // The old shape persisted `bgL` and an accent on every save —
      // indistinguishable from an owner who chose them, and written inline
      // where they outranked the theme's own declarations. The bumped key
      // starts the new shape clean instead of inheriting that.
      store.set("appearance", { bgL: 5, accent: "rose", coolBlueCast: false });
      await mount();
      expect(ctl.prefs.bgL).toBeUndefined();
      expect(ctl.prefs.accent).toBeUndefined();
      expect(document.documentElement.style.getPropertyValue("--bg-l")).toBe(
        ""
      );
    });

    it("tracks the OS appearance while the mode is `system`", async () => {
      const scheme = stubScheme(true);
      store.set(CACHE_KEY, { themeMode: "system" });
      await mount();
      expect(ctl.prefs.theme).toBe("light");
      await act(async () => scheme.set(false));
      expect(ctl.prefs.theme).toBe("dark");
    });

    it("reconciles recognised keys from the gateway after mount", async () => {
      getUserPrefs.mockResolvedValue({ theme: "light", density: "comfy" });
      await mount();
      await act(async () => {
        await Promise.resolve();
      });
      expect(ctl.prefs.theme).toBe("light");
      expect(ctl.prefs.density).toBe("comfy");
    });

    it("setPrefs updates state, caches to Store, and mirrors to the gateway", async () => {
      await mount();
      await act(async () => {
        ctl.setPrefs({ accent: "violet" });
      });
      expect(ctl.prefs.accent).toBe("violet");
      expect(store.get(CACHE_KEY)).toMatchObject({ accent: "violet" });
      expect(saveUserPrefs).toHaveBeenCalledWith(
        expect.objectContaining({ accentKey: "violet" })
      );
    });

    it("re-resolves the applied theme when the caller sets a mode", async () => {
      stubScheme(true);
      await mount();
      await act(async () => {
        ctl.setPrefs({ themeMode: "system" });
      });
      expect(ctl.prefs.theme).toBe("light");
      expect(saveUserPrefs).toHaveBeenCalledWith(
        expect.objectContaining({ themeMode: "system", theme: "light" })
      );
    });
  });
});
