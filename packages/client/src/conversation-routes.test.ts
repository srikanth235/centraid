// Unit tests for the persisted-conversation route builders (issue #420) — the
// ONE place the `_centraid-conversations` paths are minted.
import { describe, expect, it } from "vitest";

import {
  blobsPath,
  conversationPath,
  conversationSearchPath,
  conversationStatusPath,
  conversationsPath,
} from "./conversation-routes.js";

describe("route builders", () => {
  it("build the conversation / turn routes, encoding ids", () => {
    expect(conversationsPath("todo")).toBe(
      "/_centraid-conversations/apps/todo/sessions"
    );
    expect(conversationPath("todo", "a/b")).toBe(
      "/_centraid-conversations/apps/todo/sessions/a%2Fb"
    );
    expect(blobsPath("todo")).toBe("/_centraid-conversations/apps/todo/blobs");
    expect(conversationSearchPath("todo", "a b", 5)).toBe(
      "/_centraid-conversations/apps/todo/sessions/search?q=a+b&limit=5"
    );
    // Turn-settle poll for reconnect catch-up (#420).
    expect(conversationStatusPath("todo", "abc")).toBe(
      "/_centraid-conversations/apps/todo/sessions/abc/status"
    );
  });

  it("treats a null/empty app id as an empty segment (bare preview)", () => {
    expect(conversationsPath(null as unknown as string)).toBe(
      "/_centraid-conversations/apps//sessions"
    );
  });
});
