import { promises as fs } from "node:fs";

import { dialog } from "electron";

import {
  exportGatewayDiagnostics as exportGatewayDiagnosticsCore,
  exportGatewayRecoveryKit as exportGatewayRecoveryKitCore,
} from "./gateway-ops-core.js";
import { loadSettings } from "./settings.js";

export function exportActiveGatewayDiagnostics() {
  return exportGatewayDiagnosticsCore({
    loadSettings,
    showSaveDialog: async (defaultPath) => {
      const result = await dialog.showSaveDialog({
        defaultPath,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      return {
        canceled: result.canceled,
        ...(result.filePath ? { filePath: result.filePath } : {}),
      };
    },
    writeFile: (path, data) => fs.writeFile(path, data, "utf8"),
  });
}

export function exportActiveGatewayRecoveryKit(input: { password: string }) {
  return exportGatewayRecoveryKitCore(
    {
      loadSettings,
      showSaveDialog: async (defaultPath) => {
        const result = await dialog.showSaveDialog({
          defaultPath,
          filters: [{ name: "JSON", extensions: ["json"] }],
        });
        return {
          canceled: result.canceled,
          ...(result.filePath ? { filePath: result.filePath } : {}),
        };
      },
      writeFile: (file, data) =>
        fs.writeFile(file, data, { encoding: "utf8", mode: 0o600 }),
    },
    input
  );
}
