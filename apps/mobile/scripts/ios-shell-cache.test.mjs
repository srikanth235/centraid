// Spec for the iOS shell-cache decision (#915 Wave 2).
//
// The branch this covers is the one whose wrong answer is SILENT. A wrong
// `build` costs thirty macOS minutes and says so in the log. A wrong `install`
// drives another commit's JavaScript, passes, and publishes a green iOS verdict
// for a candidate nobody tested — which is the whole reason the cache key was
// allowed to carry `js` in the first place, and the risk dropping it takes on.

import { describe, expect, it } from "vitest";

import { decideShellPath } from "./ios-shell-cache.mjs";

const base = {
  cacheHit: true,
  appPresent: true,
  bankedJs: "aaaaaaaaaaaaaaaa",
  currentJs: "bbbbbbbbbbbbbbbb",
  hermescPresent: true,
};

describe("decideShellPath", () => {
  it("builds when nothing is banked for this native fingerprint", () => {
    expect(decideShellPath({ ...base, cacheHit: false }).path).toBe("build");
  });

  it("builds when the cache claims a hit but no app is on disk", () => {
    // A restored-but-empty directory is how a cache turns into a silent
    // no-install; the Android apk path names the same hazard.
    expect(decideShellPath({ ...base, appPresent: false }).path).toBe("build");
  });

  it("installs as-is when the banked shell already carries this commit's JS", () => {
    const verdict = decideShellPath({ ...base, bankedJs: base.currentJs });
    expect(verdict.path).toBe("install");
    expect(verdict.why).toMatch(/already carries/u);
  });

  it("injects when the native fingerprint matches and the JS does not", () => {
    // The whole point of dropping `js` from the cache key: a JS-only candidate
    // re-uses the shell instead of paying ~32 minutes to rebuild it.
    const verdict = decideShellPath(base);
    expect(verdict.path).toBe("inject");
    expect(verdict.why).toContain(base.currentJs);
  });

  it("rebuilds rather than inject when no banked hermesc can compile the bundle", () => {
    // `expo export:embed` writes PLAIN JS on purpose. Shipping that to a Hermes
    // app launches fine and makes every cold-start and frame number describe an
    // engine path no member has — a green lane measuring the wrong thing, which
    // is worse than a slow one.
    const verdict = decideShellPath({ ...base, hermescPresent: false });
    expect(verdict.path).toBe("build");
    expect(verdict.why).toMatch(/hermesc/u);
  });

  it("treats an unstamped shell as a mismatch, never as a match", () => {
    expect(decideShellPath({ ...base, bankedJs: undefined }).path).toBe(
      "inject"
    );
  });

  it("refuses to decide anything on an empty fingerprint", () => {
    expect(() => decideShellPath({ ...base, currentJs: "" })).toThrow(
      /unverifiable/u
    );
  });
});
