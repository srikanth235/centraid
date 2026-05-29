import { app, BrowserWindow, nativeImage, protocol, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installAuthInjector } from './main/auth-injector.js';
import { importAvailableCreds } from './main/auth-import.js';
import { disposeWindowSession, registerIpcHandlers } from './main/ipc.js';
import { PREVIEW_SCHEME, registerPreviewProtocol } from './main/preview-protocol.js';
import { loadSettings, saveSettings, templatesCacheDir } from './main/settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Icon lives at the package root (../../icon.png from dist/main.js); used
// for the BrowserWindow on Windows/Linux and the macOS dock during dev.
// Packaged builds will pick up the .icns via electron-builder config.
const ICON_PATH = path.join(__dirname, '..', 'icon.png');

// Custom scheme that serves an unpublished project's local files into the
// builder's preview iframe. Must be marked privileged BEFORE `app.whenReady`
// for module scripts and `fetch` to behave like a real origin inside the
// iframe (matches what the gateway provides for published apps).
protocol.registerSchemesAsPrivileged([
  {
    scheme: PREVIEW_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

function canOpenExternal(url: string): boolean {
  try {
    return ['https:', 'http:', 'mailto:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    backgroundColor: '#e8e9ec',
    height: 900,
    icon: ICON_PATH,
    minHeight: 720,
    minWidth: 1100,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
    },
    width: 1400,
  });

  void win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (canOpenExternal(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  win.webContents.on('console-message', (_event, level, message, line, source) => {
    const prefix = level >= 2 ? 'RENDERER-ERR' : 'RENDERER';
    process.stdout.write(`[${prefix}] ${message} (${source}:${line})\n`);
  });

  win.on('closed', () => {
    void disposeWindowSession(win.id);
  });
}

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(nativeImage.createFromPath(ICON_PATH));
  }
  registerPreviewProtocol();
  void installAuthInjector();
  registerIpcHandlers();
  createWindow();
  // Kick off a background check for template updates. Fire-and-forget — the
  // fetcher is silent on every failure (offline, 404, parse error, etc.) so
  // the home grid keeps showing whatever's in cache + bundle regardless.
  void backgroundFetchTemplates();
  // First-launch credential probe. Reads Claude Code (macOS keychain) and
  // Codex (`~/.codex/auth.json`) to populate the Settings → AI providers
  // status card so the user can see which CLIs are already installed.
  // No credentials are copied — each backend reads its own auth in place
  // (codex from `~/.codex/auth.json`, Claude SDK from `ANTHROPIC_API_KEY`).
  void firstLaunchAuthImport();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

async function backgroundFetchTemplates(): Promise<void> {
  try {
    const settings = await loadSettings();
    if (!settings.remoteTemplatesUrl) return;
    const { fetchRemoteTemplates } = await import('@centraid/app-templates');
    await fetchRemoteTemplates({
      cacheDir: templatesCacheDir(settings.activeGatewayId),
      remoteUrl: settings.remoteTemplatesUrl,
    });
  } catch (err) {
    console.error('[centraid] templates background fetch failed:', err);
  }
}

async function firstLaunchAuthImport(): Promise<void> {
  try {
    const settings = await loadSettings();
    if (settings.authImportedAt) return;
    const result = await importAvailableCreds({ overwrite: false });
    // Always stamp the marker — even when nothing was found, so we don't
    // re-prompt the macOS keychain dialog on every subsequent launch. The
    // user can still trigger an explicit import via Settings → Re-sync,
    // which always overwrites and refreshes the marker.
    await saveSettings({ authImportedAt: new Date().toISOString() });
    // The Settings → AI providers panel surfaces the result; nothing to do here.
    void result;
  } catch (err) {
    console.error('[centraid] first-launch auth import failed:', err);
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
