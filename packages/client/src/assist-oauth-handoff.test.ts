import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  completeAssistReturnLink,
  consumeInitialAssistHandoff,
  installDesktopAssistHandoff,
  parseAssistHandoffUrl,
} from "./assist-oauth-handoff.js";
import type * as TypeImport_1jh8y15 from "./gateway-client-connections.js";

const { complete } = vi.hoisted(() => ({
  complete: vi.fn<typeof TypeImport_1jh8y15.completeAssistAuthorization>(),
}));
vi.mock(import("./gateway-client-connections.js"), () => ({
  completeAssistAuthorization: complete,
}));

const STATE = `w.${"A".repeat(43)}`;
const FRAGMENT = new URLSearchParams({
  code: "authorization-code",
  state: STATE,
  receipt: `v1.1999999999.${"B".repeat(43)}`,
}).toString();

describe("assist-oauth-handoff", () => {
  beforeEach(() => {
    complete.mockReset();
    sessionStorage.clear();
    window.history.replaceState(null, "", "/");
    window.CentraidApi = {
      getSettings: vi.fn<typeof window.CentraidApi.getSettings>(),
      saveSettings: vi.fn<typeof window.CentraidApi.saveSettings>(),
    } as unknown as typeof window.CentraidApi;
  });

  test("parses only the fixed web/custom-scheme finish routes and fragment fields", () => {
    expect(
      parseAssistHandoffUrl(`https://app.centraid.dev/oauth/finish#${FRAGMENT}`)
    ).toStrictEqual({
      code: "authorization-code",
      state: STATE,
      receipt: `v1.1999999999.${"B".repeat(43)}`,
    });
    expect(
      parseAssistHandoffUrl(
        `centraid://oauth/finish#${FRAGMENT.replace("w.", "d.")}`
      )
    ).toMatchObject({ code: "authorization-code" });
    expect(
      parseAssistHandoffUrl(`https://evil.example/oauth/finish#${FRAGMENT}`)
    ).toBeUndefined();
    expect(
      parseAssistHandoffUrl(`https://app.centraid.dev/oauth/finish?${FRAGMENT}`)
    ).toBeUndefined();
  });

  test("PWA resume scrubs the fragment synchronously before gateway delivery settles", async () => {
    let settle!: (value: { connectionId: string }) => void;
    complete.mockReturnValue(
      new Promise<{ connectionId: string }>((resolve) => {
        settle = resolve;
      })
    );
    window.history.replaceState(null, "", `/oauth/finish#${FRAGMENT}`);
    const pending = consumeInitialAssistHandoff();
    expect(window.location.pathname).toBe("/");
    expect(window.location.hash).toBe("");
    expect(sessionStorage).toHaveLength(0);
    settle({ connectionId: "connection-1" });
    await expect(pending).resolves.toStrictEqual({
      status: "complete",
      connectionId: "connection-1",
    });
  });

  test("desktop listener keeps the deep-link value in memory and ignores unrelated links", async () => {
    let listener: ((url: string) => void) | undefined;
    window.CentraidApi.onDeepLink = (callback) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    };
    complete.mockResolvedValue({ connectionId: "connection-2" });
    const dispose = installDesktopAssistHandoff();
    listener?.("centraid://settings");
    expect(complete).not.toHaveBeenCalled();
    listener?.(`centraid://oauth/finish#${FRAGMENT.replace("w.", "d.")}`);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    dispose();
    expect(listener).toBeUndefined();
  });

  test("manual fallback validates and delivers the copied custom-scheme return link", async () => {
    complete.mockResolvedValue({ connectionId: "connection-manual" });
    await expect(
      completeAssistReturnLink(
        `centraid://oauth/finish#${FRAGMENT.replace("w.", "d.")}`
      )
    ).resolves.toStrictEqual({ connectionId: "connection-manual" });
    await expect(
      completeAssistReturnLink("https://evil.example/oauth/finish")
    ).rejects.toThrow("not a valid Centraid Assist link");
  });
});
