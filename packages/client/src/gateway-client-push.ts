import { auth, authHeaders, doFetch, readJson } from "./gateway-client-core.js";

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
  const delivered = new Set(deliveredValues);
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
