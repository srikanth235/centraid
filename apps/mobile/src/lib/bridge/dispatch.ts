// RN-side dispatcher for the WebView ↔ shell bridge (issue #14, Phase C).
//
// Each method is awaited and returns either a value (resolved on the WebView
// side) or throws a `BridgeFailureError` with a stable code. The dispatcher
// converts both into the wire `BridgeResponse` envelope.

import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import { SchedulableTriggerInputTypes } from 'expo-notifications';
import type { BridgeMethod, BridgeRequest, BridgeResponse } from './protocol';

class BridgeFailureError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BridgeFailureError';
  }
}

// --- Helpers ---

function asObject(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new BridgeFailureError('invalid_args', `Missing or invalid "${key}"`);
  }
  return v;
}

function requireDate(obj: Record<string, unknown>, key: string): Date {
  const v = obj[key];
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'string') {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  throw new BridgeFailureError(
    'invalid_args',
    `Missing or invalid "${key}" (expected Date | number)`,
  );
}

function requireNumber(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new BridgeFailureError('invalid_args', `Missing or invalid "${key}"`);
  }
  return v;
}

// --- Permission gate ---
// Cached for the lifetime of the WebView screen. We do NOT silently fail
// when undetermined — the first schedule call triggers the prompt.

let cachedNotifyPermission: boolean | undefined;

async function ensureNotificationsPermission(): Promise<void> {
  if (cachedNotifyPermission === true) return;
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) {
    cachedNotifyPermission = true;
    return;
  }
  if (current.canAskAgain === false) {
    cachedNotifyPermission = false;
    throw new BridgeFailureError(
      'permission_denied',
      'Notification permission denied. Enable it in system settings.',
    );
  }
  const next = await Notifications.requestPermissionsAsync();
  if (!next.granted) {
    cachedNotifyPermission = false;
    throw new BridgeFailureError('permission_denied', 'Notification permission denied.');
  }
  cachedNotifyPermission = true;
}

// --- Method handlers ---
//
// Notify ids are namespaced per app so two apps can't collide on the same
// short id (e.g. both using `daily`). Pass `appId` through from the
// dispatcher entry point.

function scopedId(appId: string, id: string): string {
  return `${appId}::${id}`;
}

async function handleNotifySchedule(appId: string, args: unknown): Promise<void> {
  const a = asObject(args);
  const id = requireString(a, 'id');
  const title = requireString(a, 'title');
  const body = typeof a.body === 'string' ? a.body : '';
  const at = requireDate(a, 'at');
  await ensureNotificationsPermission();

  await Notifications.scheduleNotificationAsync({
    identifier: scopedId(appId, id),
    content: { title, body },
    trigger: { type: SchedulableTriggerInputTypes.DATE, date: at },
  });
}

async function handleNotifyCancel(appId: string, args: unknown): Promise<void> {
  const a = asObject(args);
  const id = requireString(a, 'id');
  await Notifications.cancelScheduledNotificationAsync(scopedId(appId, id));
}

async function handleHapticImpact(args: unknown): Promise<void> {
  const a = asObject(args);
  const style = a.style;
  const map: Record<string, Haptics.ImpactFeedbackStyle> = {
    heavy: Haptics.ImpactFeedbackStyle.Heavy,
    light: Haptics.ImpactFeedbackStyle.Light,
    medium: Haptics.ImpactFeedbackStyle.Medium,
  };
  const chosen = typeof style === 'string' ? map[style] : undefined;
  await Haptics.impactAsync(chosen ?? Haptics.ImpactFeedbackStyle.Light);
}

async function handleHapticSelection(): Promise<void> {
  await Haptics.selectionAsync();
}

async function handleHapticSuccess(): Promise<void> {
  await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
}

/**
 * Background timer. On iOS the JS thread is suspended when backgrounded, so
 * an honest in-process timer would miss its deadline. We schedule a local
 * notification at `now + durationMs` instead — fires on time regardless of
 * app state. Foreground apps can still implement their own UI countdown;
 * this just guarantees the *completion event* reaches the user.
 */
async function handleTimerStartBackground(appId: string, args: unknown): Promise<void> {
  const a = asObject(args);
  const id = requireString(a, 'id');
  const durationMs = requireNumber(a, 'durationMs');
  if (durationMs <= 0) {
    throw new BridgeFailureError('invalid_args', '"durationMs" must be > 0');
  }
  const title = typeof a.title === 'string' ? a.title : 'Timer finished';
  const body = typeof a.body === 'string' ? a.body : '';
  await ensureNotificationsPermission();

  const at = new Date(Date.now() + durationMs);
  await Notifications.scheduleNotificationAsync({
    identifier: scopedId(appId, `timer:${id}`),
    content: { title, body },
    trigger: { type: SchedulableTriggerInputTypes.DATE, date: at },
  });
}

async function handleTimerCancel(appId: string, args: unknown): Promise<void> {
  const a = asObject(args);
  const id = requireString(a, 'id');
  await Notifications.cancelScheduledNotificationAsync(scopedId(appId, `timer:${id}`));
}

// --- Public entry ---

const HANDLERS: Record<BridgeMethod, (appId: string, args: unknown) => Promise<unknown>> = {
  'haptic.impact': (_appId, args) => handleHapticImpact(args),
  'haptic.selection': () => handleHapticSelection(),
  'haptic.success': () => handleHapticSuccess(),
  'notify.cancel': handleNotifyCancel,
  'notify.schedule': handleNotifySchedule,
  'timer.cancel': handleTimerCancel,
  'timer.startBackground': handleTimerStartBackground,
};

export async function dispatch(appId: string, req: BridgeRequest): Promise<BridgeResponse> {
  const handler = HANDLERS[req.method];
  if (!handler) {
    return {
      error: { code: 'unknown_method', message: `Unknown method "${req.method}"` },
      id: req.id,
      ok: false,
    };
  }
  try {
    const value = await handler(appId, req.args);
    return { id: req.id, ok: true, value };
  } catch (err) {
    if (err instanceof BridgeFailureError) {
      return { error: { code: err.code, message: err.message }, id: req.id, ok: false };
    }
    return {
      error: {
        code: 'unhandled',
        message: err instanceof Error ? err.message : String(err),
      },
      id: req.id,
      ok: false,
    };
  }
}
