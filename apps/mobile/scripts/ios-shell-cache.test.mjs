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
    expect(decideShellPath({ ...base, appPresent: false }).path).toBe("build");
  });

  it("installs as-is when the banked shell already carries this commit's JS", () => {
    const verdict = decideShellPath({ ...base, bankedJs: base.currentJs });
    expect(verdict.path).toBe("install");
    expect(verdict.why).toMatch(/already carries/u);
  });

  it("injects when the native fingerprint matches and the JS does not", () => {
    const verdict = decideShellPath(base);
    expect(verdict.path).toBe("inject");
    expect(verdict.why).toContain(base.currentJs);
  });

  it("rebuilds rather than inject when no banked hermesc can compile the bundle", () => {
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
