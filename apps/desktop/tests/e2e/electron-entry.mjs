import { app } from "electron";

const proxyMap = JSON.parse(process.env.CENTRAID_E2E_IROH_PROXY_MAP ?? "{}");
const { setIrohProxyResolverForTests } =
  await import("../../dist/main/iroh-dialer.js");
setIrohProxyResolverForTests(async (connectionId) => {
  const url = proxyMap[connectionId];
  if (typeof url !== "string" || url.length === 0) {
    throw new Error(`E2E has no iroh proxy target for ${connectionId}`);
  }
  return url;
});

app.commandLine.appendSwitch("password-store", "gnome-libsecret");

if (!process.env.CI && process.env.E2E_SHOW_WINDOW !== "1") {
  app.on("browser-window-created", (_event, win) => {
    win.webContents.setBackgroundThrottling(false);
    win.once("ready-to-show", () => win.hide());
    win.hide();
  });
}

await import("../../dist/main.js");
