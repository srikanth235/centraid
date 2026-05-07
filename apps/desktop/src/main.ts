import { app, BrowserWindow, shell } from 'electron';
import * as path from 'node:path';

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
    minHeight: 720,
    minWidth: 1100,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
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

  // Surface renderer console messages to stdout so we can spot errors
  // during a headless smoke launch.
  win.webContents.on('console-message', (_event, level, message, line, source) => {
    const prefix = level >= 2 ? 'RENDERER-ERR' : 'RENDERER';
    process.stdout.write(`[${prefix}] ${message} (${source}:${line})\n`);
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
