import { beforeEach, describe, expect, it } from "vitest";

import {
  conversationScope,
  conversationScopes,
  rememberConversationScope,
} from "./conversationScopes.js";

describe("conversationScopes suite", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe(conversationScopes, () => {
    it("remembers a conversation’s vault and hands it back", () => {
      rememberConversationScope("conv-1", "v-family");
      expect(conversationScope("conv-1")).toBe("v-family");
    });

    it("keeps every conversation’s vault independent", () => {
      rememberConversationScope("conv-1", "v-mine");
      rememberConversationScope("conv-2", "v-family");
      expect(conversationScopes()).toStrictEqual({
        "conv-1": "v-mine",
        "conv-2": "v-family",
      });
    });

    it("answers undefined for a conversation this device never recorded", () => {
      expect(conversationScope("never-seen")).toBeUndefined();
      expect(conversationScope(undefined)).toBeUndefined();
    });

    it("survives a reload — the record is what makes the pin durable", () => {
      rememberConversationScope("conv-1", "v-family");
      expect(conversationScopes()).toStrictEqual({ "conv-1": "v-family" });
      expect(conversationScope("conv-1")).toBe("v-family");
    });
  });
});
