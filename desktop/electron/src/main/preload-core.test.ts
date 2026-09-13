import { describe, expect, it, vi } from "vitest";

import {
  assertRevealableAppId,
  Channel,
  CHANNELS,
  isStatementName,
  keychainPromptExpected,
  parsePageLimit,
  parseRevealableAppId,
} from "./ipc-core.js";
import { channelsUsedBy, createCentraidApi } from "./preload-core.js";
import type { PreloadBridge } from "./preload-core.js";

const harness = () => {
  const invoke = vi.fn<(...args: unknown[]) => Promise<unknown>>(
    async () => undefined
  );
  const on = vi.fn<(...args: unknown[]) => void>();
  const off = vi.fn<(...args: unknown[]) => void>();
  const bridge: PreloadBridge = { invoke, on, off };
  return { bridge, invoke, on, off };
};

describe("the bridge", () => {
  it("is three functions wide and nothing more reaches the factories", () => {
    const { bridge } = harness();
    expect(Object.keys(bridge).sort()).toStrictEqual(["invoke", "off", "on"]);
    const api = createCentraidApi(bridge);
    // No member leaks the bridge or anything on it.
    for (const value of Object.values(api)) {
      expect(value).toBeTypeOf("function");
    }
  });

  it("hands the renderer no credential at all", () => {
    const api = createCentraidApi(harness().bridge);
    const names = Object.keys(api).join(" ").toLowerCase();
    // v0's hardest rule was that the bearer crosses exactly once. There is no
    // bearer: the socket is the credential and main holds it.
    expect(names).not.toMatch(/token|auth|bearer|secret|password/u);
    // Except the one thing that IS minted — for a CHILD, and single-use.
    expect(api.mintCapability).toBeTypeOf("function");
  });

  it("drops the ipcRenderer event in exactly one place", () => {
    const { bridge, on, off } = harness();
    const api = createCentraidApi(bridge);
    const seen: unknown[] = [];
    const unsubscribe = api.onSeatState((state) => seen.push(state));
    expect(on).toHaveBeenCalledOnce();
    const [channel, listener] = on.mock.calls[0] as [
      string,
      (event: unknown, payload: unknown) => void,
    ];
    expect(channel).toBe(Channel.SEAT_STATE_EVENT);

    // The event carries `sender`. The callback must never see it.
    listener({ sender: "a WebContents" }, { availability: "local" });
    expect(seen).toStrictEqual([{ availability: "local" }]);

    // `off` detaches BY LISTENER IDENTITY, so two subscriptions do not
    // unsubscribe each other.
    unsubscribe();
    expect(off).toHaveBeenCalledWith(Channel.SEAT_STATE_EVENT, listener);
  });

  it("sends each call on its own channel", async () => {
    const { bridge, invoke } = harness();
    const api = createCentraidApi(bridge);
    await api.page({ statement: "tally.vault", limit: 1 });
    expect(invoke).toHaveBeenLastCalledWith(Channel.SEAT_PAGE, {
      statement: "tally.vault",
      limit: 1,
    });
    await api.devices();
    expect(invoke).toHaveBeenLastCalledWith(Channel.SEAT_DEVICES);
    await api.retrySeat();
    expect(invoke).toHaveBeenLastCalledWith(Channel.SEAT_RETRY);
  });
});

describe("the channel map", () => {
  it("has no channel nothing uses and no duplicate", () => {
    const used = channelsUsedBy((bridge) => createCentraidApi(bridge));
    const declared = new Set<string>(CHANNELS);
    expect(declared.size).toBe(CHANNELS.length);
    expect([...declared].filter((channel) => !used.has(channel))).toStrictEqual(
      []
    );
    expect([...used].filter((channel) => !declared.has(channel))).toStrictEqual(
      []
    );
  });

  it("is a third of v0's forty-one, because the renderer has one door", () => {
    // Not a golden number for its own sake: the count IS the claim that the
    // socket replaced the per-door channels, and a jump back up is a design
    // change somebody should have to justify. Fifteen: eleven for the seat and
    // the shell, four for the updater — which is carried whole rather than
    // reduced (D-1020-F7).
    expect(CHANNELS.length).toBeLessThanOrEqual(16);
  });
});

describe("the shape checks at the boundary", () => {
  it("validates an app id before any path join", () => {
    expect(parseRevealableAppId("photos")).toBe("photos");
    expect(parseRevealableAppId("a-b-c-1")).toBe("a-b-c-1");
    for (const bad of [
      "_internal",
      "-leading",
      "Photos",
      "photos/../..",
      "photos ",
      "",
      "a".repeat(64),
      42,
      null,
      undefined,
    ]) {
      expect(parseRevealableAppId(bad), String(bad)).toBeNull();
    }
    expect(() => assertRevealableAppId("../etc")).toThrow(/not an app id/u);
  });

  it("refuses a statement name that is not a catalogue name", () => {
    expect(isStatementName("tally.vault")).toBe(true);
    expect(isStatementName("tally.circleMembers")).toBe(true);
    expect(isStatementName("photos.assets")).toBe(true);
    for (const bad of [
      "SELECT * FROM core_party",
      "tally",
      "tally.",
      ".vault",
      "tally.vault; DROP",
      "Tally.vault",
      42,
      null,
    ]) {
      expect(isStatementName(bad), String(bad)).toBe(false);
    }
  });

  it("requires a page limit and clamps it, never defaults it", () => {
    expect(parsePageLimit(1)).toBe(1);
    expect(parsePageLimit(500)).toBe(500);
    expect(parsePageLimit(5000)).toBe(500);
    for (const bad of [0, -1, 1.5, "10", null, undefined, Number.NaN]) {
      expect(parsePageLimit(bad), String(bad)).toBeNull();
    }
  });

  it("predicts the keychain prompt per platform, as v0 does", () => {
    expect(
      keychainPromptExpected({ platform: "darwin", packaged: false })
    ).toBe(true);
    expect(keychainPromptExpected({ platform: "darwin", packaged: true })).toBe(
      false
    );
    expect(keychainPromptExpected({ platform: "win32", packaged: false })).toBe(
      false
    );
    expect(keychainPromptExpected({ platform: "linux", packaged: true })).toBe(
      true
    );
  });
});
