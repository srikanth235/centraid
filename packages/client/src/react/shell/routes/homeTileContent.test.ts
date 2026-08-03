import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadHomeTileContent } from "./homeTileContent.js";
import type { HomeTileReader } from "./homeTileContent.js";

// The blob authorizer reaches the authed gateway client, which touches
// `window.CentraidApi` at module load. Stub it at the leaf so the read layer is
// testable without a transport.
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
      return { rows: found.map((values) => ({ values })) };
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
      reader: readerOf({}),
    });
    expect(content.agenda).toStrictEqual({ events: BRIEF.events, total: 1 });
    expect(content.tally).toStrictEqual({
      balanceMinor: 2_500,
      currency: "USD",
    });
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
    expect(content.people).toStrictEqual({ names: ["Ada"], total: 1 });
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
    expect(content.people).toStrictEqual({ names: ["Ada"], total: 1 });
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
      rows: [
        { done: false, title: "Renew passport" },
        { done: false, title: "Pack" },
        { done: true, title: "Book flights" },
      ],
      total: 2,
    });
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
        "media.media_asset": [
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
});
