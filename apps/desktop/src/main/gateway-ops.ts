/*
 * Gateway ops (issue #351) — electron wiring around the pure core in
 * gateway-ops-core.ts. The only seam this file adds over the core is real
 * `dialog.showSaveDialog` / `fs.writeFile` / `loadSettings` — see
 * gateway-ops-core.ts for the testable orchestration and local-gateway.ts
 * for the restart implementation (its IPC handler lives directly in
 * ipc.ts, alongside the other gateway-lifecycle handlers it shares
 * cache-invalidation + broadcast plumbing with).
 */

import { dialog } from 'electron';
import { promises as fs } from 'node:fs';
import { loadSettings } from './settings.js';
import {
  exportGatewayDiagnostics as exportGatewayDiagnosticsCore,
  exportGatewayRecoveryKit as exportGatewayRecoveryKitCore,
} from './gateway-ops-core.js';

export type { ExportDiagnosticsResult } from './gateway-ops-core.js';

/**
 * Fetch the active gateway's diagnostics bundle and save it through the
 * native save dialog. See `CentraidApi.exportGatewayDiagnostics` for the
 * renderer-facing contract this mirrors exactly.
 */
export function exportActiveGatewayDiagnostics() {
  return exportGatewayDiagnosticsCore({
    loadSettings,
    showSaveDialog: async (defaultPath) => {
      const result = await dialog.showSaveDialog({
        defaultPath,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      return {
        canceled: result.canceled,
        ...(result.filePath ? { filePath: result.filePath } : {}),
      };
    },
    writeFile: (path, data) => fs.writeFile(path, data, 'utf8'),
  });
}

export function exportActiveGatewayRecoveryKit() {
  return exportGatewayRecoveryKitCore({
    loadSettings,
    showSaveDialog: async (defaultPath) => {
      const result = await dialog.showSaveDialog({
        defaultPath,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      return {
        canceled: result.canceled,
        ...(result.filePath ? { filePath: result.filePath } : {}),
      };
    },
    writeFile: (file, data) => fs.writeFile(file, data, { encoding: 'utf8', mode: 0o600 }),
  });
}
