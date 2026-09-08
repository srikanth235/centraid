// governance: allow-repo-hygiene file-size-limit single wire-client module (#647 added the notifications/decision endpoints); pending split of the notifications client into a sibling module
// Mobile gateway client (#263). Base URL: (a) paired tunnel (desktop attaches
// the bearer); (b) manual Settings → Advanced URL (RN-side token).

import * as Crypto from "expo-crypto";
import { fetch as expoFetch } from "expo/fetch";

import { apps as BUILTIN_APPS, icons, palette } from "@centraid/design";
import type { AppMetaResolved, ColorKey, IconName } from "@centraid/design";

import { Store } from "../storage";
import { ConditionalBodyCache } from "./conditional-fetch";
import { MOBILE_AUTHORIZE_SURFACE } from "./connection-reauth";
import type { AssistHandoff } from "./connection-reauth";
import type { DecisionScope } from "./decision-detail";
import { ensureTunnelStarted } from "./phone-link";
import { fetchWithinReplyDeadline } from "./replica/gateway-deadline";
import { getSecure, hydrateSecure, setSecure } from "./secure-storage";
import { getActiveVaultId } from "./vault-links";

export const SETTINGS_KEY = "settings.gatewayUrl";
export const SETTINGS_TOKEN_KEY = "settings.gatewayToken";
const OAUTH_CLIENT_SESSION_KEY = "oauth.clientSession";

export interface ParkedInvocation {
  invocationId: string;
  command: string;
  parkedAt: string;
  callerKind: string;
  caller: string | null;
  input: Record<string, unknown>;
}

export interface MobileNotice {
  noticeId: string;
  kind: string;
  sourceRef: string;
  headline: string;
  detail: Record<string, unknown>;
  severity: "info" | "warning" | "high";
  count: number;
  firstAt: string;
  lastAt: string;
  readAt: string | null;
  archivedAt: string | null;
}

export interface MobileNotifications {
  decisions: {
    count: number;
    outbox: MobileOutboxRow[];
    needsAuth: Array<{
      connectionId: string;
      kind: string;
      label: string;
      note: string | null;
      attentionAt: string;
    }>;
    parked: ParkedInvocation[];
    scopeRequests: Array<{
      requestId: string;
      plane: "app" | "agent";
      appId: string;
      purpose: string;
      requestedAt: string;
      /** Asked triples — rendered on the card, never approved unseen. */
      scopes: DecisionScope[];
    }>;
  };
  notices: MobileNotice[];
  unreadNoticeCount: number;
}

export interface MobileOutboxRow {
  itemId: string;
  actor: string | null;
  actorKind: string;
  verb: string;
  target: string;
  artifact: Record<string, unknown>;
  stagedAt: string;
  connection: { kind: string; label: string };
  canEdit: boolean;
}

export class GatewayError extends Error {
  constructor(
    public readonly kind: "no_gateway" | "unreachable" | "bad_response",
    message: string
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

function normalizeBase(raw: string): string {
  return raw.replace(/\/+$/u, "");
}

export async function hydrateGatewayUrl(): Promise<string> {
  return Store.hydrate<string>(SETTINGS_KEY, "");
}

export function setGatewayUrl(value: string): void {
  Store.set<string>(SETTINGS_KEY, value.trim());
}

export function getGatewayToken(): string {
  return getSecure(SETTINGS_TOKEN_KEY, "");
}

export async function hydrateGatewayToken(): Promise<string> {
  return hydrateSecure(SETTINGS_TOKEN_KEY, "");
}

export function setGatewayToken(value: string): void {
  void setSecure(SETTINGS_TOKEN_KEY, value.trim());
}

/** Manual-URL dev. Harmless over the tunnel — desktop overrides `authorization`. */
export function authHeader(): Record<string, string> {
  const token = getGatewayToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** `x-centraid-vault` (#289). No active vault → no header; gateway picks. */
export function vaultHeader(): Record<string, string> {
  const vaultId = getActiveVaultId();
  return vaultId ? { "x-centraid-vault": vaultId } : {};
}

export function apiHeaders(
  extra?: Record<string, string>
): Record<string, string> {
  return { ...authHeader(), ...vaultHeader(), ...extra };
}

/** `startTunnel()` has no timeout — without this, a sleeping desktop hangs launch. */
const TUNNEL_START_BUDGET_MS = 4_000;

/**
 * A BUDGET, not a cancellation: `work` is abandoned, never aborted.
 * `work.catch(() => undefined)` is attached UP FRONT so a late rejection
 * cannot surface unhandled.
 */
function withBudget<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  work.catch(() => undefined);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    work
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        reject(error as Error);
      });
  });
}

/**
 * Tunnel first, manual URL second. `undefined` when neither is configured.
 * Neither a timeout nor a failed start rejects: both fall through (#905).
 */
export async function resolveGatewayBase(): Promise<string | undefined> {
  const tunnel = await withBudget(
    ensureTunnelStarted(),
    TUNNEL_START_BUDGET_MS
  ).catch((error: unknown) => {
    console.error(
      `[centraid] replica: tunnel start failed — ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  });
  if (tunnel) return tunnel.baseUrl;
  const manual = await hydrateGatewayUrl();
  if (!manual) return undefined;
  // Warm the sync `authHeader()` cache; else a cold manual-URL start 401s.
  await hydrateGatewayToken();
  return normalizeBase(manual);
}

export async function requireGatewayBase(): Promise<string> {
  const base = await resolveGatewayBase();
  if (!base) {
    throw new GatewayError(
      "no_gateway",
      "Not connected to a desktop — pair in Settings."
    );
  }
  return base;
}

/** Keep passphrases out of the replica and intent queue. */
export async function appQuery<T>(
  appId: string,
  query: string,
  input: Record<string, unknown> = {}
): Promise<T> {
  const base = await requireGatewayBase();
  return fetchJson<T>(
    `${base}/centraid/${encodeURIComponent(appId)}/queries/${encodeURIComponent(query)}`,
    {
      body: JSON.stringify({ input }),
      headers: apiHeaders({ "content-type": "application/json" }),
      method: "POST",
    }
  );
}

async function fetchOrThrow(
  href: string,
  init?: RequestInit
): Promise<Response> {
  try {
    return await fetchWithinReplyDeadline(
      (signal) => fetch(href, { ...init, signal }),
      init?.signal ?? undefined
    );
  } catch (error) {
    throw new GatewayError(
      "unreachable",
      `Could not reach the gateway: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function fetchJson<T>(
  href: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetchOrThrow(href, init);
  if (!res.ok) {
    throw new GatewayError(
      "bad_response",
      `Gateway returned HTTP ${res.status}`
    );
  }
  return parseJsonBody<T>(await res.text());
}

function parseJsonBody<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GatewayError(
      "bad_response",
      `Gateway returned non-JSON: ${text.slice(0, 120)}`
    );
  }
}

const conditionalBodies = new ConditionalBodyCache();

export async function fetchJsonRevalidated<T>(
  href: string,
  init: RequestInit = {}
): Promise<T> {
  const result = await conditionalBodies.fetch(
    href,
    init,
    fetchOrThrow,
    `${getActiveVaultId()} ${href}`
  );
  if (!result.ok) {
    throw new GatewayError(
      "bad_response",
      `Gateway returned HTTP ${result.status}`
    );
  }
  return parseJsonBody<T>(result.body);
}

export async function listParked(): Promise<ParkedInvocation[]> {
  const base = await requireGatewayBase();
  const body = await fetchJsonRevalidated<{ parked: ParkedInvocation[] }>(
    `${base}/centraid/_vault/parked`,
    {
      headers: apiHeaders(),
      method: "GET",
    }
  );
  return body.parked;
}

export async function getNotifications(
  includeArchived = false
): Promise<MobileNotifications> {
  const base = await requireGatewayBase();
  return fetchJsonRevalidated<MobileNotifications>(
    `${base}/centraid/_vault/notifications${includeArchived ? "?include_archived=true" : ""}`,
    { headers: apiHeaders(), method: "GET" }
  );
}

export async function subscribeMobileNotificationsChanges(
  onChange: () => void,
  signal: AbortSignal
): Promise<void> {
  const base = await requireGatewayBase();
  const response = await expoFetch(
    `${base}/centraid/_vault/notifications/events`,
    {
      headers: apiHeaders({ accept: "text/event-stream" }),
      method: "GET",
      signal,
    }
  );
  if (!response.ok || !response.body)
    throw new Error(`Notifications events returned HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const readNext = async (): Promise<void> => {
    if (signal.aborted) return;
    const next = await reader.read();
    if (next.done) return;
    buffer += decoder
      .decode(next.value, { stream: true })
      .replaceAll("\r\n", "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (
        frame
          .split("\n")
          .some((line) => line === "event: notifications-changed")
      )
        onChange();
      boundary = buffer.indexOf("\n\n");
    }
    return readNext();
  };
  await readNext();
}

export async function decideNotificationsOutbox(
  itemId: string,
  decision: "approve" | "discard",
  options: {
    artifact?: Record<string, unknown>;
    alwaysAllow?: boolean;
  } = {}
): Promise<void> {
  const base = await requireGatewayBase();
  await fetchJson(
    `${base}/centraid/_vault/outbox/${encodeURIComponent(itemId)}`,
    {
      body: JSON.stringify({
        decision,
        ...(options.artifact ? { artifact: options.artifact } : {}),
        ...(options.alwaysAllow ? { always_allow: true } : {}),
      }),
      headers: apiHeaders({ "content-type": "application/json" }),
      method: "POST",
    }
  );
}

export async function decideNotificationsScope(
  requestId: string,
  approve: boolean
): Promise<void> {
  const base = await requireGatewayBase();
  await fetchJson(
    `${base}/centraid/_vault/scope-requests/${encodeURIComponent(requestId)}`,
    {
      body: JSON.stringify({ approve }),
      headers: apiHeaders({ "content-type": "application/json" }),
      method: "POST",
    }
  );
}

/** Begin and complete MUST send the same value — persisted, never per-call random. */
async function oauthClientSessionId(): Promise<string> {
  const stored = await Store.hydrate<string>(OAUTH_CLIENT_SESSION_KEY, "");
  if (/^[A-Za-z0-9_-]{32,128}$/u.test(stored)) return stored;
  const minted = Crypto.randomUUID();
  Store.set(OAUTH_CLIENT_SESSION_KEY, minted);
  return minted;
}

export async function beginNotificationsConnectionAuthorization(
  connectionId: string
): Promise<string> {
  const base = await requireGatewayBase();
  const body = await fetchJson<{ auth_url: string }>(
    `${base}/centraid/_vault/connections/${encodeURIComponent(connectionId)}/authorize`,
    {
      body: JSON.stringify({ surface: MOBILE_AUTHORIZE_SURFACE }),
      headers: apiHeaders({
        "content-type": "application/json",
        "x-centraid-client-session": await oauthClientSessionId(),
      }),
      method: "POST",
    }
  );
  return body.auth_url;
}

/** Assist courier tuple is NEVER persisted (docs/oauth-assist.md step 5). */
export async function completeNotificationsConnectionAuthorization(
  handoff: AssistHandoff
): Promise<void> {
  const base = await requireGatewayBase();
  await fetchJson<{ ok: boolean }>(
    `${base}/centraid/_vault/connections/assist/complete`,
    {
      body: JSON.stringify(handoff),
      headers: apiHeaders({
        "content-type": "application/json",
        "x-centraid-client-session": await oauthClientSessionId(),
      }),
      method: "POST",
    }
  );
}

export async function updateMobileNotice(
  noticeId: string,
  action: "read" | "archive"
): Promise<void> {
  const base = await requireGatewayBase();
  await fetchJson(
    `${base}/centraid/_vault/notifications/notices/${encodeURIComponent(noticeId)}`,
    {
      body: JSON.stringify({ action }),
      headers: apiHeaders({ "content-type": "application/json" }),
      method: "POST",
    }
  );
}

export async function confirmParked(
  invocationId: string,
  approve: boolean
): Promise<void> {
  const base = await requireGatewayBase();
  await fetchJson<unknown>(
    `${base}/centraid/_vault/parked/${encodeURIComponent(invocationId)}`,
    {
      body: JSON.stringify({ approve }),
      headers: apiHeaders({ "content-type": "application/json" }),
      method: "POST",
    }
  );
}

export interface VaultRow {
  vaultId: string;
  name: string;
  ownerPartyId: string;
  color?: string;
  icon?: string;
  blurb?: string;
}

/**
 * `undefined` on 404 (no vault plane) — not an error. HEADER-FREE: an unknown
 * `x-centraid-vault` would 404. Active vault is device-local (#289).
 */
export async function listVaults(): Promise<VaultRow[] | undefined> {
  const base = await requireGatewayBase();
  const res = await fetchOrThrow(`${base}/centraid/_vault/vaults`, {
    headers: authHeader(),
    method: "GET",
  });
  if (res.status === 404) return undefined;
  if (!res.ok)
    throw new GatewayError(
      "bad_response",
      `Gateway returned HTTP ${res.status}`
    );
  const body = (await res.json()) as { vaults: VaultRow[] };
  return body.vaults;
}

/**
 * Header-free; vault named by path. Create/delete have NO client HTTP (#289).
 * Mobile "Vaults" adds/switches/forgets device-local tuples, never vaults.
 */
export async function updateVault(
  vaultId: string,
  patch: { name?: string; color?: string; icon?: string; blurb?: string }
): Promise<VaultRow> {
  const base = await requireGatewayBase();
  return fetchJson<VaultRow>(
    `${base}/centraid/_vault/vaults/${encodeURIComponent(vaultId)}`,
    {
      body: JSON.stringify(patch),
      headers: { "content-type": "application/json", ...authHeader() },
      method: "PATCH",
    }
  );
}

// Display metadata: row → builtin template → title-cased id + palette hash.

const BUILTIN_BY_ID = new Map<string, AppMetaResolved>(
  BUILTIN_APPS.map((a) => [a.id, a])
);

const COLOR_KEYS: readonly ColorKey[] = [
  "violet",
  "rose",
  "amber",
  "teal",
  "forest",
  "indigo",
  "ochre",
  "slate",
];

function hashIdToColor(id: string): ColorKey {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  const idx = Math.abs(h) % COLOR_KEYS.length;
  const key = COLOR_KEYS[idx] ?? "violet";
  return key;
}

function titleCaseFromId(id: string): string {
  return id
    .replace(/[-_]+/gu, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
}

function asIconName(value: string | undefined): IconName | undefined {
  return value !== undefined && value in icons
    ? (value as IconName)
    : undefined;
}

function asColorKey(value: string | undefined): ColorKey | undefined {
  return value !== undefined && value in palette
    ? (value as ColorKey)
    : undefined;
}

export function resolveAppMeta(row: {
  id: string;
  name?: string;
  description?: string;
  iconKey?: string;
  colorKey?: string;
}): AppMetaResolved {
  const builtin = BUILTIN_BY_ID.get(row.id);
  const iconKey = asIconName(row.iconKey) ?? builtin?.iconKey ?? "Sparkle";
  const colorKey =
    asColorKey(row.colorKey) ?? builtin?.colorKey ?? hashIdToColor(row.id);
  return {
    color: palette[colorKey],
    colorKey,
    desc: row.description ?? builtin?.desc ?? "",
    iconKey,
    id: row.id,
    name: row.name ?? builtin?.name ?? titleCaseFromId(row.id),
  };
}

/** Auto-founded owner label (`build-gateway.ts`). Placeholder — "not set yet". */
export const PLACEHOLDER_MEMBER_LABEL = "You";

/**
 * Person's name, not the phone's. `""` = roster still "You"; `undefined` = no
 * plane or read failed. Both mean "ask", never "assume".
 */
export async function readSelfMemberName(): Promise<string | undefined> {
  try {
    const base = await requireGatewayBase();
    const body = await fetchJson<{
      devices?: Array<{ current?: boolean; memberLabel?: string }>;
    }>(`${base}/centraid/_gateway/devices`, {
      headers: apiHeaders(),
      method: "GET",
    });
    const self = body.devices?.find((device) => device.current === true);
    if (!self) return undefined;
    const label = (self.memberLabel ?? "").trim();
    return label === PLACEHOLDER_MEMBER_LABEL ? "" : label;
  } catch {
    return undefined;
  }
}
