// Bridges shared design tokens AND the centraid IPC API into the renderer.
// Renderer runs with contextIsolation=true and no node integration. We expose
// JSON-cloneable values + IPC proxies via contextBridge.
//
// This file is bundled to CJS by `bun build` (Electron `sandbox: true` requires
// CJS preload). Renderer typings live in `@centraid/client`'s `centraid-api.d.ts`.
//
// Deliberately a THIN shell: everything with behaviour lives in
// `main/preload-core.ts`, which is Electron-free and unit-tested
// (`main/preload-core.test.ts`). All this file does is adapt `ipcRenderer`
// into the narrow `PreloadBridge` seam and expose the two built objects, so
// the untestable part stays trivially correct by inspection.

import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";

import * as tokens from "@centraid/design-tokens";

import type { PreloadBridge } from "./main/preload-core.js";
import {
  createCentraidApi,
  createCentraidTokens,
} from "./main/preload-core.js";

// The one place `ipcRenderer` is touched: a pure pass-through. Electron
// stores listeners per (channel, function) pair, so `off` with the same
// function detaches exactly what `on` attached — the core relies on that.
const bridge: PreloadBridge = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, listener) => {
    ipcRenderer.on(channel, listener as (event: IpcRendererEvent) => void);
  },
  off: (channel, listener) => {
    ipcRenderer.off(channel, listener as (event: IpcRendererEvent) => void);
  },
};

contextBridge.exposeInMainWorld("CentraidTokens", createCentraidTokens(tokens));
contextBridge.exposeInMainWorld("CentraidApi", createCentraidApi(bridge));
