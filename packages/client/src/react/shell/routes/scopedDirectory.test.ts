import { describe, expect, it } from "vitest";

import { rejectScopedDirectory } from "./scopedDirectory.js";

describe(rejectScopedDirectory, () => {
  it("accepts absolute POSIX, Windows, and UNC roots", () => {
    expect(rejectScopedDirectory("/Users/me/project", [])).toBeNull();
    expect(rejectScopedDirectory("C:\\Users\\me\\project", [])).toBeNull();
    expect(rejectScopedDirectory("\\\\host\\share", [])).toBeNull();
  });

  it("rejects a relative path with an actionable message", () => {
    expect(rejectScopedDirectory("project/docs", [])).toContain(
      "absolute path"
    );
  });

  it("rejects a folder already shared with the conversation", () => {
    expect(rejectScopedDirectory("/a", ["/a"])).toContain("already shared");
  });

  it("rejects past the gateway cap of eight roots", () => {
    const full = Array.from({ length: 8 }, (_unused, i) => `/root-${i}`);
    expect(rejectScopedDirectory("/root-9", full)).toContain("At most 8");
  });
});
