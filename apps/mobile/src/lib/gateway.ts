// governance: allow-repo-hygiene file-size-limit single wire-client module (#647 added the notifications/decision endpoints); pending split of the notifications client into a sibling module
// Mobile gateway client (issue #263). Base-URL resolution order:
//   (a) the paired tunnel — a localhost proxy that forwards every request
//       over iroh to the desktop, which attaches the bearer on its side;
//   (b) the manual gateway URL from Settings → Advanced — a developer
//       fallback for simulators pointing at a token-less dev gateway. The
//       token here is used for the RN-side API fetches (approvals, app
//       queries, notifications) every native cover makes.

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

/**
 * Authorization header for RN-side API fetches in manual-URL dev mode.
 * Harmless over the tunnel — the desktop overrides `authorization` before
 * forwarding to its loopback gateway.
 */
export function authHeader(): Record<string, string> {
  const token = getGatewayToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * The `x-centraid-vault` header addressing the active Vault's vault (issue #289
 * addressing model). Every RN-side gateway fetch carries it so the whole app —
 * app grid, Settings → Vault, approvals — follows whichever vault the Vaults
 * switcher has active, instead of floating to the gateway's implied default.
 * '' (no active vault, e.g. fresh manual-URL dev) sends no header, preserving
 * the old "let the gateway pick" behaviour. The replica sends its own copy of
 * this header (ReplicaProvider) keyed on the same active Vault.
 */
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

/**
 * How long a cold start waits for the tunnel to answer before falling
 * through to the manual-URL path / cached base. `startTunnel()` itself has no
 * timeout — dialling a desktop that is asleep or unreachable can hang for the
 * lifetime of the launch — so SOMETHING here has to own a budget, or a cold
 * start with no reachable gateway waits forever and never opens the replica
 * it already has on disk (the defect this constant exists to make impossible;
 * see replica-mount.ts / mount-plan.ts for the phase-A/phase-B split this
 * feeds into).
 */
const TUNNEL_START_BUDGET_MS = 4_000;

/**
 * Race `work` against a timer of `ms`, resolving `undefined` if the timer
 * wins. This is a BUDGET, not a cancellation: `work` is never aborted, only
 * abandoned. That distinction is the whole safety argument —
 *
 *   - `resolveGatewayBase()` writes nothing itself, so an abandoned start
 *     landing late has nothing of ours to corrupt;
 *   - `ensureTunnelStarted()`'s own `startInFlight` memoization means the
 *     NEXT call (a manual retry, a later reachability pass) joins the same
 *     in-flight start instead of dialling a second time;
 *   - once the abandoned start finishes, the tunnel IS running, and the next
 *     pass through `ensureTunnelStarted()` reads `status.state === "running"`
 *     and takes the port straight off the status call, no new dial needed.
 *
 * `work.catch(() => undefined)` is attached up front — before the race can
 * give up on it — so a late rejection from the abandoned promise can never
 * surface as an unhandled rejection; the caller of `withBudget` never sees
 * it, because by then this function has already settled from the timer side.
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
 * Resolve the base URL for every gateway request: paired tunnel first,
 * manual URL second. `undefined` when neither is configured; throws
 * PhoneLinkError when the device is paired but the tunnel fails to start.
 *
 * The tunnel start is budgeted (`withBudget`) for the TIMEOUT dimension only:
 * a start that genuinely fails — bad ticket, module unavailable — still
 * rejects and its PhoneLinkError still reaches the pairing screens verbatim.
 * Only "did not answer within the budget" resolves `undefined` here.
 */
export async function resolveGatewayBase(): Promise<string | undefined> {
  const tunnel = await withBudget(
    ensureTunnelStarted(),
    TUNNEL_START_BUDGET_MS
  );
  if (tunnel) return tunnel.baseUrl;
  const manual = await hydrateGatewayUrl();
  if (!manual) return undefined;
  // Warm the token cache before the caller builds `authHeader()`. That helper is
  // sync (cache-only), and the Settings screen is otherwise the ONLY place that
  // hydrates the token — so on a cold start into manual-URL dev mode every authed
  // fetch would go out bearer-less and 401 until Settings was opened once. The
  // tunnel path skips this: the desktop attaches its own auth on forward.
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

/**
 * Invoke one online-only app query from a first-class native cover. The
 * request takes the app-scoped RPC path; callers keep passphrases/session
 * tokens out of the replica and durable intent queue.
 */
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

/**
 * A GET the screens re-issue on mount, focus and every doorbell.
 *
 * Revalidating with `If-None-Match` means an unchanged answer costs a 304 and
 * no body. Where the gateway sends no `ETag` this is exactly the old
 * unconditional GET, so adding a route here is always safe.
 */
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

/**
 * The stable client-session id both halves of an OAuth ceremony must carry.
 * The gateway binds a pending ceremony to it (plus the enrolled device), so
 * begin and complete MUST send the same value — hence the persisted store
 * rather than a per-call random.
 */
async function oauthClientSessionId(): Promise<string> {
  const stored = await Store.hydrate<string>(OAUTH_CLIENT_SESSION_KEY, "");
  if (/^[A-Za-z0-9_-]{32,128}$/u.test(stored)) return stored;
  const minted = Crypto.randomUUID();
  Store.set(OAUTH_CLIENT_SESSION_KEY, minted);
  return minted;
}

/**
 * Begin the canonical connection re-authorization flow from a needs-auth row.
 * `surface` selects the Assist Worker's *deep-link* return so the in-app auth
 * session can catch it — see lib/connection-reauth.ts for the full rationale.
 */
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

/**
 * Deliver the Assist code-courier tuple to the gateway. Nothing here is
 * persisted: the tuple lives in memory for the length of this call, exactly as
 * the PWA/desktop couriers do (docs/oauth-assist.md step 5).
 */
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

/**
 * One vault of the owner's registry — a "vault" in the UI. Presentation
 * (`color`/`icon`/`blurb`) lives in `core_vault.settings_json` (#280: profiles
 * are vaults). Mirrors `VaultListEntry` in packages/client gateway-client-vault
 * ts — `color` is a raw hex string, `icon` a design-tokens IconName key.
 */
export interface VaultRow {
  vaultId: string;
  name: string;
  ownerPartyId: string;
  color?: string;
  icon?: string;
  blurb?: string;
}

/**
 * The owner's vault registry from `GET /centraid/_vault/vaults` (returns
 * `{ vaults }`). `undefined` when the gateway mounts no vault plane (route
 * 404s) — a valid deployment, so callers render a "no vault" state, not an
 * error. There is no server-side active flag (#289): the active vault is a
 * device-local pointer (see lib/vault-links.ts), and the Vaults switcher reads this
 * list to offer the vaults this device may address. Deliberately header-free
 * (no `vaultHeader()`): the switcher's own data source must not depend on the
 * active vault being valid, and an unknown `x-centraid-vault` would 404 here.
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
 * Rename a vault and/or update its presentation via `PATCH
 * /centraid/_vault/vaults/:id` (only supplied fields are written). Returns the
 * updated row. The vault is named by URL path, so this is header-free like
 * `listVaults` — no `vaultHeader()`. Vault create/delete have NO client HTTP
 * surface by design (#289): the gateway answers 405 and points at
 * `centraid-gateway vault create|delete` on the host. The mobile "Vaults"
 * feature (lib/vault-links.ts) adds/switches/forgets device-local (gateway, vault)
 * tuples — it never creates or destroys a vault.
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
// Prefer the row's real `name`/`description`/`iconKey`/`colorKey` from the
// listing. Fall back per-field: built-in template metadata for known ids,
// then title-cased id + palette hash + generic icon.

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

/**
 * Map an app id (plus any display overrides) into a tile-renderable
 * `AppMetaResolved`. `iconKey`/`colorKey` are optional; anything absent falls
 * back to the bundled catalog and then to derived display metadata.
 */
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

/**
 * The label an auto-founded gateway gives its owner before anyone has said who
 * they are (`build-gateway.ts`). A placeholder, not a name — a member still
 * carrying it counts as "not set yet".
 */
export const PLACEHOLDER_MEMBER_LABEL = "You";

/**
 * The name of the person this device just enrolled as, from the household
 * roster (`GET /centraid/_gateway/devices`, the row flagged `current`).
 *
 * A name belongs to the PERSON, not to the phone. Pairing a second device for
 * someone the gateway already knows must not ask them who they are again, so
 * onboarding reads this and skips its profile step when it comes back set.
 * Empty string = the roster still says "You"; `undefined` = the gateway has no
 * device plane, or the read failed — both mean "ask", never "assume".
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
