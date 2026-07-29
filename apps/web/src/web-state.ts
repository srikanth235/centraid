const PREFIX = "centraid.web.v1.";

export interface WebConnection {
  /** Refreshable iroh dial cache; never used as connection identity. */
  endpointTicket?: string;
  /** Stable sovereign gateway EndpointId and connection identity. */
  endpointId?: string;
  vaultId?: string;
  label: string;
  displayName: string;
  avatarColor: string;
  /** Offline-copy consent from pairing: encrypted replica, queued changes and
   *  cached previews. It does NOT govern whether the pairing itself survives —
   *  the enrollment is always durable (see `saveConnection`). */
  rememberDevice?: boolean;
}

const DEFAULT_CONNECTION: WebConnection = {
  label: "Web gateway",
  displayName: "Centraid",
  avatarColor: "#6f5bf6",
  rememberDevice: false,
};

export function loadConnection(): WebConnection {
  try {
    // localStorage first: it is where every write now lands. The sessionStorage
    // read is migration only, for a tab that paired before the enrollment
    // became unconditionally durable.
    const raw =
      localStorage.getItem(`${PREFIX}connection`) ??
      sessionStorage.getItem(`${PREFIX}connection`) ??
      "{}";
    const parsed = JSON.parse(raw) as Partial<WebConnection>;
    return { ...DEFAULT_CONNECTION, ...parsed };
  } catch {
    return { ...DEFAULT_CONNECTION };
  }
}

/**
 * The connection is ALWAYS durable. It used to follow `rememberDevice`, which
 * put the enrollment in sessionStorage by default — so closing the browser
 * silently unpaired a device that had already been paired, and the only route
 * back was minting a fresh ticket. `rememberDevice` now governs the offline
 * copy (replica, queued changes, cached previews) and nothing else; dropping
 * this device is an explicit act (`removeGateway`), not a side effect of
 * quitting the browser.
 */
export function saveConnection(patch: Partial<WebConnection>): WebConnection {
  const next = { ...loadConnection(), ...patch };
  const key = `${PREFIX}connection`;
  localStorage.setItem(key, JSON.stringify(next));
  sessionStorage.removeItem(key);
  return next;
}

/** Stable replica identity for the sovereign gateway behind a web transport. */
export function webGatewayId(connection: WebConnection): string | undefined {
  return connection.endpointId;
}

export function loadSettingsPatch(): Record<string, unknown> {
  try {
    return JSON.parse(
      localStorage.getItem(`${PREFIX}settings`) ?? "{}"
    ) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Fired after every settings write, carrying the merged result. The chrome
 *  listens so surfaces gated on onboarding state react the moment it flips,
 *  without polling (issue #603 W6). */
export const SETTINGS_EVENT = "settings-saved";

export function saveSettingsPatch(
  patch: Record<string, unknown>
): Record<string, unknown> {
  const next = { ...loadSettingsPatch(), ...patch };
  localStorage.setItem(`${PREFIX}settings`, JSON.stringify(next));
  publish(SETTINGS_EVENT, next);
  return next;
}

export async function gatewayFetch(
  pathname: string,
  init: RequestInit = {}
): Promise<Response> {
  const connection = loadConnection();
  if (!connection.endpointId || !connection.endpointTicket) {
    throw new Error("No gateway is connected.");
  }
  if (!window.CentraidIroh)
    throw new Error("Iroh browser transport is not installed.");
  return window.CentraidIroh.fetch(pathname, init);
}

export async function gatewayJson<T>(
  pathname: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await gatewayFetch(pathname, init);
  const text = await response.text();
  if (!response.ok)
    throw new Error(text || `Gateway returned HTTP ${response.status}`);
  return JSON.parse(text) as T;
}

export const webEvents = new EventTarget();

export function subscribe<T>(
  name: string,
  callback: (detail: T) => void
): () => void {
  const listener = (event: Event): void =>
    callback((event as CustomEvent<T>).detail);
  webEvents.addEventListener(name, listener);
  return () => webEvents.removeEventListener(name, listener);
}

export function publish<T>(name: string, detail: T): void {
  webEvents.dispatchEvent(new CustomEvent(name, { detail }));
}

export function decodeTicket(raw: string):
  | {
      vaultName?: string;
      exp?: number;
      gw?: string;
      ticketId?: string;
      secret?: string;
    }
  | undefined {
  try {
    const base64 = raw.trim().replaceAll("-", "+").replaceAll("_", "/");
    const decoded = JSON.parse(atob(base64)) as Record<string, unknown>;
    if (decoded["kind"] !== "centraid-gw-pair") return undefined;
    return {
      ...(typeof decoded["vaultName"] === "string"
        ? { vaultName: decoded["vaultName"] }
        : {}),
      ...(typeof decoded["exp"] === "number" ? { exp: decoded["exp"] } : {}),
      ...(typeof decoded["gw"] === "string" ? { gw: decoded["gw"] } : {}),
      ...(typeof decoded["t"] === "string" ? { ticketId: decoded["t"] } : {}),
      ...(typeof decoded["s"] === "string" ? { secret: decoded["s"] } : {}),
    };
  } catch {
    return undefined;
  }
}
