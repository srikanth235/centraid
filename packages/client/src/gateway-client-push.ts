import { auth, authHeaders, doFetch, readJson } from "./gateway-client-core.js";
import { notifyEventReminderBody } from "./notifications-copy.js";
import { composeWebNotifications } from "./notifications-model.js";
import type { NotificationsPull } from "./notifications-model.js";

const NOTIFICATION_CACHE = "centraid-private-notification-delivery-v1";
const NOTIFICATIONS_DELIVERY_KEY = "/__centraid_notifications__/delivered";
const REMINDER_DELIVERY_KEY = "/__centraid_notifications__/reminders";
/**
 * Ledger member recording that the Notifications delivery baseline has been taken for
 * this (gateway, vault). Not a notification key — never composed, never
 * matched by the service worker's membership test.
 */
const DELIVERY_SEEDED = "__seeded__";

/** Register the PWA only after the user has created reminder value. */
export async function enableWebPushWake(
  requestPermission: boolean
): Promise<boolean> {
  if (
    typeof window === "undefined" ||
    !("Notification" in window) ||
    !("serviceWorker" in navigator) ||
    !("PushManager" in window)
  )
    return false;
  let permission = Notification.permission;
  if (permission === "default" && requestPermission)
    permission = await Notification.requestPermission();
  if (permission !== "granted") return false;
  const registration = await navigator.serviceWorker.ready;
  const { baseUrl, token } = await auth();
  const keyResponse = await doFetch(
    baseUrl,
    "/centraid/_gateway/push/vapid-key",
    { headers: authHeaders(token) }
  );
  const { publicKey } = await readJson<{ publicKey: string }>(
    keyResponse,
    "load Web Push key"
  );
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlBytes(publicKey),
    }));
  const response = await doFetch(
    baseUrl,
    "/centraid/_gateway/push/registrations",
    {
      method: "POST",
      headers: authHeaders(token, "application/json"),
      body: JSON.stringify({
        platform: "web",
        subscription: subscription.toJSON(),
      }),
    }
  );
  await readJson(response, "register Web Push");
  return true;
}

/** Remove both browser and gateway registrations during an explicit unlink. */
export async function disableWebPushWake(): Promise<void> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager
    .getSubscription()
    .catch(() => null);
  const { baseUrl, token } = await auth();
  await doFetch(baseUrl, "/centraid/_gateway/push/registrations", {
    method: "DELETE",
    headers: authHeaders(token),
  }).catch(() => undefined);
  await subscription?.unsubscribe().catch(() => undefined);
}

interface WebDueReminder {
  key: string;
  kind: "task" | "event" | "tally" | "invite";
  id: string;
  title: string;
  at: string;
  minutesBefore: number;
}

/**
 * Turn an opaque Web Push wake into local notification content. The push
 * provider sees no title, vault, item, or balance; this authenticated fetch is
 * made only by the paired browser.
 */
export async function syncWebDueNotifications(): Promise<void> {
  if (
    typeof window === "undefined" ||
    !("Notification" in window) ||
    Notification.permission !== "granted" ||
    !("serviceWorker" in navigator)
  )
    return;
  const { baseUrl, token, vaultId } = await auth();
  const response = await doFetch(baseUrl, "/centraid/_reminders/due", {
    headers: authHeaders(token),
  });
  const { reminders } = await readJson<{ reminders?: WebDueReminder[] }>(
    response,
    "load due reminders"
  );
  const storageKey = `centraid:web-reminders:v1:${encodeURIComponent(
    `${baseUrl} ${vaultId ?? ""}`
  )}`;
  const raw = window.localStorage.getItem(storageKey);
  let deliveredValues: string[] = [];
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed))
        deliveredValues = parsed.filter(
          (value): value is string => typeof value === "string"
        );
    } catch {
      // A corrupt browser cache is disposable; authenticated gateway state is
      // canonical and will safely re-emit the bounded reminder window.
    }
  }
  const delivered = new Set([
    ...deliveredValues,
    ...(await readNotificationCache(REMINDER_DELIVERY_KEY)),
  ]);
  const registration = await navigator.serviceWorker.ready;
  const pending = (reminders ?? []).filter(
    (reminder) => !delivered.has(reminder.key)
  );
  await Promise.all(
    pending.map((reminder) =>
      registration.showNotification(reminder.title, {
        body:
          reminder.kind === "event"
            ? notifyEventReminderBody(reminder.minutesBefore)
            : "Task reminder",
        tag: reminder.key,
        data: {
          url:
            reminder.kind === "event"
              ? `/?agendaEvent=${encodeURIComponent(reminder.id)}`
              : "/?app=tasks",
        },
      })
    )
  );
  for (const reminder of pending) delivered.add(reminder.key);
  window.localStorage.setItem(
    storageKey,
    JSON.stringify([...delivered].slice(-2_000))
  );
  await writeNotificationCache(REMINDER_DELIVERY_KEY, delivered);
}

/**
 * Fetch private Notifications content locally after an opaque wake/SSE doorbell.
 *
 * Two guards keep this from banner-blasting the owner, because the callers
 * (useNotificationsCounts, the Notifications route) ring it on every load, poll, SSE event and
 * focus tick:
 *
 *  - A FOCUSED page composes nothing. The owner is looking at these rows in
 *    the UI; OS banners for what is already on screen are noise, and closed /
 *    backgrounded delivery is the service worker's job.
 *  - A page with NO delivery ledger yet (first run, or the moment permission
 *    is granted) seeds the ledger from the current payload silently. Without
 *    it, every already-open decision counts as newly delivered and fires at
 *    once.
 */
export async function syncWebNotifications(): Promise<void> {
  if (
    typeof window === "undefined" ||
    !("Notification" in window) ||
    Notification.permission !== "granted"
  )
    return;
  if (typeof document !== "undefined" && document.visibilityState === "visible")
    return;
  const { baseUrl, token, vaultId } = await auth();
  const response = await doFetch(baseUrl, "/centraid/_vault/notifications", {
    headers: authHeaders(token),
  });
  const notifications = await readJson<NotificationsPull>(
    response,
    "load Notifications"
  );
  const storageKey = `centraid:web-notifications:v1:${encodeURIComponent(
    `${baseUrl} ${vaultId ?? ""}`
  )}`;
  let prior: string[] = [];
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(storageKey) ?? "[]"
    );
    if (Array.isArray(parsed))
      prior = parsed.filter(
        (value): value is string => typeof value === "string"
      );
  } catch {
    // Disposable delivery cache; the gateway Notifications projection is canonical.
  }
  const cached = await readNotificationCache(NOTIFICATIONS_DELIVERY_KEY);
  const delivered = new Set([...prior, ...cached]);
  // Deliver-silently baseline: no ledger means "we have never notified for
  // this (gateway, vault)", not "everything currently open is brand new". The
  // sentinel is what makes that a one-time decision — an EMPTY pull would
  // otherwise leave the ledger empty and re-arm the blast for the next
  // payload. It rides in the same array of strings the service worker reads
  // (membership only), so the shared ledger format is unchanged, and it can
  // never collide with a composed key (all of which are `prefix:…`).
  const seeding = !delivered.has(DELIVERY_SEEDED);
  const rows = composeWebNotifications(notifications, delivered);
  if (seeding) {
    delivered.add(DELIVERY_SEEDED);
    for (const row of rows) delivered.add(row.key);
    window.localStorage.setItem(
      storageKey,
      JSON.stringify([...delivered].slice(-2_000))
    );
    await writeNotificationCache(NOTIFICATIONS_DELIVERY_KEY, delivered);
    return;
  }
  const registration =
    "serviceWorker" in navigator
      ? await navigator.serviceWorker.ready.catch(() => undefined)
      : undefined;
  await Promise.all(
    rows.map(async (row) => {
      if (registration) {
        await registration.showNotification(row.title, {
          body: row.body,
          tag: row.key,
          data: { url: "/?notifications=1" },
        });
        return;
      }
      const notification = new Notification(row.title, {
        body: row.body,
        tag: row.key,
      });
      notification.addEventListener("click", () => {
        window.focus();
        window.location.assign("/?notifications=1");
      });
    })
  );
  for (const row of rows) delivered.add(row.key);
  // Keep the sentinel at the tail so the bounded slice can never evict it and
  // silently re-arm the seeding path.
  delivered.delete(DELIVERY_SEEDED);
  delivered.add(DELIVERY_SEEDED);
  window.localStorage.setItem(
    storageKey,
    JSON.stringify([...delivered].slice(-2_000))
  );
  await writeNotificationCache(NOTIFICATIONS_DELIVERY_KEY, delivered);
}

async function readNotificationCache(key: string): Promise<string[]> {
  if (typeof caches === "undefined") return [];
  try {
    const cache = await caches.open(NOTIFICATION_CACHE);
    const response = await cache.match(key);
    const parsed: unknown = response ? await response.json() : [];
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

async function writeNotificationCache(
  key: string,
  delivered: ReadonlySet<string>
): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    const cache = await caches.open(NOTIFICATION_CACHE);
    await cache.put(
      key,
      new Response(JSON.stringify([...delivered].slice(-2_000)), {
        headers: { "content-type": "application/json" },
      })
    );
  } catch {
    // A delivery cache is disposable; authenticated gateway state is canonical.
  }
}

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = `${value}${"=".repeat((4 - (value.length % 4)) % 4)}`
    .replace(/-/gu, "+")
    .replace(/_/gu, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index++)
    bytes[index] = raw.charCodeAt(index);
  return bytes;
}
