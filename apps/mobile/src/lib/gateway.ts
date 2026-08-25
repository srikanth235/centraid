// governance: allow-repo-hygiene file-size-limit single wire-client module (#647 added the notifications/decision endpoints); pending split of the notifications client into a sibling module
// Mobile gateway client (#263). Base-URL resolution order: (a) the paired
// tunnel, a localhost proxy forwarding over iroh to the desktop, which attaches
// the bearer on its side; (b) the manual URL from Settings → Advanced, a
// developer fallback whose token authenticates the RN-side API fetches.

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
import { getSecure, hydrateSecure, setSecure } from "./secure-storage";
import { getActiveVaultId } from "./vault-links";

export const SETTINGS_KEY = "settings.gatewayUrl";
export const SETTINGS_TOKEN_KEY = "settings.gatewayToken";
const OAUTH_CLIENT_SESSION_KEY = "oauth.clientSession";

/** One parked vault invocation (VaultPlane listParked → ParkedSummary). */
export interface ParkedInvocation {
  invocationId: string;
  command: string;
  parkedAt: string;
  /** Identity kind of the caller, e.g. 'app' | 'agent' | 'owner-device'. */
  callerKind: string;
  /** Display name of the caller (consent.app.name for apps), or null. */
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
      /** The asked triples — rendered on the card, never approved unseen. */
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

/** Strip a trailing `/` so we can confidently concatenate paths. */
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

/** For manual-URL dev mode. Harmless over the tunnel — the desktop overrides
 *  `authorization` before forwarding to its loopback gateway. */
export function authHeader(): Record<string, string> {
  const token = getGatewayToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** `x-centraid-vault` (#289): every RN-side fetch carries it so the whole app
 *  follows the active vault instead of the gateway's implied default. No active
 *  vault sends no header, letting the gateway pick. */
export function vaultHeader(): Record<string, string> {
  const vaultId = getActiveVaultId();
  return vaultId ? { "x-centraid-vault": vaultId } : {};
}

/** The RN-fetch header set every authed gateway call needs: auth + active vault. */
export function apiHeaders(
  extra?: Record<string, string>
): Record<string, string> {
  return { ...authHeader(), ...vaultHeader(), ...extra };
}

/** `startTunnel()` has no timeout of its own — dialling a sleeping desktop can
 *  hang for the lifetime of the launch — so this budget is what keeps a cold
 *  start with no reachable gateway from never opening the replica it already
 *  has on disk (`replica-mount.ts`'s phase-A/phase-B split). */
const TUNNEL_START_BUDGET_MS = 4_000;

/**
 * A BUDGET, not a cancellation: `work` is abandoned, never aborted. That is
 * safe because `resolveGatewayBase()` writes nothing, `ensureTunnelStarted()`
 * memoizes its in-flight start so the next call joins rather than re-dials, and
 * an abandoned start that finishes leaves the tunnel running for it to find.
 *
 * `work.catch(() => undefined)` is attached UP FRONT, before the race can give
 * up on it, so a late rejection can never surface as an unhandled rejection.
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
 * Tunnel first, manual URL second. `undefined` when neither is configured;
 * throws PhoneLinkError when paired but the tunnel fails to start.
 *
 * The budget covers the TIMEOUT dimension only — a start that genuinely fails
 * still rejects, and its PhoneLinkError still reaches the pairing screens.
 */
export async function resolveGatewayBase(): Promise<string | undefined> {
  const tunnel = await withBudget(
    ensureTunnelStarted(),
    TUNNEL_START_BUDGET_MS
  );
  if (tunnel) return tunnel.baseUrl;
  const manual = await hydrateGatewayUrl();
  if (!manual) return undefined;
  // Warms the cache `authHeader()` reads: that helper is sync, and Settings is
  // otherwise the only place hydrating the token, so a cold start into
  // manual-URL dev mode would 401 until Settings was opened once. The tunnel
  // path skips this — the desktop attaches its own auth on forward.
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

/** One online-only app query over the app-scoped RPC path. Callers keep
 *  passphrases and session tokens out of the replica and the intent queue. */
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
    return await fetch(href, init);
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

/** For GETs the screens re-issue on mount, focus and every doorbell.
 *  `If-None-Match` makes an unchanged answer cost a 304 and no body; with no
 *  `ETag` it degrades to a plain GET, so adding a route here is always safe. */
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

/** Parked vault invocations awaiting the owner's confirmation. */
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

/** Content-free Notifications SSE doorbell; callers re-fetch the canonical payload. */
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

/** The gateway binds a pending ceremony to this plus the enrolled device, so
 *  begin and complete MUST send the same value — hence a persisted store, never
 *  a per-call random. */
async function oauthClientSessionId(): Promise<string> {
  const stored = await Store.hydrate<string>(OAUTH_CLIENT_SESSION_KEY, "");
  if (/^[A-Za-z0-9_-]{32,128}$/u.test(stored)) return stored;
  const minted = Crypto.randomUUID();
  Store.set(OAUTH_CLIENT_SESSION_KEY, minted);
  return minted;
}

/** `surface` selects the Assist Worker's DEEP-LINK return so the in-app auth
 *  session can catch it (`lib/connection-reauth.ts`). */
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

/** The Assist code-courier tuple is NEVER persisted — it lives in memory for
 *  this call only, as the PWA and desktop couriers do (docs/oauth-assist.md
 *  step 5). */
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

/** Approve or deny one parked invocation. */
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

/** Mirrors `VaultListEntry` in packages/client. Presentation lives in
 *  `core_vault.settings_json` (#280); `color` is a raw hex string, `icon` a
 *  design-tokens `IconName` key. */
export interface VaultRow {
  vaultId: string;
  name: string;
  ownerPartyId: string;
  color?: string;
  icon?: string;
  blurb?: string;
}

/**
 * `undefined` when the gateway mounts no vault plane (404) — a valid
 * deployment, so callers render a "no vault" state, not an error. There is no
 * server-side active flag (#289); the active vault is a device-local pointer
 * (`lib/vault-links.ts`).
 *
 * Deliberately HEADER-FREE: the switcher's own data source must not depend on
 * the active vault being valid, and an unknown `x-centraid-vault` would 404.
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
 * Only supplied fields are written. Header-free like `listVaults` — the vault
 * is named by URL path.
 *
 * Vault create/delete have NO client HTTP surface by design (#289): the gateway
 * answers 405 and points at `centraid-gateway vault create|delete`. Mobile
 * "Vaults" adds/switches/forgets device-local tuples, never vaults.
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

// --- Display metadata ---
//
// Per-field fallback: the row's own value, then built-in template metadata for
// known ids, then title-cased id + palette hash + generic icon.

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

/** What an auto-founded gateway calls its owner (`build-gateway.ts`). A
 *  placeholder, not a name — carrying it counts as "not set yet". */
export const PLACEHOLDER_MEMBER_LABEL = "You";

/**
 * A name belongs to the PERSON, not the phone, so onboarding reads this and
 * skips its profile step when it comes back set.
 *
 * `""` = the roster still says "You"; `undefined` = no device plane or the read
 * failed — both mean "ask", never "assume".
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
