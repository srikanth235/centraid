const PREFIX = 'centraid.web.v1.';

export interface WebConnection {
  baseUrl: string;
  transport?: 'direct' | 'iroh';
  /** Iroh EndpointTicket; contains dial information, never the one-time pairing secret. */
  endpointTicket?: string;
  endpointId?: string;
  /** Sovereign gateway EndpointId returned by Iroh pairing. */
  gatewayId?: string;
  token?: string;
  vaultId?: string;
  label: string;
  displayName: string;
  avatarColor: string;
  control?: boolean;
  /** Explicit durable-storage consent from pairing. */
  rememberDevice?: boolean;
}

const DEFAULT_CONNECTION: WebConnection = {
  baseUrl: '',
  label: 'Web gateway',
  displayName: 'Centraid',
  avatarColor: '#6f5bf6',
  rememberDevice: false,
};

export function loadConnection(): WebConnection {
  try {
    const raw =
      sessionStorage.getItem(`${PREFIX}connection`) ??
      localStorage.getItem(`${PREFIX}connection`) ??
      '{}';
    const parsed = JSON.parse(raw) as Partial<WebConnection>;
    return { ...DEFAULT_CONNECTION, ...parsed };
  } catch {
    return { ...DEFAULT_CONNECTION };
  }
}

export function saveConnection(patch: Partial<WebConnection>): WebConnection {
  const next = { ...loadConnection(), ...patch };
  const key = `${PREFIX}connection`;
  const durable = next.rememberDevice === true;
  const target = durable ? localStorage : sessionStorage;
  const stale = durable ? sessionStorage : localStorage;
  target.setItem(key, JSON.stringify(next));
  stale.removeItem(key);
  return next;
}

/** Stable replica identity for the sovereign gateway behind a web transport. */
export function webGatewayId(connection: WebConnection): string | undefined {
  if (connection.transport === 'iroh' && (connection.gatewayId || connection.endpointTicket)) {
    return `iroh:${connection.gatewayId ?? connection.endpointTicket}`;
  }
  if (!connection.baseUrl) return undefined;
  try {
    const url = new URL(connection.baseUrl);
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return `direct:${url.toString()}`;
  } catch {
    return `direct:${connection.baseUrl.replace(/\/+$/, '')}`;
  }
}

export function loadSettingsPatch(): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(`${PREFIX}settings`) ?? '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function saveSettingsPatch(patch: Record<string, unknown>): Record<string, unknown> {
  const next = { ...loadSettingsPatch(), ...patch };
  localStorage.setItem(`${PREFIX}settings`, JSON.stringify(next));
  return next;
}

export function gatewayHeaders(connection = loadConnection()): Record<string, string> {
  const headers: Record<string, string> = {};
  if (connection.token) headers.Authorization = `Bearer ${connection.token}`;
  if (connection.vaultId) headers['x-centraid-vault'] = connection.vaultId;
  return headers;
}

export async function gatewayFetch(pathname: string, init: RequestInit = {}): Promise<Response> {
  const connection = loadConnection();
  if (connection.transport === 'iroh') {
    if (!window.CentraidIroh) throw new Error('Iroh browser transport is not installed.');
    return window.CentraidIroh.fetch(pathname, init);
  }
  if (!connection.baseUrl) throw new Error('No gateway is connected.');
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(gatewayHeaders(connection))) {
    if (!headers.has(name)) headers.set(name, value);
  }
  const requestPath = connection.control
    ? `/centraid/_web/control?path=${encodeURIComponent(pathname)}`
    : pathname;
  return fetch(new URL(requestPath, `${connection.baseUrl.replace(/\/+$/, '')}/`), {
    ...init,
    credentials: 'include',
    headers,
  });
}

export async function gatewayJson<T>(pathname: string, init: RequestInit = {}): Promise<T> {
  const response = await gatewayFetch(pathname, init);
  const text = await response.text();
  if (!response.ok) throw new Error(text || `Gateway returned HTTP ${response.status}`);
  return JSON.parse(text) as T;
}

export const webEvents = new EventTarget();

export function subscribe<T>(name: string, callback: (detail: T) => void): () => void {
  const listener = (event: Event): void => callback((event as CustomEvent<T>).detail);
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
    const base64 = raw.trim().replaceAll('-', '+').replaceAll('_', '/');
    const decoded = JSON.parse(atob(base64)) as Record<string, unknown>;
    if (decoded['kind'] !== 'centraid-gw-pair') return undefined;
    return {
      ...(typeof decoded['vaultName'] === 'string' ? { vaultName: decoded['vaultName'] } : {}),
      ...(typeof decoded['exp'] === 'number' ? { exp: decoded['exp'] } : {}),
      ...(typeof decoded['gw'] === 'string' ? { gw: decoded['gw'] } : {}),
      ...(typeof decoded['t'] === 'string' ? { ticketId: decoded['t'] } : {}),
      ...(typeof decoded['s'] === 'string' ? { secret: decoded['s'] } : {}),
    };
  } catch {
    return undefined;
  }
}
