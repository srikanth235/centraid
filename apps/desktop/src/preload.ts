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

const FONT_BASE = "fonts";

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
