import { beforeEach, describe, expect, it } from "vitest";

import type { ReplicaIntent } from "@centraid/client/replica/native";

import { protectedByPendingWork } from "../../kit/fetch-gate/protections";
import {
  forgetPendingContentRefs,
  publishPendingContentRefs,
} from "./pending-content-refs";

function queued(intentId: string, contentId: string): ReplicaIntent {
  return {
    intentId,
    createdOrder: 1,
    appId: "photos",
    action: "photos.attach",
    input: { content_id: contentId },
    payloadHash: `h-${intentId}`,
    state: "queued",
    attempts: 0,
    optimistic: [],
    enqueuedAt: "2026-01-01T00:00:00.000Z",
  };
}

const ref = (contentId: string): { scopeId: string; contentId: string } => ({
  scopeId: "scope",
  contentId,
});

describe("the bytes a pending intent needs, per vault (#1014, C7)", () => {
  beforeEach(() => {
    forgetPendingContentRefs("vault-personal");
    forgetPendingContentRefs("vault-family");
  });

  it("does not let one vault's publish erase another's", () => {
    publishPendingContentRefs("vault-personal", [queued("i-p", "photo-p")]);
    // The arrangement R25 was found in: two vaults mounted on one phone. This
    // publish used to OVERWRITE the module-global, making Personal's
    // captured-but-unsent photograph evictable.
    publishPendingContentRefs("vault-family", [queued("i-f", "photo-f")]);
    expect(protectedByPendingWork(ref("photo-p"))).toBe(true);
    expect(protectedByPendingWork(ref("photo-f"))).toBe(true);
    expect(protectedByPendingWork(ref("photo-nobody-wants"))).toBe(false);
  });

  it("withdraws only the closing vault's answer", () => {
    publishPendingContentRefs("vault-personal", [queued("i-p", "photo-p")]);
    publishPendingContentRefs("vault-family", [queued("i-f", "photo-f")]);
    forgetPendingContentRefs("vault-family");
    expect(protectedByPendingWork(ref("photo-f"))).toBe(false);
    // Personal is still mounted and still needs its bytes.
    expect(protectedByPendingWork(ref("photo-p"))).toBe(true);
    forgetPendingContentRefs("vault-personal");
    expect(protectedByPendingWork(ref("photo-p"))).toBe(false);
  });
});
