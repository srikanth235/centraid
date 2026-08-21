import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  Channel,
  gatewayChangedPayload,
  hostCapabilities,
  keychainPromptExpected,
  vaultChangedPayload,
} from "./ipc-core.js";
import { UPDATE_AVAILABLE_CHANNEL } from "./update-watcher.js";

const here = import.meta.dirname;

describe("Channel map", () => {
  it("uses the centraid: namespace for every channel", () => {
    for (const [key, value] of Object.entries(Channel)) {
      expect(value, key).toMatch(/^centraid:/u);
    }
  });

  it("is imported by both ipc.ts and preload-core.ts (parity)", () => {
    const ipc = readFileSync(path.join(here, "ipc.ts"), "utf8");
    const preload = readFileSync(path.join(here, "preload-core.ts"), "utf8");
    expect(ipc).toMatch(/from ['"]\.\/ipc-core\.js['"]/u);
    expect(preload).toMatch(/from ['"]\.\/ipc-core\.js['"]/u);
    // Neither file re-declares the channel map inline.
    expect(ipc).not.toMatch(/SETTINGS_GET:\s*'centraid:settings:get'/u);
    expect(preload).not.toMatch(/SETTINGS_GET:\s*'centraid:settings:get'/u);
  });

  it("covers the gateway + vault + deep-link surfaces the renderer uses", () => {
    expect(Channel.GATEWAYS_LIST).toBe("centraid:gateways:list");
    expect(Channel.GATEWAY_CHANGED).toBe("centraid:gateways:changed");
    expect(Channel.VAULT_CHANGED).toBe("centraid:vaults:changed");
    expect(Channel.VAULT_METADATA_PUSH).toBe("centraid:vaults:metadata-push");
    expect(Channel.DEEP_LINK).toBe("centraid:deep-link");
    expect(Channel.GATEWAY_AUTH_GET).toBe("centraid:gateways:auth");
  });

  it("pins UPDATE_AVAILABLE to the update-watcher broadcast channel", () => {
    expect(Channel.UPDATE_AVAILABLE).toBe(UPDATE_AVAILABLE_CHANNEL);
    expect(Channel.UPDATE_AVAILABLE).toBe("centraid:update:available");
  });
});

describe("gatewayChangedPayload / vaultChangedPayload", () => {
  it("mirrors active gateway identity and optional removal detail", () => {
    expect(
      gatewayChangedPayload(
        {
          activeGatewayId: "gw-2",
          activeGatewayKind: "remote",
          activeGatewayLabel: "Home",
          activeProfileDisplayName: "Family",
          activeProfileAvatarColor: "#5B8DEF",
        },
        { removedGatewayId: "gw-1", purgeReplicaGatewayId: "gw-1" }
      )
    ).toStrictEqual({
      activeGatewayId: "gw-2",
      activeGatewayKind: "remote",
      activeGatewayLabel: "Home",
      activeProfileDisplayName: "Family",
      activeProfileAvatarColor: "#5B8DEF",
      gatewayId: "gw-2",
      removedGatewayId: "gw-1",
      purgeReplicaGatewayId: "gw-1",
    });
  });

  it("omits activeVaultId when unset (vault switcher treats absent as default)", () => {
    expect(vaultChangedPayload({ activeGatewayId: "local" })).toStrictEqual({
      activeGatewayId: "local",
      gatewayId: "local",
    });
    expect(
      vaultChangedPayload({ activeGatewayId: "local", activeVaultId: "v1" })
    ).toStrictEqual({
      activeGatewayId: "local",
      gatewayId: "local",
      activeVaultId: "v1",
    });
  });
});

describe(hostCapabilities, () => {
  it("always reports desktop platform, with transcript permanently false (issue #724 W6)", () => {
    expect(hostCapabilities()).toMatchObject({
      platform: "desktop",
      compute: {
        previews: true,
        transcript: false,
        edgeSeal: true,
        backgroundTransfer: false,
      },
    });
  });
});

describe(keychainPromptExpected, () => {
  it("is false whenever safeStorage has no encryption to offer", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(
        keychainPromptExpected({
          platform,
          encryptionAvailable: false,
          packaged: false,
        })
      ).toBe(false);
    }
  });

  it("warns on an unpackaged macOS build but not a packaged one", () => {
    expect(
      keychainPromptExpected({
        platform: "darwin",
        encryptionAvailable: true,
        packaged: false,
      })
    ).toBe(true);
    expect(
      keychainPromptExpected({
        platform: "darwin",
        encryptionAvailable: true,
        packaged: true,
      })
    ).toBe(false);
  });

  it("warns on Linux with a live keyring and never on Windows DPAPI", () => {
    expect(
      keychainPromptExpected({
        platform: "linux",
        encryptionAvailable: true,
        packaged: true,
      })
    ).toBe(true);
    expect(
      keychainPromptExpected({
        platform: "win32",
        encryptionAvailable: true,
        packaged: true,
      })
    ).toBe(false);
  });
});
