import { app } from "electron";

export function applyLaunchAtLogin(enabled: boolean | undefined): void {
  if (process.platform === "linux") return;
  app.setLoginItemSettings({ openAtLogin: enabled === true });
}
