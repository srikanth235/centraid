/*
 * Persist main window bounds (issue #468 K13).
 * Debounced writes while resizing; flush sync on close / before-quit.
 * Clamped to a visible display work area so a disconnected monitor
 * cannot hide the window off-screen.
 */

import { app, screen, type BrowserWindow, type Rectangle } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const FILE = 'window-state.json';
const DEBOUNCE_MS = 400;

export interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized?: boolean;
}

const DEFAULTS: WindowState = { width: 1400, height: 900, x: 80, y: 60 };

function statePath(): string {
  return path.join(app.getPath('userData'), FILE);
}

function clampToDisplay(state: WindowState): WindowState {
  const displays = screen.getAllDisplays();
  if (displays.length === 0) return state;
  const width = Math.max(400, state.width);
  const height = Math.max(300, state.height);
  // Prefer the display that contains the saved origin; fall back to primary.
  let display =
    displays.find((d) => {
      const b = d.workArea;
      return (
        state.x >= b.x && state.x < b.x + b.width && state.y >= b.y && state.y < b.y + b.height
      );
    }) ?? screen.getPrimaryDisplay();
  const area = display.workArea;
  const x = Math.min(Math.max(state.x, area.x), area.x + area.width - 100);
  const y = Math.min(Math.max(state.y, area.y), area.y + area.height - 100);
  return {
    x,
    y,
    width: Math.min(width, area.width),
    height: Math.min(height, area.height),
    ...(state.isMaximized ? { isMaximized: true } : {}),
  };
}

export function loadWindowState(): WindowState {
  try {
    const raw = readFileSync(statePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<WindowState>;
    if (
      typeof parsed.width !== 'number' ||
      typeof parsed.height !== 'number' ||
      typeof parsed.x !== 'number' ||
      typeof parsed.y !== 'number'
    ) {
      return { ...DEFAULTS };
    }
    return clampToDisplay({
      x: parsed.x,
      y: parsed.y,
      width: parsed.width,
      height: parsed.height,
      ...(parsed.isMaximized ? { isMaximized: true } : {}),
    });
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveWindowStateSync(state: WindowState): void {
  try {
    const dir = path.dirname(statePath());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(statePath(), JSON.stringify(state), { mode: 0o600 });
  } catch (err) {
    process.stdout.write(`[window-state] save failed: ${String(err)}\n`);
  }
}

function capture(win: BrowserWindow): WindowState {
  const isMaximized = win.isMaximized();
  // When maximized, bounds are the work area; persist pre-maximize if available.
  const bounds: Rectangle = isMaximized ? win.getNormalBounds() : win.getBounds();
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    ...(isMaximized ? { isMaximized: true } : {}),
  };
}

/** Wire debounced persist + sync flush on close for one BrowserWindow. */
export function trackWindowState(win: BrowserWindow): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (win.isDestroyed()) return;
      saveWindowStateSync(capture(win));
    }, DEBOUNCE_MS);
    timer.unref?.();
  };
  const flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (win.isDestroyed()) return;
    saveWindowStateSync(capture(win));
  };

  win.on('resize', schedule);
  win.on('move', schedule);
  win.on('close', flush);

  return flush;
}
