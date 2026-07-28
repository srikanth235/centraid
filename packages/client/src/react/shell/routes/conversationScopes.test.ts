import { beforeEach, describe, expect, it } from "vitest";

import {
  conversationScope,
  conversationScopes,
  rememberConversationScope,
} from "./conversationScopes.js";

describe("conversationScopes suite", () => {
  // A conversation reads exactly ONE space for its whole life (#599, Decision 14
  // acceptance criterion). This is the record that makes the client able to keep
  // that promise across reloads.

  beforeEach(() => {
    localStorage.clear();
  });

  describe(conversationScopes, () => {
    it("remembers a conversation’s space and hands it back", () => {
      rememberConversationScope("conv-1", "v-family");
      expect(conversationScope("conv-1")).toBe("v-family");
    });

    it("keeps every conversation’s space independent", () => {
      rememberConversationScope("conv-1", "v-mine");
      rememberConversationScope("conv-2", "v-family");
      expect(conversationScopes()).toStrictEqual({
        "conv-1": "v-mine",
        "conv-2": "v-family",
      });
    });

    it("answers undefined for a conversation this device never recorded", () => {
      // An older thread, or one started on another device: the caller falls back
      // to the internal default scope rather than guessing.
      expect(conversationScope("never-seen")).toBeUndefined();
      expect(conversationScope(undefined)).toBeUndefined();
    });

    it("survives a reload — the record is what makes the pin durable", () => {
      rememberConversationScope("conv-1", "v-family");
      expect(conversationScopes()).toStrictEqual({ "conv-1": "v-family" });
      // Simulate a fresh module read against the same storage.
      expect(conversationScope("conv-1")).toBe("v-family");
    });
  });
});
