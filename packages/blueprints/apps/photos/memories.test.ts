import { describe, expect, it, vi } from "vitest";

import { buildMemories } from "./memories.ts";

describe("web memories", () => {
  it("renders only the library projection and resolves its ordered cover", () => {
    const onOpen = vi.fn<(shelf: string) => void>();
    const cards = buildMemories({
      ownAssets: [
        { asset_id: "favorite", favorite: 1, content_uri: "favorite.jpg" },
        { asset_id: "member", thumb_uri: "member.jpg" },
      ],
      memories: [
        {
          memory_id: "trip-1",
          kind: "trip",
          title_hint: "Three days in Mysuru",
          computed_at: "2026-08-07T00:00:00Z",
        },
      ],
      memoryMembers: [{ memory_id: "trip-1", asset_id: "member", ordinal: 0 }],
      onOpen,
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      key: "trip-1",
      title: "Three days in Mysuru",
      coverUri: "member.jpg",
    });
    cards[0]!.onOpen();
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("memory:trip-1");
  });
});
