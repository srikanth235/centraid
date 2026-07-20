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
} from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tray: Tray | null = null;
let gatewayRunning = false;

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

export function installTray(iconPath?: string): void {
  if (tray) return;
  const resolved = iconPath ?? path.join(__dirname, '..', 'icon.png');
  const image = nativeImage.createFromPath(resolved);
  tray = new Tray(
    image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 }),
  );
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
    process.stdout.write(`[deep-link] ${url}\n`);
    focusMainWindow();
    const [win] = BrowserWindow.getAllWindows();
    win?.webContents.send('centraid:deep-link', url);
  };

  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleUrl(url);
  });

  // Windows/Linux: protocol URL arrives as a process argv on second-instance.
  app.on('second-instance', (_event, argv) => {
    const url = argv.find((a) => a.startsWith('centraid://'));
    if (url) handleUrl(url);
  });
}
