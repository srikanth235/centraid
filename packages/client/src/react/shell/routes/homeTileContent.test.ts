import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadHomeTileContent } from "./homeTileContent.js";
import type { HomeTileReader } from "./homeTileContent.js";

vi.mock(import("../../blueprints/blob-auth.js"), () => ({
  BLOB_PREFIX: "/centraid/_vault/blobs" as const,
  authorizeBlobUrl: vi.fn<(pathname: string) => Promise<string>>(
    async (pathname: string) => `blob:${pathname}`
  ),
  blobAuthHeaders: vi.fn<() => Record<string, string>>(() => ({})),
  SCOPE_ATTR: "data-scope" as const,
}));

type Rows = Record<string, Record<string, unknown>[]>;

function readerOf(rows: Rows): HomeTileReader {
  return {
    read: vi.fn<HomeTileReader["read"]>(async (_appId, request) => {
      const found = rows[request.entity];
      if (!found) throw new Error(`no shape for ${request.entity}`);
      const matched = found.filter((values) =>
        (request.where ?? []).every(
          (clause) => values[clause.column] === clause.value
        )
      );
      return { rows: matched.map((values) => ({ values })) };
    }),
  };
}

const BRIEF = {
  balanceMinor: 2_500,
  currency: "USD",
  date: "2026-08-03",
  events: [{ at: "2026-08-03T14:00:00Z", id: "e1", title: "Dentist" }],
  newPhotos: 3,
  tasks: [],
};

describe("shell/routes/homeTileContent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("takes agenda and the tally figure from the brief the shell already has", async () => {
    const content = await loadHomeTileContent({
      brief: BRIEF,
      reader: readerOf({ "tally.expense": [{ id: "x1" }] }),
    });
    expect(content.agenda).toStrictEqual({ events: BRIEF.events, total: 1 });
    expect(content.tally).toStrictEqual({
      balanceMinor: 2_500,
      currency: "USD",
    });
  });

  it("has no tally at all when the ledger is empty, whatever the balance says", async () => {
    const content = await loadHomeTileContent({
      brief: { ...BRIEF, balanceMinor: 0 },
      reader: readerOf({ "tally.expense": [] }),
    });
    expect(content.tally).toBeUndefined();
  });

  it("returns nothing at all for an app whose read is refused", async () => {
    const content = await loadHomeTileContent({ reader: readerOf({}) });
    expect(content.docs).toBeUndefined();
    expect(content.people).toBeUndefined();
    expect(content.locker).toBeUndefined();
  });

  it("does not let one app's refused read blank the others", async () => {
    const content = await loadHomeTileContent({
      reader: readerOf({
        "locker.item": [{ compromised: 1, item_id: "i1" }],
      }),
    });
    expect(content.locker).toStrictEqual({ compromised: 1, total: 1 });
    expect(content.notes).toBeUndefined();
  });

  it("drops trashed and archived rows", async () => {
    const content = await loadHomeTileContent({
      reader: readerOf({
        "core.party": [
          { display_name: "Ada", kind: "person", party_id: "p1" },
          {
            deleted_at: "2026-08-01",
            display_name: "Ghost",
            kind: "person",
            party_id: "p2",
          },
        ],
      }),
    });
    expect(content.people).toStrictEqual({
      directory: [{ id: "p1", name: "Ada" }],
      total: 1,
    });
  });

  it("counts only people, not orgs and groups, on the people tile", async () => {
    const content = await loadHomeTileContent({
      reader: readerOf({
        "core.party": [
          { display_name: "Ada", kind: "person", party_id: "p1" },
          { display_name: "Acme", kind: "org", party_id: "p2" },
        ],
      }),
    });
    expect(content.people).toStrictEqual({
      directory: [{ id: "p1", name: "Ada" }],
      total: 1,
    });
  });

  it("counts OPEN tasks but carries the most recent completed one too", async () => {
    const content = await loadHomeTileContent({
      reader: readerOf({
        "schedule.task": [
          { status: "needs-action", task_id: "t1", title: "Renew passport" },
          { status: "in-process", task_id: "t2", title: "Pack" },
          {
            completed_at: "2026-08-01T00:00:00Z",
            status: "completed",
            task_id: "t3",
            title: "Old one",
          },
          {
            completed_at: "2026-08-02T00:00:00Z",
            status: "completed",
            task_id: "t4",
            title: "Book flights",
          },
        ],
      }),
    });
    expect(content.tasks).toStrictEqual({
      glance: { next: "", today: "" },
      rows: [
        { done: false, title: "Renew passport" },
        { done: false, title: "Pack" },
        { done: true, title: "Book flights" },
      ],
      total: 2,
    });
  });

  it("glances at today's pile and the next dated row", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const soon = new Date(Date.now() + 3 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const content = await loadHomeTileContent({
      reader: readerOf({
        "schedule.task": [
          {
            due_at: today,
            status: "needs-action",
            task_id: "t1",
            title: "Renew passport",
          },
          {
            due_at: today,
            status: "in-process",
            task_id: "t2",
            title: "Pack",
          },
          {
            due_at: soon,
            status: "needs-action",
            task_id: "t3",
            title: "Sign the transfer",
          },
          { status: "needs-action", task_id: "t4", title: "Someday" },
        ],
      }),
    });
    expect(content.tasks?.glance?.today).toBe("2 today");
    expect(content.tasks?.glance?.next).toContain("next · Sign the transfer");
  });

  it("takes the newest note and document by their own update stamps", async () => {
    const content = await loadHomeTileContent({
      reader: readerOf({
        "core.document": [
          { document_id: "d1", title: "Old lease", updated_at: "2026-01-01" },
          { document_id: "d2", title: "New lease", updated_at: "2026-07-01" },
        ],
        "knowledge.note": [
          { note_id: "n1", title: "Older", updated_at: "2026-02-01" },
          { note_id: "n2", title: "Reading list", updated_at: "2026-08-01" },
        ],
      }),
    });
    expect(content.docs).toStrictEqual({ title: "New lease", total: 2 });
    expect(content.notes).toStrictEqual({
      at: "2026-08-01",
      line: "Reading list",
      total: 2,
    });
  });

  it("builds thumbnails only for assets whose bytes are actually in the vault", async () => {
    const content = await loadHomeTileContent({
      reader: readerOf({
        "core.content_item": [
          { content_id: "c1", content_uri: "blob:sha256-a" },
          { content_id: "c2", content_uri: "https://example.test/remote.jpg" },
        ],
        "media.asset": [
          { asset_id: "a1", captured_at: "2026-08-01", content_id: "c1" },
          { asset_id: "a2", captured_at: "2026-08-02", content_id: "c2" },
        ],
      }),
    });
    expect(content.photos).toStrictEqual({
      thumbs: ["blob:/centraid/_vault/blobs/c1?variant=thumb"],
      total: 2,
    });
  });

  it("falls back to the brief's photo count when the mosaic read is refused", async () => {
    const content = await loadHomeTileContent({
      brief: BRIEF,
      reader: readerOf({}),
    });
    expect(content.photos).toStrictEqual({ thumbs: [], total: 3 });
  });

  it("never sends a purpose on a replica read — it selects the SHAPE, not the reason", async () => {
    const reader = readerOf({ "knowledge.note": [{ title: "n" }] });
    await loadHomeTileContent({ reader });
    expect(vi.mocked(reader.read).mock.calls.length).toBeGreaterThan(0);
    for (const [, request] of vi.mocked(reader.read).mock.calls)
      expect(request.purpose).toBeUndefined();
  });

  it("paints the ORIGINAL when a photo has no thumb derivative yet", async () => {
    const { authorizeBlobUrl } = await import("../../blueprints/blob-auth.js");
    vi.mocked(authorizeBlobUrl).mockImplementation(async (pathname: string) =>
      pathname.includes("variant=thumb") ? null : `blob:${pathname}`
    );
    const content = await loadHomeTileContent({
      reader: readerOf({
        "core.content_item": [{ content_id: "c1", content_uri: "blob:sha" }],
        "media.asset": [
          { asset_id: "a1", captured_at: "2026-08-01", content_id: "c1" },
        ],
      }),
    });
    expect(content.photos).toStrictEqual({
      thumbs: ["blob:/centraid/_vault/blobs/c1"],
      total: 1,
    });
  });

  it("decodes the doc's inline markdown body into a stripped, word-cut excerpt", async () => {
    const body =
      "# New lease\n\nThe **landlord** agreed to the [terms](https://example.test) " +
      "we sent over, including the longer notice period and the repainting of " +
      "the hallway before the first of the month arrives.\n\n- deposit\n- keys\n";
    const content = await loadHomeTileContent({
      reader: readerOf({
        "core.content_item": [
          {
            content_id: "c-doc",
            content_uri: `data:text/markdown;charset=utf-8,${encodeURIComponent(body)}`,
            media_type: "text/markdown",
          },
        ],
        "core.document": [
          {
            current_content_id: "c-doc",
            document_id: "d1",
            title: "New lease",
            updated_at: "2026-07-01",
          },
        ],
      }),
    });
    expect(content.docs).toStrictEqual({
      excerpt:
        "The landlord agreed to the terms we sent over, including the longer " +
        "notice period and the repainting of the hallway before the first of " +
        "the month arrives.…",
      title: "New lease",
      total: 1,
    });
  });

  it("fetches a CAS-held text body through the authorized blob route", async () => {
    const revoke = vi.fn<(url: string) => void>();
    const hadRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revoke,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("blob:/centraid/_vault/blobs/c-doc");
        return { text: async () => "Uploaded prose, safe in the vault." };
      })
    );
    try {
      const content = await loadHomeTileContent({
        reader: readerOf({
          "core.content_item": [
            {
              content_id: "c-doc",
              content_uri: "blob:sha256-abc",
              media_type: "text/plain",
            },
          ],
          "core.document": [
            {
              current_content_id: "c-doc",
              document_id: "d1",
              title: "Upload",
              updated_at: "2026-07-01",
            },
          ],
        }),
      });
      expect(content.docs).toStrictEqual({
        excerpt: "Uploaded prose, safe in the vault.",
        title: "Upload",
        total: 1,
      });
      expect(revoke).toHaveBeenCalledWith("blob:/centraid/_vault/blobs/c-doc");
    } finally {
      vi.unstubAllGlobals();
      if (hadRevoke) Object.defineProperty(URL, "revokeObjectURL", hadRevoke);
      else Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  });

  it("stays title-only for a binary body and for a refused blob fetch", async () => {
    const { authorizeBlobUrl } = await import("../../blueprints/blob-auth.js");
    vi.mocked(authorizeBlobUrl).mockResolvedValue(null);
    const rowsFor = (mediaType: string): Rows => ({
      "core.content_item": [
        {
          content_id: "c-doc",
          content_uri: "blob:sha256-abc",
          media_type: mediaType,
        },
      ],
      "core.document": [
        {
          current_content_id: "c-doc",
          document_id: "d1",
          title: "Scan of the deed",
          updated_at: "2026-07-01",
        },
      ],
    });
    const binary = await loadHomeTileContent({
      reader: readerOf(rowsFor("application/pdf")),
    });
    expect(binary.docs).toStrictEqual({ title: "Scan of the deed", total: 1 });
    const refused = await loadHomeTileContent({
      reader: readerOf(rowsFor("text/plain")),
    });
    expect(refused.docs).toStrictEqual({ title: "Scan of the deed", total: 1 });
  });

  it("reads the note's true first line, keeping a heading's text", async () => {
    const content = await loadHomeTileContent({
      reader: readerOf({
        "core.content_item": [
          {
            content_id: "c-note",
            content_uri: `data:text/markdown;charset=utf-8,${encodeURIComponent("# Groceries for the week\n\n- milk\n- eggs\n")}`,
            media_type: "text/markdown",
          },
        ],
        "knowledge.note": [
          {
            body_content_id: "c-note",
            note_id: "n1",
            title: "Stale title after edits",
            updated_at: "2026-08-01",
          },
        ],
      }),
    });
    expect(content.notes).toStrictEqual({
      at: "2026-08-01",
      line: "Groceries for the week",
      total: 1,
    });
  });

  it("falls back to the note's title when its body is unreadable", async () => {
    const content = await loadHomeTileContent({
      reader: readerOf({
        "core.content_item": [
          {
            content_id: "c-note",
            content_uri: "blob:sha256-abc",
            media_type: "image/png",
          },
        ],
        "knowledge.note": [
          {
            body_content_id: "c-note",
            note_id: "n1",
            title: "Reading list",
            updated_at: "2026-08-01",
          },
        ],
      }),
    });
    expect(content.notes).toStrictEqual({
      at: "2026-08-01",
      line: "Reading list",
      total: 1,
    });
  });
});
