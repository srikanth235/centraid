// The Connectors place, rendered (#765, spec §4). Pins what an edit is
// likeliest to undo quietly: loading = ROW GEOMETRY + why-sentence, never a
// spinner; empty = verbatim consent paragraph; error = net panel + exact
// cause + retry + promise nothing was paused; lapsed `Re-authorize` runs the
// real ceremony, not a local write; inline verb only with a lapsed row.
// Frame verbs ABSENT by decision — the last test holds that absence.

import type { WebBrowserAuthSessionResult } from "expo-web-browser";
// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveTheme } from "../../kit/theme";
import type { ConnectionEntry } from "../../lib/connections";
import { MOBILE_FEATURE_OFF_COPY } from "../../lib/replica/mobile-gateway-compatibility-core";
import type { ConnectorsScreenProps } from "../../navigation";
import {
  mountBlock,
  nodesOf,
  press,
  styleOf,
} from "../../test/react-native-stub";
import ConnectorsScreen from "./Connectors";

vi.mock(import("react-native"), async () => {
  const stub = await import("../../test/react-native-stub");
  // RefreshControl is the screen-added primitive: a gesture host that draws
  // nothing; kit primitives come from the shared stub.
  return {
    ...stub.reactNativeStub(),
    RefreshControl: () => null,
  } as unknown as typeof import("react-native");
});
vi.mock(import("@react-native-async-storage/async-storage"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.asyncStorageStub() as unknown as {
    default: typeof import("@react-native-async-storage/async-storage").default;
  };
});
vi.mock(import("react-native-svg"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.svgStub() as unknown as typeof import("react-native-svg");
});
vi.mock(import("react-native-safe-area-context"), () => ({
  useSafeAreaInsets: () => ({ bottom: 34, left: 0, right: 0, top: 47 }),
}));

// Only session fact read: features advertised on `/info`. Provider mocked so
// the replica machinery never mounts to state a capability.
const session = vi.hoisted(() => ({
  features: undefined as
    | { automations: boolean; connectors: boolean }
    | undefined,
}));
vi.mock(import("../../kit/replica/ReplicaProvider"), () => ({
  useReplica: () => ({ online: true, ready: true, ...session }),
}));

type Connections = typeof import("../../lib/connections");
type WebBrowserModule = typeof import("expo-web-browser");

const wire = vi.hoisted(() => ({
  authUrl: "https://accounts.example/authorize?state=d.x",
  begin: vi.fn<Connections["beginConnectionAuthorization"]>(),
  complete: vi.fn<Connections["completeConnectionAuthorization"]>(),
  list: vi.fn<Connections["listConnections"]>(),
  openAuthSession: vi.fn<WebBrowserModule["openAuthSessionAsync"]>(),
  setStatus: vi.fn<Connections["setConnectionStatus"]>(),
}));

vi.mock(
  import("expo-web-browser"),
  () =>
    ({
      openAuthSessionAsync: wire.openAuthSession,
    }) as unknown as WebBrowserModule
);
vi.mock(import("../../lib/connections"), () => ({
  beginConnectionAuthorization: wire.begin,
  completeConnectionAuthorization: wire.complete,
  listConnections: wire.list,
  setConnectionStatus: wire.setStatus,
}));
vi.mock(
  import("../../lib/gateway"),
  () =>
    ({
      resolveGatewayBase: () => Promise.resolve("http://127.0.0.1:7777"),
    }) as unknown as typeof import("../../lib/gateway")
);

const colors = resolveTheme("light").colors;

function entry(over: Partial<ConnectionEntry> = {}): ConnectionEntry {
  return {
    allowedHosts: null,
    authNote: null,
    connectionId: "c-gmail",
    createdAt: "2026-01-04T09:00:00.000Z",
    credKind: "oauth2",
    hasRefreshToken: true,
    kind: "gmail",
    label: "Gmail",
    lastRunAt: null,
    oauthMode: "assist",
    principal: "alex@pemberton.example",
    provider: "google",
    scopes: null,
    status: "active",
    tokenExpiresAt: null,
    trust: "staged",
    ...over,
  };
}

const navigation = {
  goBack: vi.fn<() => void>(),
} as unknown as ConnectorsScreenProps["navigation"];

let dispose: (() => void) | undefined;

/** Mount the screen and let the first read settle. */
async function render(): Promise<HTMLElement> {
  const mounted = mountBlock(
    <ConnectorsScreen
      navigation={navigation}
      route={
        { key: "conn", name: "Connectors" } as ConnectorsScreenProps["route"]
      }
    />
  );
  dispose = mounted.unmount;
  await settle();
  return mounted.container;
}

/** Two macrotask turns: microtasks drain before the first timer; the second
 *  covers a read that a write kicked off. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function textOf(container: HTMLElement): string[] {
  return nodesOf(container, "span").map((node) => node.textContent ?? "");
}

function buttonLabelled(container: HTMLElement, label: string): Element | null {
  return (
    nodesOf(container, "button").find((node) =>
      (node.textContent ?? "").includes(label)
    ) ?? null
  );
}

describe(ConnectorsScreen, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Unknown by default — the gateway has not answered yet.
    session.features = undefined;
    wire.list.mockResolvedValue([]);
    wire.begin.mockResolvedValue(wire.authUrl);
    wire.complete.mockResolvedValue(undefined);
    wire.setStatus.mockResolvedValue(undefined);
    // Everyday outcome: member closed the sheet. Runtime enum from a mocked
    // module — the literal is type-asserted.
    wire.openAuthSession.mockResolvedValue({
      type: "dismiss",
    } as WebBrowserAuthSessionResult);
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  // V0 gate off: no connections routes mounted — don't dress a 404 as a
  // failed read.
  it("walls the place when the gateway has connectors switched off", async () => {
    session.features = { automations: true, connectors: false };
    const container = await render();
    expect(textOf(container).join(" ")).toContain(
      MOBILE_FEATURE_OFF_COPY.connectors.title
    );
    expect(wire.list).not.toHaveBeenCalled();
  });

  it("draws the page when the gateway has connectors switched on", async () => {
    session.features = { automations: false, connectors: true };
    wire.list.mockResolvedValue([entry()]);
    const container = await render();
    const spans = textOf(container).join(" ");
    expect(spans).toContain("Gmail");
    expect(spans).not.toContain(MOBILE_FEATURE_OFF_COPY.connectors.title);
  });

  it("draws the row geometry while it reads, and says why", async () => {
    // A read that never settles is the loading state.
    wire.list.mockReturnValue(
      new Promise<ConnectionEntry[]>(() => {
        // Never settles: this is what "still reading" looks like.
      })
    );
    const container = await render();
    const skeleton = nodesOf(container, "div").find(
      (node) => node.dataset.role === "progressbar"
    );
    expect(skeleton?.getAttribute("aria-label")).toBe(
      "Reading your connections"
    );
    expect(textOf(container)).toContain(
      "A row knows its shape before its content arrives, so nothing reflows when it does."
    );
    expect(textOf(container)).toContain("Reading from the gateway");
  });

  it("says what a connector is, quietly, when nothing is connected", async () => {
    const container = await render();
    const spans = textOf(container);
    expect(spans).toContain("Nothing is connected");
    expect(spans).toContain(
      "A connector lets one outside service reach a named part of this vault, and nothing else."
    );
    expect(spans).toContain("Nothing to attend to");
    // No catalog exists on this surface; offer nothing it cannot do.
    expect(buttonLabelled(container, "Open the catalog")).toBeNull();
  });

  it("reports a failed read as a net panel that promises nothing was paused", async () => {
    wire.list.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const container = await render();
    const spans = textOf(container);
    expect(spans).toContain("THIS PAGE COULD NOT LOAD");
    expect(spans).toContain("Cannot read connection health");
    expect(spans).toContain(
      "Connection health is unavailable; the connections themselves keep working."
    );
    expect(spans).toContain("connect ECONNREFUSED");
    const panel = nodesOf(container, "div").find(
      (node) => styleOf(node).borderColor === colors.net
    );
    expect(panel).toBeDefined();
    expect(buttonLabelled(container, "Try again")).not.toBeNull();
    expect(spans).toContain("This page could not load");
  });

  it("runs the real ceremony when a lapsed row is re-authorized", async () => {
    wire.openAuthSession.mockResolvedValue({
      type: "success",
      url: `centraid://oauth/finish#state=d.${"a".repeat(43)}&code=abc&receipt=r1`,
    } as WebBrowserAuthSessionResult);
    wire.list.mockResolvedValue([
      entry({
        authNote: "Its token expired on 9 August.",
        status: "needs-auth",
      }),
    ]);
    const container = await render();
    const spans = textOf(container);
    expect(spans).toContain("Gmail");
    expect(spans).toContain("Needs re-auth");
    expect(spans).toContain(
      "Gmail needs re-authorization · Its token expired on 9 August."
    );
    press(buttonLabelled(container, "Re-authorize"));
    await settle();
    expect(wire.begin).toHaveBeenCalledWith("c-gmail");
    expect(wire.openAuthSession).toHaveBeenCalledWith(
      wire.authUrl,
      "centraid://oauth/finish"
    );
    expect(wire.complete).toHaveBeenCalledOnce();
    // Health is re-read from the gateway, never assumed locally.
    expect(wire.setStatus).not.toHaveBeenCalled();
    expect(wire.list.mock.calls.length).toBeGreaterThan(1);
  });

  it("pauses a working connection through the gateway, and resumes a paused one", async () => {
    wire.list.mockResolvedValue([
      entry(),
      entry({
        connectionId: "c-hass",
        label: "Home Assistant",
        status: "paused",
      }),
    ]);
    const container = await render();
    press(buttonLabelled(container, "Pause"));
    await settle();
    expect(wire.setStatus).toHaveBeenCalledWith("c-gmail", "paused");
    press(buttonLabelled(container, "Resume"));
    await settle();
    expect(wire.setStatus).toHaveBeenCalledWith("c-hass", "active");
  });

  it("carries no bar verbs, because neither flow exists on this surface", async () => {
    wire.list.mockResolvedValue([entry()]);
    const container = await render();
    expect(buttonLabelled(container, "Add a connection")).toBeNull();
    expect(buttonLabelled(container, "Catalog")).toBeNull();
    expect(textOf(container)).toContain("Connectors");
  });
});
