// The deep-link table's one non-obvious row (#880): the Commons invitation.
//
// `encodeCommonsInvite` mints `centraid://commons-invite?…` and hands it to a
// person by message. Until this row existed the tapped link cold-launched to
// Home and the claim it carried was dropped on the floor, which is the whole
// point of the URI. The host is the vault's, not this table's, so the two are
// pinned against each other here rather than trusted to stay in step.

import { describe, expect, it, vi } from "vitest";

import {
  encodeCommonsInvite,
  parseCommonsInvite,
} from "@centraid/blueprints/apps/_shared/commons-invite";

vi.mock(
  import("expo-linking"),
  () =>
    ({
      getInitialURL: () => Promise.resolve(null),
      addEventListener: () => ({ remove: () => undefined }),
    }) as never
);
vi.mock(
  import("expo-notifications"),
  () =>
    ({
      getLastNotificationResponseAsync: () => Promise.resolve(null),
      addNotificationResponseReceivedListener: () => ({
        remove: () => undefined,
      }),
    }) as never
);

const { LINKING } = await import("./deep-links");

describe("the commons-invite deep link", () => {
  const screens = LINKING.config?.screens as Record<string, unknown>;
  const settings = screens["Settings"] as { screens: Record<string, string> };

  it("lands the invitation on the screen that redeems one", () => {
    expect(settings.screens["Sharing"]).toBe("commons-invite");
  });

  it("uses the path the vault actually mints", () => {
    const uri = encodeCommonsInvite({
      stewardVaultId: "vault-priya",
      claimToken: "one-time",
    });
    const prefix = (LINKING.prefixes as string[])[0] as string;
    expect(uri.startsWith(prefix)).toBe(true);
    const path = new URL(uri).host;
    expect(path).toBe(settings.screens["Sharing"]);
    // And the claim still parses off the URI the router matched.
    expect(parseCommonsInvite(uri)).toStrictEqual({
      stewardVaultId: "vault-priya",
      claimToken: "one-time",
    });
  });

  it("keeps Settings reachable at its own path", () => {
    expect(settings.screens["Settings"]).toBe("settings");
  });
});
