// One read route, three surfaces (#821, spec §6–§7): the fork is a fact
// about the document's kind, decided by the SHARED kind model, plus the
// RN-safe inline-text decode and the honest status sentence.
import { describe, expect, it } from "vitest";

import {
  decodeTextDataUri,
  docBytesUrl,
  editedAgo,
  factsRows,
  readStatus,
  readSurfaceFor,
} from "./document-read-model";

describe(readSurfaceFor, () => {
  it("text kinds read on paper", () => {
    expect(
      readSurfaceFor({ media_type: "text/markdown", title: "notes.md" })
    ).toBe("reading");
    expect(readSurfaceFor({ media_type: "text/plain", title: "a.txt" })).toBe(
      "reading"
    );
  });

  it("renderable media kinds stand on the stage", () => {
    expect(
      readSurfaceFor({ media_type: "application/pdf", title: "lease.pdf" })
    ).toBe("stage");
    expect(
      readSurfaceFor({ media_type: "image/jpeg", title: "scan.jpg" })
    ).toBe("stage");
    expect(readSurfaceFor({ media_type: "audio/mp4", title: "memo.m4a" })).toBe(
      "stage"
    );
    expect(readSurfaceFor({ media_type: "video/mp4", title: "walk.mp4" })).toBe(
      "stage"
    );
  });

  it("kinds Docs cannot set get the facts panel — including by extension when the stored type is opaque", () => {
    expect(
      readSurfaceFor({
        media_type:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        title: "Deed of grant.docx",
      })
    ).toBe("facts");
    expect(
      readSurfaceFor({ media_type: "application/vnd.ms-excel", title: "x.xls" })
    ).toBe("facts");
    expect(
      readSurfaceFor({
        media_type: "application/octet-stream",
        title: "budget.xlsx",
      })
    ).toBe("facts");
    expect(readSurfaceFor({ media_type: null, title: "mystery.bin" })).toBe(
      "facts"
    );
  });
});

describe(decodeTextDataUri, () => {
  it("decodes the vault's own percent-encoded text mint", () => {
    const body = "# Notes\n\nCafé au lait — 3€";
    const uri = `data:text/markdown;charset=utf-8,${encodeURIComponent(body)}`;
    expect(decodeTextDataUri(uri)).toBe(body);
  });

  it("decodes base64 UTF-8 without atob", () => {
    expect(decodeTextDataUri("data:text/plain;base64,aMOpbGxvCg==")).toBe(
      "héllo\n"
    );
  });

  it("returns null for anything that is not a data URI", () => {
    expect(decodeTextDataUri("blob:abc")).toBeNull();
    expect(decodeTextDataUri(null)).toBeNull();
    expect(decodeTextDataUri("data:nope")).toBeNull();
  });
});

describe(docBytesUrl, () => {
  it("routes blob-backed bytes through the gateway, encoded", () => {
    expect(
      docBytesUrl(
        { content_id: "c 1", content_uri: "blob:sha" },
        "http://127.0.0.1:9",
        "vault a"
      )
    ).toBe("http://127.0.0.1:9/centraid/_gateway/blobs/vault%20a/c%201");
  });

  it("never builds a URL for inline bytes or a seat with no gateway", () => {
    expect(
      docBytesUrl(
        { content_id: "c1", content_uri: "data:text/plain,x" },
        "http://g",
        "v"
      )
    ).toBeNull();
    expect(
      docBytesUrl({ content_id: "c1", content_uri: "blob:s" }, undefined, "v")
    ).toBeNull();
  });
});

describe(readStatus, () => {
  const now = Date.parse("2026-08-18T12:00:00Z");

  it("interpolates the real chain count and the edited-ago clause", () => {
    expect(readStatus(7, "2026-08-18T10:00:00Z", now)).toBe(
      "Version 7 · edited 2 hours ago"
    );
  });

  it("withholds the version clause when no chain count exists", () => {
    expect(readStatus(null, "2026-08-18T11:59:40Z", now)).toBe(
      "edited moments ago"
    );
  });

  it("never claims who has opened it", () => {
    expect(readStatus(7, "2026-08-18T10:00:00Z", now)).not.toContain("opened");
  });

  it("editedAgo speaks days and yesterday", () => {
    expect(editedAgo("2026-08-17T10:00:00Z", now)).toBe("edited yesterday");
    expect(editedAgo("2026-08-10T10:00:00Z", now)).toBe("edited 8 days ago");
    expect(editedAgo("not a date", now)).toBe("");
  });
});

describe(factsRows, () => {
  it("states the kind, the size, the custody and the boundary — and marks missing bytes as a consequence", () => {
    const rows = factsRows(
      {
        media_type: "application/msword",
        title: "Deed.doc",
        byte_size: 880_000,
        custody_state: "missing",
      },
      "Missing — needs attention"
    );
    expect(rows.map((row) => row.key)).toStrictEqual([
      "Kind",
      "Size",
      "Where the bytes are",
      "What Docs does",
      "What Docs will not do",
    ]);
    expect(rows[0]?.value).toBe("Document");
    expect(rows[2]?.value).toBe("Missing — needs attention");
    expect(rows[2]?.net).toBe(true);
    expect(rows[4]?.value).toContain("converts nothing");
  });

  it("says 'not swept yet' rather than inventing a custody state", () => {
    const rows = factsRows(
      { media_type: "application/vnd.ms-excel", title: "b.xls" },
      null
    );
    expect(rows[2]?.value).toBe("not swept yet");
  });
});
