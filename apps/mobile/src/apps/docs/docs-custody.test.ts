import { describe, expect, test } from "vitest";

import {
  countLocalOnly,
  custodySentence,
  DOCS_CUSTODY_LABEL,
  marksLocalOnly,
} from "./docs-custody";
import type { DocCustodyState, NativeDocument } from "./docs-model";

function doc(custody?: DocCustodyState): NativeDocument {
  return {
    id: "d1",
    contentId: "c1",
    title: "Lease",
    mediaType: "application/pdf",
    byteSize: 42,
    modifiedAt: "2026-08-01T00:00:00.000Z",
    starred: false,
    trashed: false,
    ...(custody === undefined ? {} : { custody }),
  };
}

describe("docs-custody marksLocalOnly", () => {
  test("marks only local-only — the one state a member can lose something to", () => {
    expect(marksLocalOnly("local-only")).toBe(true);
  });

  test.each<DocCustodyState | undefined>([
    "replicated",
    "remote-only",
    "pending-offsite",
    "missing",
    undefined,
  ])("does not mark %s", (custody) => {
    expect(marksLocalOnly(custody)).toBe(false);
  });
});

describe("docs-custody countLocalOnly", () => {
  test("counts only the local-only rows in a set", () => {
    const documents = [
      doc("local-only"),
      doc("replicated"),
      doc("local-only"),
      doc("remote-only"),
      doc(),
    ];
    expect(countLocalOnly(documents)).toBe(2);
  });

  test("zero for an empty or all-normal set", () => {
    expect(countLocalOnly([])).toBe(0);
    expect(countLocalOnly([doc("replicated"), doc("remote-only")])).toBe(0);
  });
});

describe("docs-custody custodySentence", () => {
  // The per-item full story (DocumentViewer, on demand) — Photos' own
  // vocabulary, never a raw token and never a silent "local" guess.
  test.each<[DocCustodyState | undefined, string]>([
    ["local-only", "on this device only"],
    ["replicated", "backed up"],
    ["remote-only", "on the gateway"],
    ["pending-offsite", "backing up now"],
    ["missing", "missing — needs attention"],
    [undefined, "backup status unknown"],
  ])("%s reads as %s", (custody, expected) => {
    expect(custodySentence(custody)).toBe(expected);
  });

  test("never a raw custody token", () => {
    const tokens: (DocCustodyState | undefined)[] = [
      "local-only",
      "replicated",
      "remote-only",
      "pending-offsite",
      "missing",
      undefined,
    ];
    for (const token of tokens) {
      expect(custodySentence(token)).not.toBe(token);
    }
  });
});

describe("docs-custody accessibility label", () => {
  test("the row mark's label names the exception in words, for a screen reader", () => {
    expect(DOCS_CUSTODY_LABEL).toBe("not backed up");
  });
});
