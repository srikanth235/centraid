// export-path-traversal: the share-sheet filename is a leaf, never a path.
import path from "node:path";

import { describe, expect, it } from "vitest";

import { EXPORT_FOLDER, exportName } from "./docs-export-name";

const CACHE = "/cache";
const SHARE = path.posix.join(CACHE, EXPORT_FOLDER);

function stagedPath(title: string): string {
  return path.posix.normalize(
    path.posix.join(CACHE, EXPORT_FOLDER, exportName(title))
  );
}

function relativeToShare(title: string): string {
  return path.posix.relative(SHARE, stagedPath(title));
}

describe(exportName, () => {
  it("export-path-traversal: ../../x stays a single leaf inside the share folder", () => {
    expect(exportName("../../x")).toBe("x");
    expect(relativeToShare("../../x")).toBe("x");
    expect(stagedPath("../../x").startsWith(`${SHARE}/`)).toBe(true);
  });

  it("export-path-traversal: .. and ../ cannot climb out of the share folder", () => {
    expect(exportName("..")).toBe("document");
    expect(exportName("../")).toBe("document");
    expect(relativeToShare("..")).toBe("document");
    expect(relativeToShare("../")).toBe("document");
    expect(path.posix.relative(SHARE, stagedPath("..")).startsWith("..")).toBe(
      false
    );
  });

  it("export-path-traversal: nested .. segments never leave the share folder", () => {
    for (const title of [
      "foo/../../../passwd",
      "..\\..\\secret.md",
      "./../notes.md",
    ]) {
      const relative = relativeToShare(title);
      expect(relative.startsWith("..")).toBe(false);
      expect(path.posix.isAbsolute(relative)).toBe(false);
      expect(relative).not.toContain("/");
      expect(relative).not.toContain("\\");
    }
    expect(exportName("foo/../../../passwd")).toBe("passwd");
    expect(exportName("..\\..\\secret.md")).toBe("secret.md");
    expect(exportName("./../notes.md")).toBe("notes.md");
  });

  it("keeps an ordinary title and its extension for the receiving app", () => {
    expect(exportName("Lease.md")).toBe("Lease.md");
    expect(exportName("Q3 notes")).toBe("Q3 notes");
    expect(exportName("")).toBe("document");
  });
});
