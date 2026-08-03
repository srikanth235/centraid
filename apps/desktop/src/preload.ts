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

import * as tokens from "@centraid/design";
import { toFontFaceCss } from "@centraid/design/fonts";

import type { PreloadBridge } from "./main/preload-core.js";
import {
  createCentraidApi,
  createCentraidTokens,
} from "./main/preload-core.js";

// Where the renderer finds the vendored `.woff2` faces.
//
// The shell document is loaded with `win.loadFile(dist/renderer/index.html)`,
// so its base URL is `file://…/dist/renderer/`. A RELATIVE base is therefore
// mandatory: an absolute `/fonts/…` would resolve to `file:///fonts/…`, the
// same class of bug that broke the replica's sqlite worker before the Vite
// `base: './'` fix. `scripts/copy-fonts.mjs` puts the files exactly here, and
// the shell's CSP already allows `font-src 'self'`.
const FONT_BASE = "fonts";

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

contextBridge.exposeInMainWorld(
  "CentraidTokens",
  createCentraidTokens(tokens, toFontFaceCss(FONT_BASE))
);
contextBridge.exposeInMainWorld("CentraidApi", createCentraidApi(bridge));
