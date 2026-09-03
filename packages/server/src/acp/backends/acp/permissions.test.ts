import type { PermissionOption } from "@agentclientprotocol/sdk";
import { describe, expect, test } from "vitest";

import {
  pickPermissionOption,
  pickRejectPermissionOption,
  readPermissionOptions,
} from "./permissions.ts";

describe("permissions", () => {
  const option = (
    optionId: string,
    kind: PermissionOption["kind"]
  ): PermissionOption => ({ optionId, name: optionId, kind });

  test("readPermissionOptions returns the SDK-validated option array", () => {
    const options = [option("a", "allow_once"), option("b", "reject_once")];
    expect(
      readPermissionOptions({
        sessionId: "session-1",
        toolCall: { toolCallId: "tool-1" },
        options,
      })
    ).toBe(options);
  });

  test("pickPermissionOption returns undefined for an empty list", () => {
    expect(pickPermissionOption([])).toBeUndefined();
  });

  test("pickPermissionOption prefers allow_always over everything else", () => {
    const picked = pickPermissionOption([
      option("once", "allow_once"),
      option("reject", "reject_once"),
      option("always", "allow_always"),
    ]);
    expect(picked).toBe("always");
  });

  test("pickPermissionOption falls back to allow_once when no allow_always", () => {
    const picked = pickPermissionOption([
      option("reject", "reject_once"),
      option("once", "allow_once"),
    ]);
    expect(picked).toBe("once");
  });

  test("pickPermissionOption falls back to any non-reject option", () => {
    const picked = pickPermissionOption([
      option("reject", "reject_always"),
      option("plain", "allow_once"),
    ]);
    expect(picked).toBe("plain");
  });

  test("pickPermissionOption falls back to the first option when only rejects remain", () => {
    const picked = pickPermissionOption([
      option("reject-a", "reject_once"),
      option("reject-b", "reject_always"),
    ]);
    expect(picked).toBe("reject-a");
  });

  test("pickRejectPermissionOption prefers reject_once over the sticky reject_always", () => {
    const picked = pickRejectPermissionOption([
      option("always", "allow_always"),
      option("no-forever", "reject_always"),
      option("no-now", "reject_once"),
    ]);
    expect(picked).toBe("no-now");
  });

  test("pickRejectPermissionOption uses reject_always when that is the only refusal", () => {
    expect(
      pickRejectPermissionOption([
        option("ok", "allow_once"),
        option("no-forever", "reject_always"),
      ])
    ).toBe("no-forever");
  });

  test("pickRejectPermissionOption never repurposes an allow as a refusal", () => {
    expect(pickRejectPermissionOption([])).toBeUndefined();
    expect(
      pickRejectPermissionOption([
        option("ok", "allow_once"),
        option("plain", "allow_always"),
      ])
    ).toBeUndefined();
  });
});
