import { describe, expect, test } from "vitest";

import { replicaScopeDisposition } from "./shell-session.js";

// THE SCOPE'S SURVIVAL LAW (#922 C6). A replica session survives 30 s idle —
// `warm` is that grace — and gives its storage back when the page is hidden or
// frozen, which is the browser's own memory-pressure signal. A scope a screen
// still holds is never closed under it; it closes when its holder releases,
// and under a hidden page that release skips the grace.

describe("replica scope disposition", () => {
  test("a released scope stays warm for the idle grace while the page is visible", () => {
    expect(replicaScopeDisposition("visible", 0)).toBe("warm");
  });

  test("a hidden or frozen page gives the storage back at once", () => {
    expect(replicaScopeDisposition("hidden", 0)).toBe("close");
    expect(replicaScopeDisposition("frozen", 0)).toBe("close");
  });

  test("a scope a screen still holds is never closed under it", () => {
    for (const page of ["visible", "hidden", "frozen"] as const) {
      expect(replicaScopeDisposition(page, 1)).toBe("hold");
    }
  });
});
