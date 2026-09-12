/*
 * The preload: a trivially-correct shell over `preload-core.ts` (#1020).
 *
 * v0 exposes exactly two globals (`CentraidApi`, `CentraidTokens`) and this
 * carries the shape: one API, and the design tokens as a pure projection. The
 * only logic here is the three-function bridge — everything the API does is in
 * the core, which has no `electron` import and is therefore unit-tested.
 *
 * The `ipcRenderer` event never reaches `createCentraidApi`: it carries
 * `sender`, which must never cross the contextBridge, and `preload-core`'s one
 * `subscribe` helper is where it is dropped.
 */

import { contextBridge, ipcRenderer } from "electron";

import { CHANNELS } from "./main/ipc-core.js";
import type { ChannelName } from "./main/ipc-core.js";
import { createCentraidApi } from "./main/preload-core.js";
import type { PreloadBridge } from "./main/preload-core.js";

/** Refuse a channel the map does not carry, rather than forwarding it. */
function checked(channel: ChannelName): ChannelName {
  if (!(CHANNELS as readonly string[]).includes(channel)) {
    throw new Error(`${channel} is not a channel this build carries`);
  }
  return channel;
}

const bridge: PreloadBridge = {
  invoke: (channel, ...args) => ipcRenderer.invoke(checked(channel), ...args),
  on: (channel, listener) => {
    ipcRenderer.on(checked(channel), listener);
  },
  off: (channel, listener) => {
    ipcRenderer.off(checked(channel), listener);
  },
};

contextBridge.exposeInMainWorld("CentraidApi", createCentraidApi(bridge));
