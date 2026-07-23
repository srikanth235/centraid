/*
 * Application menu, tray, and deep-link scaffolding (issue #468 K14).
 * Registers centraid:// as the default protocol; tray shows gateway status.
 */

import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  type MenuItemConstructorOptions,
  type NativeImage,
} from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isOAuthFinishDeepLink } from './oauth-deep-link.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tray: Tray | null = null;
let gatewayRunning = false;
const pendingDeepLinks: string[] = [];

function focusMainWindow(): void {
  const [win] = BrowserWindow.getAllWindows();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  const status = gatewayRunning ? 'Gateway: running' : 'Gateway: stopped';
  tray.setToolTip(`Centraid — ${status}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: status, enabled: false },
      { type: 'separator' },
      { label: 'Open Centraid', click: () => focusMainWindow() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
}

export function setTrayGatewayRunning(running: boolean): void {
  gatewayRunning = running;
  rebuildTrayMenu();
}

export function installApplicationMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * The tray image. On macOS the menu bar wants a monochrome **template** image
 * so the OS tints it to the bar (light/dark, active-highlight) — exactly how
 * the other status items render. A colored icon ignores that and looks out of
 * place, so we load the black-on-transparent `iconTemplate.png` (its sibling
 * `iconTemplate@2x.png` is auto-picked for Retina) and flag it as a template
 * rather than resizing the full-color app icon. Windows/Linux trays are not
 * auto-tinted, so they keep the color icon.
 */
function loadTrayImage(colorIconPath: string): NativeImage {
  if (process.platform === 'darwin') {
    const templatePath = path.join(path.dirname(colorIconPath), 'iconTemplate.png');
    const templ = nativeImage.createFromPath(templatePath);
    if (!templ.isEmpty()) {
      templ.setTemplateImage(true);
      return templ;
    }
    // Fall through to the color icon if the template asset is missing.
  }
  const image = nativeImage.createFromPath(colorIconPath);
  return image.isEmpty() ? image : image.resize({ width: 16, height: 16 });
}

export function installTray(iconPath?: string): void {
  if (tray) return;
  const colorIcon = iconPath ?? path.join(__dirname, '..', 'icon.png');
  const image = loadTrayImage(colorIcon);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  rebuildTrayMenu();
  tray.on('click', () => focusMainWindow());
}

/** Register centraid:// (and hand off second-instance deep links). */
export function installDeepLinkProtocol(): void {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('centraid', process.execPath, [
        path.resolve(process.argv[1]!),
      ]);
    }
  } else {
    app.setAsDefaultProtocolClient('centraid');
  }

  const handleUrl = (url: string): void => {
    if (!isOAuthFinishDeepLink(url)) return;
    process.stdout.write('[deep-link] OAuth finish handoff received\n');
    focusMainWindow();
    const [win] = BrowserWindow.getAllWindows();
    if (!win) {
      if (pendingDeepLinks.length < 4) pendingDeepLinks.push(url);
      return;
    }
    deliverDeepLink(win, url);
  };

  app.on('browser-window-created', (_event, win) => {
    win.webContents.once('did-finish-load', () => {
      for (;;) {
        const url = pendingDeepLinks.shift();
        if (!url) break;
        win.webContents.send('centraid:deep-link', url);
      }
    });
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleUrl(url);
  });

  // Windows/Linux: protocol URL arrives as a process argv on second-instance.
  app.on('second-instance', (_event, argv) => {
    const url = argv.find((a) => a.startsWith('centraid://'));
    if (url) handleUrl(url);
  });

  // Cold-start protocol launches arrive in the first instance's argv.
  const initialUrl = process.argv.find((argument) => isOAuthFinishDeepLink(argument));
  if (initialUrl) queueMicrotask(() => handleUrl(initialUrl));
}

function deliverDeepLink(win: BrowserWindow, url: string): void {
  if (win.webContents.isLoadingMainFrame()) {
    win.webContents.once('did-finish-load', () => win.webContents.send('centraid:deep-link', url));
    return;
  }
  win.webContents.send('centraid:deep-link', url);
}
