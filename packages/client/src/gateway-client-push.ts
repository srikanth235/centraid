import { auth, authHeaders, doFetch, readJson } from "./gateway-client-core.js";
import { composeWebInboxNotifications } from "./inbox-notification-model.js";
import type { InboxNotificationPull } from "./inbox-notification-model.js";

const NOTIFICATION_CACHE = "centraid-private-notification-delivery-v1";
const INBOX_DELIVERY_KEY = "/__centraid_notifications__/inbox";
const REMINDER_DELIVERY_KEY = "/__centraid_notifications__/reminders";

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
            ? reminder.minutesBefore === 0
              ? "Starting now"
              : `Starts in ${reminder.minutesBefore} minutes`
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

/** Fetch private Inbox content locally after an opaque wake/SSE doorbell. */
export async function syncWebInboxNotifications(): Promise<void> {
  if (
    typeof window === "undefined" ||
    !("Notification" in window) ||
    Notification.permission !== "granted"
  )
    return;
  const { baseUrl, token, vaultId } = await auth();
  const response = await doFetch(baseUrl, "/centraid/_vault/inbox", {
    headers: authHeaders(token),
  });
  const inbox = await readJson<InboxNotificationPull>(
    response,
    "load Inbox notifications"
  );
  const storageKey = `centraid:web-inbox:v1:${encodeURIComponent(
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
    // Disposable delivery cache; the gateway Inbox is canonical.
  }
  const delivered = new Set([
    ...prior,
    ...(await readNotificationCache(INBOX_DELIVERY_KEY)),
  ]);
  const rows = composeWebInboxNotifications(inbox, delivered);
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
          data: { url: "/?inbox=1" },
        });
        return;
      }
      const notification = new Notification(row.title, {
        body: row.body,
        tag: row.key,
      });
      notification.addEventListener("click", () => {
        window.focus();
        window.location.assign("/?inbox=1");
      });
    })
  );
  for (const row of rows) delivered.add(row.key);
  window.localStorage.setItem(
    storageKey,
    JSON.stringify([...delivered].slice(-2_000))
  );
  await writeNotificationCache(INBOX_DELIVERY_KEY, delivered);
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
