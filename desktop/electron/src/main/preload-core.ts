/*
 * The renderer/main privilege boundary in testable form (#1020, D-1020-F2).
 *
 * Carried from v0's `preload-core.ts` with its two load-bearing properties
 * intact:
 *
 * 1. **The boundary is three functions wide.** `PreloadBridge = {invoke, on,
 *    off}` — the factories receive only these, so nothing they build can leak
 *    `ipcRenderer`. `off` must detach by listener identity.
 * 2. **The `ipcRenderer` event is dropped in exactly one place**, because it
 *    carries `sender`, "which must never cross the contextBridge". One
 *    `subscribe` helper, so subscribe and unsubscribe cannot drift.
 *
 * What is gone is the token. v0's single hardest IPC rule was that the gateway
 * bearer crosses the bridge exactly once, through `GATEWAY_AUTH_GET`, and that
 * `SETTINGS_GET` strips it (census §F seam 5). **There is no bearer here**: the
 * socket is the credential and main holds it, so the renderer is handed no
 * credential at all and the rule it protected cannot be broken. The one thing
 * that is still minted and handed out is a per-turn capability token for a
 * CHILD PROCESS (`centraid mcp`, the browser host) — and it is single-use, so
 * even that is not a bearer the renderer can keep.
 */

import { Channel } from "./ipc-core.js";
import type { ChannelName } from "./ipc-core.js";

/**
 * `event` is never read or forwarded: it carries `sender`, which must never
 * cross the contextBridge.
 */
export type BridgeListener = (event: unknown, payload: unknown) => void;

export interface PreloadBridge {
  invoke: (channel: ChannelName, ...args: unknown[]) => Promise<unknown>;
  on: (channel: ChannelName, listener: BridgeListener) => void;
  off: (channel: ChannelName, listener: BridgeListener) => void;
}

/** The one place the sender event is dropped. */
function subscribe<T>(
  bridge: PreloadBridge,
  channel: ChannelName,
  callback: (message: T) => void
): () => void {
  const listener: BridgeListener = (_event, payload) => callback(payload as T);
  bridge.on(channel, listener);
  return () => bridge.off(channel, listener);
}

export interface PageAnswer {
  columns: string[];
  rows: unknown[][];
  next?: { sort_key: string; pk: string };
}

export function createCentraidApi(bridge: PreloadBridge) {
  return {
    /** A named paged read. The name is the catalogue's, never a query. */
    page: (input: {
      statement: string;
      limit: number;
      after?: { sort_key: string; pk: string };
    }) => bridge.invoke(Channel.SEAT_PAGE, input) as Promise<PageAnswer>,

    command: (input: { name: string; input: Record<string, unknown> }) =>
      bridge.invoke(Channel.SEAT_COMMAND, input),

    devices: () => bridge.invoke(Channel.SEAT_DEVICES),

    /** The four states, now. */
    getSeatState: () => bridge.invoke(Channel.SEAT_STATE_GET),
    /** The four states, pushed — in main, so they survive navigation. */
    onSeatState: (callback: (state: unknown) => void) =>
      subscribe(bridge, Channel.SEAT_STATE_EVENT, callback),

    blobStat: (input: { blob: string }) =>
      bridge.invoke(Channel.SEAT_BLOB_STAT, input),

    /**
     * Mint a per-turn capability token for a child process.
     *
     * The renderer asks; main mints through the socket and puts the token in
     * the child's environment. The renderer never sees a token for itself —
     * it has no use for one, because main holds the socket.
     */
    mintCapability: (input: {
      client: "mcp" | "native-host";
      purpose: string;
    }) => bridge.invoke(Channel.SEAT_CAPABILITY_MINT, input),

    /** "Try again" after the seat failed to start. */
    retrySeat: () => bridge.invoke(Channel.SEAT_RETRY),
    /** Why the seat is not running. The crash-loop sentence is quoted here. */
    getSeatFailure: () => bridge.invoke(Channel.SEAT_FAILURE_GET),

    getHostInfo: () => bridge.invoke(Channel.HOST_INFO),
    reveal: (input: { id: string }) =>
      bridge.invoke(Channel.HOST_REVEAL, input),
  };
}

export type CentraidApi = ReturnType<typeof createCentraidApi>;

/**
 * Every channel the API actually uses, derived from a recording bridge.
 *
 * Not a hand-kept list: the drift test builds the API over a bridge that
 * records, calls every member, and compares. A channel in the map that nothing
 * calls is dead, and a call to a channel main does not handle is a runtime
 * `Error: No handler registered` the member sees.
 */
export function channelsUsedBy(
  build: (bridge: PreloadBridge) => Record<string, unknown>
): Set<string> {
  const used = new Set<string>();
  const bridge: PreloadBridge = {
    invoke: async (channel) => {
      used.add(channel);
      return undefined;
    },
    on: (channel) => used.add(channel),
    off: () => undefined,
  };
  const api = build(bridge);
  for (const value of Object.values(api)) {
    if (typeof value !== "function") continue;
    try {
      // Every member takes at most one object argument, and none of them reads
      // it before `invoke`. A member that did would be a member doing work in
      // the preload, which this call would catch as a throw.
      void (value as (input: unknown) => unknown)({
        statement: "tally.vault",
        limit: 1,
        name: "x",
        input: {},
        blob: "0".repeat(64),
        client: "mcp",
        purpose: "probe",
        id: "photos",
      });
    } catch {
      // Recorded whatever it managed to reach.
    }
  }
  return used;
}
