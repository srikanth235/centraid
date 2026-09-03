/**
 * The renderer/main privilege boundary (#656, Layer 1F).
 *
 * These tests pin the things a bridge regression would silently change: the
 * exact key set exposed to the renderer, the channel every member reaches
 * for, the arguments it forwards, and the fact that nothing Electron-ish
 * (least of all `ipcRenderer` itself) escapes into the exposed objects.
 */
import { describe, expect, it } from "vitest";

import * as designTokens from "@centraid/design";
import { toFontFaceCss } from "@centraid/design/font-faces";

import { Channel } from "./ipc-core.js";
import type {
  BridgeListener,
  ChannelName,
  PreloadBridge,
} from "./preload-core.js";
import { createCentraidApi, createCentraidTokens } from "./preload-core.js";

interface InvokeRecord {
  channel: string;
  args: unknown[];
}

interface FakeBridge {
  bridge: PreloadBridge;
  invokes: InvokeRecord[];
  listeners: Map<string, BridgeListener[]>;
  emit: (channel: ChannelName, payload: unknown) => void;
  results: Map<string, unknown>;
}

function fakeBridge(): FakeBridge {
  const invokes: InvokeRecord[] = [];
  const listeners = new Map<string, BridgeListener[]>();
  const results = new Map<string, unknown>();
  const bridge: PreloadBridge = {
    invoke: (channel, ...args) => {
      invokes.push({ channel, args });
      return Promise.resolve(results.get(channel));
    },
    on: (channel, listener) => {
      const list = listeners.get(channel) ?? [];
      list.push(listener);
      listeners.set(channel, list);
    },
    off: (channel, listener) => {
      const list = listeners.get(channel) ?? [];
      const at = list.indexOf(listener);
      if (at >= 0) list.splice(at, 1);
      listeners.set(channel, list);
    },
  };
  return {
    bridge,
    invokes,
    listeners,
    results,
    emit: (channel, payload) => {
      for (const listener of listeners.get(channel) ?? []) {
        listener({ senderId: 1 }, payload);
      }
    },
  };
}

const EXPECTED_API_KEYS = [
  "beginPhonePairing",
  "cancelPhonePairing",
  "checkForUpdates",
  "createVault",
  "deleteVault",
  "exportGatewayDiagnostics",
  "exportGatewayRecoveryKit",
  "getChangelog",
  "getGatewayAuth",
  "getGatewayRuntime",
  "getHostCapabilities",
  "getPhoneLinkStatus",
  "getPublishStatus",
  "getSettings",
  "getUpdateStatus",
  "installGatewayService",
  "keychainPromptExpected",
  "listGatewayVaults",
  "listGateways",
  "notifyVaultMetadataChanged",
  "onDeepLink",
  "onGatewayChanged",
  "onGatewayRuntime",
  "onPhonePaired",
  "onPublishEvent",
  "onUpdateAvailable",
  "onVaultChanged",
  "onVaultMetadataChanged",
  "openAppFolder",
  "redeemGatewayPairing",
  "relaunchToUpdate",
  "removeGateway",
  "renameGateway",
  "restartGateway",
  "retryGatewayStart",
  "revokePhoneDevice",
  "saveSettings",
  "setActiveGateway",
  "setActiveVault",
  "setGatewayRememberDevice",
  "testGatewayConnection",
  "updateProfileMetadata",
];

/**
 * Members that reach no bridge channel at all. `getHostCapabilities` is a pure
 * synchronous snapshot — the desktop carries no on-device file-ASR adapter
 * (#724) — so it cannot sit in `REQUEST_SURFACE`, which asserts every entry
 * reaches exactly its declared channel. It is listed here so the coverage
 * check below still counts it.
 */
const PURE_SURFACE = ["getHostCapabilities"];

const EXPECTED_TOKEN_KEYS = [
  "apps",
  "cssText",
  "fonts",
  "icons",
  "palette",
  "radii",
  "spacing",
  "themePresets",
  "themes",
  "tileFinish",
  "type",
];

/**
 * Every request member, with the channel it must reach and the single
 * argument it must forward (`undefined` = the call takes no argument, so
 * nothing may be forwarded).
 */
const REQUEST_SURFACE: Array<[string, ChannelName, unknown]> = [
  ["getSettings", Channel.SETTINGS_GET, undefined],
  ["saveSettings", Channel.SETTINGS_SAVE, { launchAtLogin: true }],
  ["openAppFolder", Channel.APPS_OPEN, { id: "notes" }],
  ["getPublishStatus", Channel.PUBLISH_STATUS, { id: "notes" }],
  ["listGateways", Channel.GATEWAYS_LIST, undefined],
  ["removeGateway", Channel.GATEWAYS_REMOVE, { id: "gw-1" }],
  ["renameGateway", Channel.GATEWAYS_RENAME, { id: "gw-1", label: "Home" }],
  ["updateProfileMetadata", Channel.GATEWAYS_UPDATE_METADATA, { id: "gw-1" }],
  ["setActiveGateway", Channel.GATEWAYS_SET_ACTIVE, { id: "gw-1" }],
  ["getGatewayAuth", Channel.GATEWAY_AUTH_GET, undefined],
  [
    "setGatewayRememberDevice",
    Channel.GATEWAY_REMEMBER_DEVICE_SET,
    { rememberDevice: false },
  ],
  ["redeemGatewayPairing", Channel.GATEWAY_PAIR_REDEEM, { ticket: "t-1" }],
  ["listGatewayVaults", Channel.GATEWAYS_LIST_VAULTS, { gatewayId: "gw-1" }],
  [
    "testGatewayConnection",
    Channel.GATEWAY_TEST_CONNECTION,
    { kind: "gateway", gatewayId: "gw-1" },
  ],
  ["getGatewayRuntime", Channel.GATEWAY_RUNTIME_GET, undefined],
  ["restartGateway", Channel.GATEWAY_RESTART, undefined],
  ["retryGatewayStart", Channel.GATEWAY_START_RETRY, undefined],
  ["exportGatewayDiagnostics", Channel.GATEWAY_DIAGNOSTICS_EXPORT, undefined],
  [
    "exportGatewayRecoveryKit",
    Channel.GATEWAY_RECOVERY_KIT_EXPORT,
    { password: "hunter2" },
  ],
  ["setActiveVault", Channel.VAULTS_SET_ACTIVE, { vaultId: "v-1" }],
  ["createVault", Channel.VAULTS_CREATE, { name: "Household" }],
  ["deleteVault", Channel.VAULTS_DELETE, { vaultId: "v-1", name: "Old" }],
  ["notifyVaultMetadataChanged", Channel.VAULT_METADATA_CHANGED, undefined],
  ["getPhoneLinkStatus", Channel.PHONE_STATUS, undefined],
  ["beginPhonePairing", Channel.PHONE_BEGIN_PAIRING, undefined],
  ["cancelPhonePairing", Channel.PHONE_CANCEL_PAIRING, undefined],
  ["revokePhoneDevice", Channel.PHONE_REVOKE, { deviceId: "d-1" }],
  ["getUpdateStatus", Channel.UPDATE_STATUS, undefined],
  ["checkForUpdates", Channel.UPDATE_CHECK, undefined],
  ["relaunchToUpdate", Channel.UPDATE_RELAUNCH, undefined],
  ["installGatewayService", Channel.GATEWAY_SERVICE_INSTALL, undefined],
  ["keychainPromptExpected", Channel.KEYCHAIN_PROMPT_EXPECTED, undefined],
  ["getChangelog", Channel.CHANGELOG_GET, undefined],
];

const EVENT_SURFACE: Array<[string, ChannelName]> = [
  ["onPublishEvent", Channel.PUBLISH_EVENT],
  ["onGatewayRuntime", Channel.GATEWAY_RUNTIME_EVENT],
  ["onGatewayChanged", Channel.GATEWAY_CHANGED],
  ["onVaultChanged", Channel.VAULT_CHANGED],
  ["onVaultMetadataChanged", Channel.VAULT_METADATA_PUSH],
  ["onPhonePaired", Channel.PHONE_PAIRED],
  ["onUpdateAvailable", Channel.UPDATE_AVAILABLE],
];

type LooseApi = Record<string, (...args: unknown[]) => unknown>;

function makeApi(): { api: LooseApi; fake: FakeBridge } {
  const fake = fakeBridge();
  return { api: createCentraidApi(fake.bridge) as LooseApi, fake };
}

describe("CentraidApi exposed surface", () => {
  it("exposes exactly the declared key set", () => {
    const { api } = makeApi();
    expect(Object.keys(api).sort()).toStrictEqual(EXPECTED_API_KEYS);
  });

  it("exposes every member as a function", () => {
    const { api } = makeApi();
    const nonFunctions = Object.entries(api)
      .filter(([, value]) => typeof value !== "function")
      .map(([key]) => key);
    expect(nonFunctions).toStrictEqual([]);
  });

  it("covers every request and event member with a declared channel", () => {
    const declared = [
      ...REQUEST_SURFACE.map(([name]) => name),
      ...EVENT_SURFACE.map(([name]) => name),
      ...PURE_SURFACE,
      "onDeepLink",
    ].sort();
    expect(declared).toStrictEqual(EXPECTED_API_KEYS);
  });
});

describe("CentraidApi channel allowlisting", () => {
  it("reaches only channels that are members of the shared Channel map", async () => {
    const { api, fake } = makeApi();
    for (const [name, , arg] of REQUEST_SURFACE) {
      // oxlint-disable-next-line no-await-in-loop -- deterministic log order
      await (arg === undefined ? api[name]!() : api[name]!(arg));
    }
    for (const [name] of EVENT_SURFACE) api[name]!(() => undefined);

    const allowed = new Set<string>(Object.values(Channel));
    const reached = [
      ...fake.invokes.map((record) => record.channel),
      ...fake.listeners.keys(),
    ];
    expect(reached.filter((channel) => !allowed.has(channel))).toStrictEqual(
      []
    );
  });

  it("invokes each request member's declared channel with only its argument", async () => {
    const { api, fake } = makeApi();
    for (const [name, , arg] of REQUEST_SURFACE) {
      // oxlint-disable-next-line no-await-in-loop -- deterministic log order
      await (arg === undefined ? api[name]!() : api[name]!(arg));
    }
    expect(fake.invokes).toStrictEqual(
      REQUEST_SURFACE.map(([, channel, arg]) => ({
        channel,
        args: arg === undefined ? [] : [arg],
      }))
    );
  });

  it("attaches each event member to its declared broadcast channel", () => {
    const { api, fake } = makeApi();
    for (const [name] of EVENT_SURFACE) api[name]!(() => undefined);
    const attached = [...fake.listeners]
      .filter(([, list]) => list.length > 0)
      .map(([channel]) => channel)
      .sort();
    expect(attached).toStrictEqual(
      [Channel.DEEP_LINK, ...EVENT_SURFACE.map(([, channel]) => channel)].sort()
    );
  });
});

describe("CentraidApi event subscriptions", () => {
  it("delivers only the payload to the subscriber, never the sender event", () => {
    const { api, fake } = makeApi();
    const seen: unknown[] = [];
    api.onGatewayChanged!((msg: unknown) => seen.push(msg));
    fake.emit(Channel.GATEWAY_CHANGED, { activeGatewayId: "gw-2" });
    expect(seen).toStrictEqual([{ activeGatewayId: "gw-2" }]);
  });

  it("detaches the listener when the returned unsubscribe runs", () => {
    const { api, fake } = makeApi();
    const seen: unknown[] = [];
    const off = api.onPublishEvent!((msg: unknown) =>
      seen.push(msg)
    ) as () => void;
    fake.emit(Channel.PUBLISH_EVENT, { id: "notes", ok: true });
    off();
    fake.emit(Channel.PUBLISH_EVENT, { id: "notes", ok: false });
    expect(seen).toStrictEqual([{ id: "notes", ok: true }]);
  });

  it("drops the payload for the argument-less metadata subscription", () => {
    const { api, fake } = makeApi();
    const seen: unknown[] = [];
    api.onVaultMetadataChanged!((...args: unknown[]) => seen.push(args));
    fake.emit(Channel.VAULT_METADATA_PUSH, { leaked: true });
    expect(seen).toStrictEqual([[]]);
  });

  it("replays deep links buffered before the renderer subscribed", () => {
    const { api, fake } = makeApi();
    fake.emit(Channel.DEEP_LINK, "centraid://oauth/finish#state=warm");
    const seen: unknown[] = [];
    api.onDeepLink!((url: unknown) => seen.push(url));
    fake.emit(Channel.DEEP_LINK, "centraid://oauth/finish#state=live");
    expect(seen).toStrictEqual([
      "centraid://oauth/finish#state=warm",
      "centraid://oauth/finish#state=live",
    ]);
  });

  it("ignores a non-string deep-link payload", () => {
    const { api, fake } = makeApi();
    const seen: unknown[] = [];
    api.onDeepLink!((url: unknown) => seen.push(url));
    fake.emit(Channel.DEEP_LINK, { href: "centraid://oauth/finish" });
    expect(seen).toStrictEqual([]);
  });
});

describe("CentraidApi host capabilities", () => {
  it("reports transcript as permanently false — desktop's on-device ASR adapter is gone (issue #724 W6)", async () => {
    const { api, fake } = makeApi();
    const caps = (await api.getHostCapabilities!()) as {
      compute: { transcript: boolean };
    };
    expect(caps.compute.transcript).toBe(false);
    expect(fake.invokes).toStrictEqual([]);
  });
});

describe("CentraidApi leak containment", () => {
  it("exposes no member that is (or carries) the bridge itself", () => {
    const { api, fake } = makeApi();
    const carriers = Object.entries(api).filter(
      ([, value]) =>
        (value as unknown) === fake.bridge ||
        Object.hasOwn(value as object, "invoke") ||
        Object.hasOwn(value as object, "sendSync")
    );
    expect(carriers.map(([key]) => key)).toStrictEqual([]);
  });

  it("hands the subscriber nothing that reaches back to the bridge", () => {
    const { api, fake } = makeApi();
    const seen: unknown[] = [];
    api.onPhonePaired!((msg: unknown) => seen.push(msg));
    fake.emit(Channel.PHONE_PAIRED, { device: { deviceId: "d-1" } });
    expect(seen.map((msg) => structuredClone(msg))).toStrictEqual([
      { device: { deviceId: "d-1" } },
    ]);
  });
});

const FONT_FACE_CSS = toFontFaceCss("fonts");

describe("CentraidTokens", () => {
  it("exposes exactly the declared key set", () => {
    const exposed = createCentraidTokens(designTokens, FONT_FACE_CSS);
    expect(Object.keys(exposed).sort()).toStrictEqual(EXPECTED_TOKEN_KEYS);
  });

  it("is JSON-cloneable apart from the pure tileFinish helper", () => {
    const exposed = createCentraidTokens(designTokens, FONT_FACE_CSS) as Record<
      string,
      unknown
    >;
    const notCloneable = Object.entries(exposed)
      .filter(([key]) => key !== "tileFinish")
      .filter(([, value]) => {
        try {
          structuredClone(value);
          return false;
        } catch {
          return true;
        }
      })
      .map(([key]) => key);
    expect(notCloneable).toStrictEqual([]);
    expect(exposed.tileFinish).toBeTypeOf("function");
  });

  it("copies list exports so the renderer cannot mutate the package's arrays", () => {
    const exposed = createCentraidTokens(designTokens, FONT_FACE_CSS);
    expect(exposed.apps).not.toBe(designTokens.apps);
    expect(exposed.themePresets).not.toBe(designTokens.THEME_PRESETS);
    expect(exposed.apps).toStrictEqual([...designTokens.apps]);
    expect(exposed.themePresets).toStrictEqual([...designTokens.THEME_PRESETS]);
  });

  it("precomputes the token CSS the renderer injects", () => {
    const exposed = createCentraidTokens(designTokens, FONT_FACE_CSS);
    expect(exposed.cssText).toBe(`${FONT_FACE_CSS}\n${designTokens.toCss()}`);
  });

  // The faces have to be DECLARED before the first `var(--font-sans)` lookup,
  // and they have to point at the app's own bundle — a remote src would make
  // the shell's typography depend on a network the desktop never promised.
  it("declares the bundled faces ahead of the tokens, from relative paths", () => {
    const { cssText } = createCentraidTokens(designTokens, FONT_FACE_CSS);
    expect(cssText.indexOf("@font-face")).toBeLessThan(
      cssText.indexOf("--font-sans")
    );
    const sources = [...cssText.matchAll(/src: url\((?<href>[^)]+)\)/gu)].map(
      (match) => match.groups?.href
    );
    // FOUR: v8 leaves one Instrument Sans face at 400/600, each in latin +
    // latin-ext. The platform code stack has no `@font-face` rule at all.
    expect(sources).toHaveLength(4);
    expect(
      sources.filter((src) => src?.startsWith("fonts/") === true)
    ).toHaveLength(4);
  });

  it("delegates tileFinish to the design-token implementation", () => {
    const exposed = createCentraidTokens(designTokens, FONT_FACE_CSS);
    expect(exposed.tileFinish("#5B8DEF", "solid")).toStrictEqual(
      designTokens.tileFinish("#5B8DEF", "solid")
    );
  });
});
