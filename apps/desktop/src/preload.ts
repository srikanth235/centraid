// Bridges design tokens AND the centraid IPC API into the renderer.
// contextIsolation=true, no node integration. Bundled to CJS (`sandbox: true`).
// Thin shell: behaviour lives in `main/preload-core.ts`.

import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";

import * as tokens from "@centraid/design";
// `/font-faces`, never `/fonts`: this module is bundled into the SANDBOXED
// preload, where `require("node:path")` does not resolve (#707).
import { toFontFaceCss } from "@centraid/design/font-faces";

import type { PreloadBridge } from "./main/preload-core.js";
import {
  createCentraidApi,
  createCentraidTokens,
} from "./main/preload-core.js";

// Relative base is mandatory: the shell document's URL is
// `file://…/dist/renderer/`. An absolute `/fonts/…` resolves to `file:///fonts/…`.
const FONT_BASE = "fonts";

// The one place `ipcRenderer` is touched. Electron stores listeners per
// (channel, function) pair — `off` with the same function detaches `on`.
const bridge: PreloadBridge = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, listener) => {
    ipcRenderer.on(channel, listener as (event: IpcRendererEvent) => void);
  },
  off: (channel, listener) => {
    ipcRenderer.off(channel, listener as (event: IpcRendererEvent) => void);
  },
};

contextBridge.exposeInMainWorld(
  "CentraidTokens",
  createCentraidTokens(tokens, toFontFaceCss(FONT_BASE))
);
contextBridge.exposeInMainWorld("CentraidApi", createCentraidApi(bridge));
