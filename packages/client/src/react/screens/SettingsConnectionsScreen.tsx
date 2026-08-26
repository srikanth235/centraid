// governance: allow-repo-hygiene file-size-limit (#363) single cohesive screen component for the Connectors gallery surface; splitting would fragment one visual unit
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";

import { ASSIST_HANDOFF_EVENT } from "../../assist-oauth-events.js";
import type { AssistHandoffResult } from "../../assist-oauth-events.js";
import {
  CONNECTORS_EMPTY_BODY,
  CONNECTORS_EMPTY_TITLE,
  CONNECTORS_ERROR_BODY,
  CONNECTORS_ERROR_TITLE,
} from "../../connectors-copy.js";
import { SKELETON_NOTE } from "../../surface-copy.js";
import { relativeTime } from "../format.js";
import type {
  RouteHealth,
  RouteVerbs,
  RouteVitalsInput,
} from "../shell/routeVitals.js";
import { PageSkeleton } from "../shell/status.js";
import ChipsBlock from "../ui/ChipsBlock.js";
import EmptyBlock from "../ui/EmptyBlock.js";
import { Button, Icon } from "../ui/index.js";
import NoteBlock from "../ui/NoteBlock.js";
import PanelBlock from "../ui/PanelBlock.js";
import RowsBlock from "../ui/RowsBlock.js";
import type { RowDef } from "../ui/RowsBlock.js";
import SectionBlock from "../ui/SectionBlock.js";
import { ConnectorBrandGlyph } from "./connectorBrandMarks.js";

import styles from "./SettingsConnectionsScreen.module.css";

// Connectors (#304 renderer half; primary sidebar page), rebuilt on the
// v9 block vocabulary (#765): the page is a list of what is connected and what
// each connection feeds, and nothing else. Its identity, its count line, its
// health sentence and its two verbs live in the frame — the screen reports what
// it read and draws blocks.
//
// The gateway I/O surface is unchanged: configure / pause / authorize / remove,
// plus the same Connect sheet the catalog has always opened. What moved is
// where you reach them from — the row's ONE trailing action is the thing that
// connection needs next (re-authorize, resume, configure), and pause/remove sit
// in the connection's own sheet where the sentence explaining them fits.

export type ConnectionHealth = "ok" | "needs-auth" | "paused" | "failing";

export interface ConnectionRowDTO {
  connectionId: string;
  kind: string;
  label: string;
  principal: string | null;
  health: ConnectionHealth;
  /** `null` = no credential attached — the connection rides the
   *  harness-ambient lane rather than a BYO one. */
  credKind: "oauth2" | "api_key" | null;
  oauthMode?: "byo" | "assist" | null;
  provider: string | null;
  authNote: string | null;
  lastRunAt: string | null;
}

export interface ProviderConnectorOptionDTO {
  templateId: string;
  kind: string;
  scope?: string;
}

export interface ProviderSyncCapabilityDTO {
  id: string;
  title: string;
  templateId: string;
  kind: string;
  defaultCron: string;
  scope?: string;
}

export interface ProviderActionCapabilityDTO {
  id: string;
  title: string;
  toolName: string;
  kind: string;
  templateId?: string;
  approval?: "outbox";
  scope?: string;
}

export interface ProviderOptionDTO {
  id: string;
  name: string;
  credKind: "oauth2" | "api_key";
  authUrl?: string;
  tokenUrl?: string;
  scopes?: string;
  allowedHosts: string[];
  setup: string[];
  connectors: ProviderConnectorOptionDTO[];
  capabilities: {
    syncs: ProviderSyncCapabilityDTO[];
    actions: ProviderActionCapabilityDTO[];
  };
  assist?:
    | { enabled: false }
    | {
        enabled: true;
        provider: "google";
        callbackUrl: string;
        restrictedScopesEnabled: boolean;
        scopeTiers: { standard: string[]; restricted: string[] };
      };
}

export interface LinkedSyncDTO {
  capabilityId: string;
  title: string;
  templateId: string;
  kind: string;
  /** Installed automation ref when a matching pull is already present. */
  installedRef: string | null;
  installedEnabled: boolean;
}

/**
 * One installed sync — an automation that copies a narrow thing out of a
 * connection on a schedule. The page's second section; distinct from
 * `LinkedSyncDTO`, which is what a connector COULD sync (installed or not).
 */
export interface AttachedSyncDTO {
  /** The automation's `<app>/<id>` ref. */
  id: string;
  /** The connection it rides — the row it belongs under. */
  connectionId: string;
  connectionLabel: string;
  name: string;
  /** Plain-English schedule ("Every 15 minutes"), or "On demand". */
  cadence: string;
  enabled: boolean;
}

/** The wizard's submitted form, already resolved to one connector — carries
 *  the chosen preset's auth/token URLs + host pin along so the data layer
 *  doesn't have to re-fetch the provider catalog to build the configure
 *  body. */
export interface ConnectionFormInput {
  providerId: string;
  connectorKind: string;
  label: string;
  credKind: "oauth2" | "api_key";
  oauthMode?: "byo" | "assist";
  authUrl?: string;
  tokenUrl?: string;
  /** The connector's specific scope when the preset names one per
   *  connector; falls back to the provider's full scope string. */
  scopes?: string;
  allowedHosts: string[];
  clientId?: string;
  clientSecret?: string;
  apiKey?: string;
}

export interface SettingsConnectionsBridgeProps {
  loadConnections: () => Promise<ConnectionRowDTO[]>;
  loadProviders: () => Promise<ProviderOptionDTO[]>;
  /** Returns connectionId so oauth2 can open the authorize URL immediately. */
  configureConnection: (
    input: ConnectionFormInput
  ) => Promise<{ connectionId: string; status?: string } | void>;
  setConnectionStatus: (
    connectionId: string,
    status: "active" | "paused"
  ) => Promise<void>;
  /** Named `detachConnection` for historical reasons but performs the real
   *  removal (`sync.remove_connection`) — see `settingsConnectionsData.ts`. */
  detachConnection: (
    connectionId: string,
    kind: string,
    label: string
  ) => Promise<void>;
  /** Begins the PKCE ceremony, returning the URL the owner's browser must
   *  visit. This screen opens it (`window.open`) — never navigates the app. */
  beginAuthorize: (connectionId: string) => Promise<string>;
  /** Manual desktop fallback when the custom-scheme launch is blocked. */
  completeAssistReturnLink?: (
    rawUrl: string
  ) => Promise<{ connectionId: string }>;
  showToast: (message: string) => void;
  /** Linked pull automations for a connection (detail sheet). Optional. */
  loadLinkedSyncs?: (connection: ConnectionRowDTO) => Promise<LinkedSyncDTO[]>;
  /** Install a pull template for a declared sync capability. Optional. */
  installSync?: (input: {
    templateId: string;
    connection: ConnectionRowDTO;
  }) => Promise<{ ref: string } | void>;
  /** Gateway OAuth callback URL for the BYO client setup form. Optional. */
  loadOAuthCallbackUri?: () => Promise<string>;
  /** The installed syncs across the connections just read. Optional. */
  loadAttachedSyncs?: (
    connections: readonly ConnectionRowDTO[]
  ) => Promise<AttachedSyncDTO[]>;
  /** Report what the page just read: the count line, the state the five-state
   *  model is in, and (ready/full only) the one health sentence. The ROUTE
   *  publishes it to the frame. */
  onSignals?: (input: RouteVitalsInput & { health?: RouteHealth }) => void;
  /** Claim the app bar's two verbs. Both need state only this screen has — the
   *  Connect sheet, and whether the catalog is showing. */
  onVerbs?: (verbs: RouteVerbs) => void;
}

const HEALTH_LABEL: Record<ConnectionHealth, string> = {
  failing: "Failing",
  "needs-auth": "Needs authorization",
  ok: "Connected",
  paused: "Paused",
};

/** The row's one mono slot: the state word, in the frame's own vocabulary. */
const HEALTH_META: Record<ConnectionHealth, string> = {
  failing: "Failing",
  "needs-auth": "Needs re-auth",
  ok: "Fine",
  paused: "Paused",
};

/** What each state needs NEXT — the row's single trailing action. */
const HEALTH_ACTION: Record<ConnectionHealth, string> = {
  failing: "Re-authorize",
  "needs-auth": "Re-authorize",
  ok: "Configure",
  paused: "Resume",
};

const CRED_LABEL: Record<"oauth2" | "api_key", string> = {
  api_key: "API key",
  oauth2: "OAuth",
};

/** The row filters the `full` state offers, first one on. */
const FILTERS = [
  { health: null, id: "all", label: "All" },
  { health: "failing", id: "failing", label: "Failing" },
  { health: "needs-auth", id: "needs-auth", label: "Needs re-auth" },
  { health: "paused", id: "paused", label: "Paused" },
] as const;

type ConnFilter = (typeof FILTERS)[number]["id"];

/**
 * Where `ready` becomes `full`. The spec's everyday page is five rows; a sixth
 * is the point at which scanning the list stops being free and a filter row
 * starts earning the space it takes.
 */
const FULL_AT = 6;

/**
 * Which of the five states the page is in, derived from what actually happened
 * to the query — never a switch. `full` is a row count, because the filter row
 * is a response to a list that is too long to scan, not a mode.
 */
function pageState(
  rows: readonly ConnectionRowDTO[] | null,
  readError: string | null
): RouteVitalsInput["state"] {
  if (readError !== null) return "error";
  if (rows === null) return "loading";
  if (rows.length === 0) return "empty";
  return rows.length >= FULL_AT ? "full" : "ready";
}

/** A connection that cannot currently reach its service. */
function isLapsed(row: ConnectionRowDTO): boolean {
  return row.health === "needs-auth" || row.health === "failing";
}

/** Copy joins two sentences; a gateway note may or may not end in a stop. */
function sentence(text: string): string {
  return /[.!?]$/u.test(text.trim()) ? text.trim() : `${text.trim()}.`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The row's explanatory second line: who, how, and when it last worked. */
function connectionSub(row: ConnectionRowDTO): string {
  const credential = row.credKind ? CRED_LABEL[row.credKind] : "no credential";
  const when =
    row.authNote ??
    (row.lastRunAt
      ? `last worked ${relativeTime(row.lastRunAt)}`
      : "has not worked yet");
  return [row.principal ?? "no account", credential, when].join(" · ");
}

/**
 * The app bar's count line, from the rows themselves.
 *
 * Only the clauses that are TRUE appear: a page with nothing to re-authorize
 * says "5 connections" and stops, rather than reading "· 0 needs
 * re-authorization" and making the reader check a zero.
 */
function countLine(rows: readonly ConnectionRowDTO[]): string {
  if (rows.length === 0) return "No connections";
  const lapsed = rows.filter(isLapsed).length;
  const paused = rows.filter((r) => r.health === "paused").length;
  const parts = [plural(rows.length, "connection", "connections")];
  if (lapsed > 0) parts.push(`${lapsed} needs re-authorization`);
  if (paused > 0) parts.push(`${paused} paused`);
  return parts.join(" · ");
}

const POLL_MS = 2000;
const POLL_WINDOW_MS = 45_000;
const ASSIST_PWA_ORIGIN = "https://app.centraid.dev";

/**
 * Poll a connection until it stops reporting `needs-auth` (or the window
 * closes). Module scope, taking its refs/loaders as arguments: a
 * self-rescheduling function declared inside the component body reads as a
 * render value that depends on itself, and its `Date.now()` reads as an impure
 * call during render.
 */
function pollUntilAuthorized(
  connectionId: string,
  io: {
    pollTimer: { current: ReturnType<typeof setTimeout> | null };
    pollDeadline: { current: number };
    loadConnections: () => Promise<ConnectionRowDTO[]>;
    onRows: (rows: ConnectionRowDTO[]) => void;
    onSettled: (connectionId: string) => void;
  }
): void {
  const { pollTimer, pollDeadline, loadConnections, onRows, onSettled } = io;
  pollDeadline.current = Date.now() + POLL_WINDOW_MS;
  const tick = (): void => {
    void loadConnections()
      .then((freshRows) => {
        onRows(freshRows);
        const row = freshRows.find((r) => r.connectionId === connectionId);
        const done = !row || row.health !== "needs-auth";
        if (done) {
          onSettled(connectionId);
          return;
        }
        // Keep the explicit "Still waiting…" state after the polling
        // window. The ceremony itself remains gateway-TTL-bound, and the
        // owner can retry or use the manual return-link fallback.
        if (Date.now() >= pollDeadline.current) return;
        pollTimer.current = setTimeout(tick, POLL_MS);
      })
      .catch(() => {
        // A transient gateway read must neither erase the visible list nor
        // masquerade as a deleted/healthy connection and stop polling.
        if (Date.now() < pollDeadline.current) {
          pollTimer.current = setTimeout(tick, POLL_MS);
        }
      });
  };
  pollTimer.current = setTimeout(tick, POLL_MS);
}

function clearPollTimer(timer: {
  current: ReturnType<typeof setTimeout> | null;
}): void {
  if (timer.current) clearTimeout(timer.current);
}

function assertAssistWebOrigin(): void {
  if (window.location.origin !== ASSIST_PWA_ORIGIN) {
    throw new Error(
      "Connect with Centraid is available in the desktop app or at app.centraid.dev. Use Advanced with your own OAuth client on this web origin."
    );
  }
}

/** Display metadata for a connector kind (gallery tile + detail sheet). */
interface FeaturedMeta {
  name: string;
  short: string;
  blurb: string;
  accessTitle: string;
  accessDesc: string;
  tone: string;
  letter: string;
}

const FEATURED_META: Record<string, FeaturedMeta> = {
  "pull.gmail": {
    name: "Gmail",
    short: "Productivity",
    blurb:
      "Search your inbox, summarize unread mail, and find messages from specific people.",
    accessTitle: "Search your emails",
    accessDesc:
      "Search your inbox, summarize unread emails, and find messages from specific people.",
    tone: "gmail",
    letter: "M",
  },
  "pull.gcal": {
    name: "Google Calendar",
    short: "Productivity",
    blurb: "Read calendar events and keep schedules in sync with the vault.",
    accessTitle: "Access your calendar",
    accessDesc:
      "Search events, summarize upcoming meetings, and keep the vault in sync.",
    tone: "gcal",
    letter: "31",
  },
  "pull.gcontacts": {
    name: "Google Contacts",
    short: "Productivity",
    blurb: "Pull people and contact details into the vault.",
    accessTitle: "Access your contacts",
    accessDesc: "Import people and contact details for vault-wide search.",
    tone: "gcontacts",
    letter: "P",
  },
  "pull.gdrive": {
    name: "Google Drive",
    short: "Productivity",
    blurb:
      "Search for documents, summarize presentations, and ask questions about Drive files.",
    accessTitle: "Access your files",
    accessDesc:
      "Search for documents, summarize presentations, and ask questions about your Drive files.",
    tone: "gdrive",
    letter: "D",
  },
  "pull.github": {
    name: "GitHub",
    short: "Developer",
    blurb:
      "Search repositories and code, explore issues and PRs, and keep project activity in the vault.",
    accessTitle: "Access repositories",
    accessDesc:
      "Search repositories and code, explore issues and PRs, and track project activity.",
    tone: "github",
    letter: "GH",
  },
  "pull.outlook": {
    name: "Outlook Mail",
    short: "Productivity",
    blurb: "Search Outlook / Microsoft 365 mail and keep threads in the vault.",
    accessTitle: "Search your emails",
    accessDesc:
      "Read recent Outlook messages and stage them for vault-wide search.",
    tone: "outlook",
    letter: "O",
  },
  "pull.outlookcal": {
    name: "Outlook Calendar",
    short: "Productivity",
    blurb: "Pull Outlook calendar events into Agenda.",
    accessTitle: "Access your calendar",
    accessDesc: "Import events from your Microsoft 365 calendar.",
    tone: "outlookcal",
    letter: "31",
  },
  "pull.outlookcontacts": {
    name: "Outlook Contacts",
    short: "Productivity",
    blurb: "Import Outlook people into your vault CRM.",
    accessTitle: "Access your contacts",
    accessDesc:
      "Pull Microsoft contacts as people, merge-aware on email and phone.",
    tone: "outlookcontacts",
    letter: "P",
  },
  "pull.onedrive": {
    name: "OneDrive",
    short: "Productivity",
    blurb: "Recent OneDrive files as searchable vault messages.",
    accessTitle: "Access your files",
    accessDesc:
      "List recent OneDrive files so the assistant can find and summarize them.",
    tone: "onedrive",
    letter: "☁",
  },
  "pull.gitlab": {
    name: "GitLab",
    short: "Developer",
    blurb: "Issues and merge requests you are involved in, as vault threads.",
    accessTitle: "Access projects",
    accessDesc: "Pull GitLab issues and MRs with a personal access token.",
    tone: "gitlab",
    letter: "GL",
  },
  "pull.linear": {
    name: "Linear",
    short: "Developer",
    blurb: "Linear issues land as searchable threads in the vault.",
    accessTitle: "Access issues",
    accessDesc: "List issues from your Linear workspaces via personal API key.",
    tone: "linear",
    letter: "Li",
  },
  "pull.notion": {
    name: "Notion",
    short: "Notes",
    blurb:
      "Pages shared with your integration become searchable vault messages.",
    accessTitle: "Access pages",
    accessDesc:
      "Only pages you explicitly connect to the integration are imported.",
    tone: "notion",
    letter: "N",
  },
  "pull.todoist": {
    name: "Todoist",
    short: "Tasks",
    blurb: "Active Todoist tasks stage into the vault for search and agents.",
    accessTitle: "Access tasks",
    accessDesc:
      "List open Todoist tasks (completed history is not bulk-imported).",
    tone: "todoist",
    letter: "✓",
  },
  "pull.slack": {
    name: "Slack",
    short: "Communication",
    blurb: "Recent DMs and channel messages land as vault threads.",
    accessTitle: "Access conversations",
    accessDesc: "Read recent Slack history you already can see — never posts.",
    tone: "slack",
    letter: "#",
  },
  "pull.dropbox": {
    name: "Dropbox",
    short: "Files",
    blurb: "Dropbox folder metadata for vault search — no bulk download.",
    accessTitle: "Access files",
    accessDesc:
      "List file metadata from your Dropbox so agents can find paths and names.",
    tone: "dropbox",
    letter: "Db",
  },
};

function kindLabelFallback(kind: string): string {
  const tail = kind.includes(".") ? kind.slice(kind.indexOf(".") + 1) : kind;
  return tail.charAt(0).toUpperCase() + tail.slice(1);
}

function metaFor(kind: string): FeaturedMeta {
  return (
    FEATURED_META[kind] ?? {
      name: kindLabelFallback(kind),
      short: "Connector",
      blurb: "Connect this data source to the vault.",
      accessTitle: "Access your data",
      accessDesc:
        "Authorize Centraid to read from this service on a schedule you set.",
      tone: "default",
      letter: kindLabelFallback(kind).slice(0, 1),
    }
  );
}

/** One featured tile in the catalog (unique connector kind per provider). */
export interface FeaturedConnector {
  key: string;
  providerId: string;
  kind: string;
  templateId: string;
  scope?: string;
  provider: ProviderOptionDTO;
  meta: FeaturedMeta;
}

/** Flatten provider presets into unique connector kinds (pull preferred over send). */
function buildFeatured(providers: ProviderOptionDTO[]): FeaturedConnector[] {
  const out: FeaturedConnector[] = [];
  const seen = new Set<string>();
  for (const p of providers) {
    for (const c of p.connectors) {
      // Prefer pull templates over send variants that share a kind.
      const key = `${p.id}:${c.kind}`;
      if (seen.has(key)) continue;
      // Skip send-only template ids when a pull of the same kind already exists.
      if (
        c.templateId.endsWith("-send") &&
        p.connectors.some(
          (x) => x.kind === c.kind && !x.templateId.endsWith("-send")
        )
      ) {
        continue;
      }
      seen.add(key);
      out.push({
        key,
        providerId: p.id,
        kind: c.kind,
        templateId: c.templateId,
        ...(c.scope ? { scope: c.scope } : {}),
        provider: p,
        meta: metaFor(c.kind),
      });
    }
  }
  return out;
}

function SetupGuide({ steps }: { steps: string[] }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.setupGuide}>
      <button
        type="button"
        className={styles.setupToggle}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="ChevronDown" size={12} />
        <span>{open ? "Hide setup guide" : "Show setup guide"}</span>
      </button>
      {open ? (
        <ol className={styles.setupList}>
          {steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

/**
 * A connection's identity is `(kind, label)` — so a second account for the same
 * connector must carry a distinct label or it silently reuses/overwrites the
 * first. When a label is already taken we suffix ` 2`, ` 3`, … so the default
 * never collides; the owner is still nudged to rename it to something meaningful.
 */
function withUniqueLabel(base: string, taken: readonly string[]): string {
  const used = new Set(taken.map((l) => l.trim().toLowerCase()));
  if (!used.has(base.trim().toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/** Labels of existing connections for a connector kind — powers multi-account uniqueness. */
function labelsForKind(
  rows: ConnectionRowDTO[] | null,
  kind: string
): string[] {
  return (rows ?? []).filter((r) => r.kind === kind).map((r) => r.label);
}

function ConnectForm({
  featured,
  busy,
  oauthCallbackUri,
  existingLabels,
  onCancel,
  onSubmit,
}: {
  featured: FeaturedConnector;
  busy: boolean;
  /** Shown for oauth2 so the owner can paste it into Google Cloud Console etc. */
  oauthCallbackUri: string | null;
  /** Labels already in use for this connector kind — for multi-account uniqueness. */
  existingLabels: readonly string[];
  onCancel: () => void;
  onSubmit: (input: ConnectionFormInput) => void;
}): JSX.Element {
  const provider = featured.provider;
  const isOauth = provider.credKind === "oauth2";
  const [label, setLabel] = useState(() =>
    withUniqueLabel(
      `${provider.name.split(" (")[0] ?? provider.name} · ${featured.meta.name}`,
      existingLabels
    )
  );
  const labelTaken = existingLabels.some(
    (l) => l.trim().toLowerCase() === label.trim().toLowerCase()
  );
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [apiKey, setApiKey] = useState("");

  const ready =
    label.trim().length > 0 &&
    (isOauth
      ? clientId.trim().length > 0 && clientSecret.trim().length > 0
      : apiKey.trim().length > 0);

  const submit = (): void => {
    if (!ready) return;
    onSubmit({
      allowedHosts: provider.allowedHosts,
      apiKey: isOauth ? undefined : apiKey.trim(),
      authUrl: provider.authUrl,
      clientId: isOauth ? clientId.trim() : undefined,
      clientSecret: isOauth ? clientSecret.trim() : undefined,
      connectorKind: featured.kind,
      credKind: provider.credKind,
      oauthMode: isOauth ? "byo" : undefined,
      label: label.trim(),
      providerId: provider.id,
      scopes: featured.scope ?? provider.scopes,
      tokenUrl: provider.tokenUrl,
    });
  };

  return (
    <div className={styles.wizard} data-testid="connector-wizard">
      <label className={styles.wizardField}>
        <span className={styles.wizardLabel}>Label</span>
        <input
          className={styles.textInput}
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          data-testid="connector-label-input"
        />
        <span
          className={styles.wizardHint}
          data-tone={labelTaken ? "warn" : undefined}
        >
          {labelTaken
            ? "Label already in use — saving updates that connection."
            : existingLabels.length > 0
              ? `${existingLabels.length} ${
                  existingLabels.length === 1 ? "account" : "accounts"
                } connected here — name this one distinctly (e.g. “${featured.meta.name} · work”).`
              : "A distinct label per account."}
        </span>
      </label>

      {isOauth ? (
        <>
          {oauthCallbackUri ? (
            <label className={styles.wizardField}>
              <span className={styles.wizardLabel}>
                Redirect URI (add this to your OAuth app)
              </span>
              <input
                className={styles.textInput}
                type="text"
                readOnly
                value={oauthCallbackUri}
                data-testid="oauth-redirect-uri"
                onFocus={(e) => e.currentTarget.select()}
              />
            </label>
          ) : null}
          <div className={styles.wizardRow}>
            <label className={styles.wizardField}>
              <span className={styles.wizardLabel}>Client ID</span>
              <input
                className={styles.textInput}
                type="text"
                autoComplete="off"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder={
                  provider.id === "google"
                    ? "….apps.googleusercontent.com"
                    : undefined
                }
              />
            </label>
            <label className={styles.wizardField}>
              <span className={styles.wizardLabel}>Client secret</span>
              <input
                className={styles.textInput}
                type="password"
                autoComplete="off"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
              />
            </label>
          </div>
        </>
      ) : (
        <label className={styles.wizardField}>
          <span className={styles.wizardLabel}>API key / token</span>
          <input
            className={styles.textInput}
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>
      )}

      <SetupGuide steps={[...provider.setup]} />

      <div className={styles.wizardFoot}>
        <Button variant="quiet" size="sm" label="Cancel" onClick={onCancel} />
        <Button
          variant="primary"
          size="sm"
          label={
            busy ? "Saving…" : isOauth ? "Save & authorize" : "Save connection"
          }
          disabled={!ready || busy}
          onClick={submit}
        />
      </div>
    </div>
  );
}

function scopeLabel(scope: string): string {
  if (scope.endsWith("/calendar.events"))
    return "Read and update Google Calendar events";
  if (scope.endsWith("/contacts")) return "Read and update Google Contacts";
  if (scope.endsWith("/gmail.readonly")) return "Read Gmail";
  if (scope.endsWith("/gmail.send"))
    return "Send Gmail (owner approval still required)";
  if (scope.endsWith("/drive.readonly")) return "Read Google Drive";
  return scope;
}

function AssistConnectForm({
  featured,
  busy,
  existingLabels,
  onCancel,
  onSubmit,
}: {
  featured: FeaturedConnector;
  busy: boolean;
  /** Labels already in use for this connector kind — for multi-account uniqueness. */
  existingLabels: readonly string[];
  onCancel: () => void;
  onSubmit: (input: ConnectionFormInput) => void;
}): JSX.Element {
  const assist = featured.provider.assist;
  const standardScopes = assist?.enabled ? assist.scopeTiers.standard : [];
  const restrictedScopes = assist?.enabled ? assist.scopeTiers.restricted : [];
  const connectorScopes = new Set(
    featured.provider.connectors
      .filter((connector) => connector.kind === featured.kind)
      .flatMap((connector) => (connector.scope ? [connector.scope] : []))
  );
  const permitted = [
    ...standardScopes.map((scope) => ({ scope, tier: "standard" as const })),
    ...restrictedScopes.map((scope) => ({
      scope,
      tier: "restricted" as const,
    })),
  ].filter(({ scope }) => connectorScopes.has(scope));
  const initialScope =
    featured.scope &&
    permitted.some(
      (entry) =>
        entry.scope === featured.scope &&
        (entry.tier !== "restricted" ||
          (assist?.enabled === true && assist.restrictedScopesEnabled))
    )
      ? featured.scope
      : permitted.find((entry) => entry.tier === "standard")?.scope;
  const [label, setLabel] = useState(() =>
    withUniqueLabel(`Google · ${featured.meta.name}`, existingLabels)
  );
  const labelTaken = existingLabels.some(
    (l) => l.trim().toLowerCase() === label.trim().toLowerCase()
  );
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialScope ? [initialScope] : [])
  );
  const toggle = (scope: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  };
  const ready = label.trim().length > 0 && selected.size > 0;
  if (!assist?.enabled) {
    return (
      <div className={styles.emptyNote}>
        Centraid Assist is unavailable on this gateway.
      </div>
    );
  }
  return (
    <div className={styles.wizard} data-testid="connector-assist-wizard">
      <label className={styles.wizardField}>
        <span className={styles.wizardLabel}>Label</span>
        <input
          className={styles.textInput}
          type="text"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          data-testid="connector-label-input"
        />
        <span
          className={styles.wizardHint}
          data-tone={labelTaken ? "warn" : undefined}
        >
          {labelTaken
            ? "Label already in use — saving updates that connection."
            : existingLabels.length > 0
              ? `${existingLabels.length} ${
                  existingLabels.length === 1 ? "account" : "accounts"
                } connected here — name this one distinctly (e.g. “${featured.meta.name} · work”).`
              : "A distinct label per account."}
        </span>
      </label>
      <fieldset className={styles.scopePicker}>
        <legend className={styles.wizardLabel}>Google capabilities</legend>
        {permitted.map(({ scope, tier }) => {
          const disabled =
            tier === "restricted" && !assist.restrictedScopesEnabled;
          return (
            <label
              key={scope}
              className={styles.scopeOption}
              data-disabled={disabled}
            >
              <input
                type="checkbox"
                checked={selected.has(scope)}
                disabled={disabled}
                onChange={() => toggle(scope)}
              />
              <span>
                {scopeLabel(scope)}
                {tier === "restricted" ? (
                  <small>
                    {assist.restrictedScopesEnabled
                      ? "Restricted Google scope"
                      : "Available after Google verification"}
                  </small>
                ) : (
                  <small>Sensitive scope · standard Assist tier</small>
                )}
              </span>
            </label>
          );
        })}
      </fieldset>
      <p className={styles.sheetNote}>
        Centraid does not request Google identity scopes (openid, email, or
        profile).
      </p>
      {permitted.length > 0 &&
      permitted.every(
        (entry) =>
          entry.tier === "restricted" && !assist.restrictedScopesEnabled
      ) ? (
        <p className={styles.sheetNote}>
          Unavailable until Google restricted-scope verification completes —
          your own OAuth client works now, under Advanced.
        </p>
      ) : null}
      <div className={styles.wizardFoot}>
        <Button variant="quiet" size="sm" label="Cancel" onClick={onCancel} />
        <Button
          variant="primary"
          size="sm"
          label={busy ? "Starting…" : "Continue to Google"}
          disabled={!ready || busy}
          onClick={() =>
            onSubmit({
              allowedHosts: featured.provider.allowedHosts,
              connectorKind: featured.kind,
              credKind: "oauth2",
              label: label.trim(),
              oauthMode: "assist",
              providerId: "google",
              scopes: [...selected].join(" "),
            })
          }
        />
      </div>
    </div>
  );
}

function ManualAssistHandoff({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (rawUrl: string) => void;
}): JSX.Element {
  const [returnLink, setReturnLink] = useState("");
  return (
    <details className={styles.manualHandoff}>
      <summary>Centraid did not reopen?</summary>
      <p>
        Copy the complete <code>centraid://oauth/finish</code> return link from
        the browser and paste it here. It is delivered directly to this gateway
        and is not saved.
      </p>
      <div className={styles.manualHandoffRow}>
        <input
          className={styles.textInput}
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={returnLink}
          placeholder="centraid://oauth/finish#…"
          aria-label="Centraid Assist return link"
          onChange={(event) => setReturnLink(event.target.value)}
        />
        <Button
          variant="secondary"
          size="sm"
          label={busy ? "Finishing…" : "Finish connecting"}
          disabled={busy || returnLink.trim().length === 0}
          onClick={() => onSubmit(returnLink)}
        />
      </div>
    </details>
  );
}

function BrandMark({
  meta,
  size = 36,
}: {
  meta: FeaturedMeta;
  size?: number;
}): JSX.Element {
  // ~70% of the soft tile so multicolor marks stay legible on dark chrome.
  const glyph = Math.round(size * 0.7);
  return (
    <span
      className={styles.brandMark}
      data-tone={meta.tone}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <ConnectorBrandGlyph tone={meta.tone} size={glyph} />
    </span>
  );
}

type SheetMode =
  | { kind: "closed" }
  | { kind: "picker" }
  | {
      kind: "detail";
      featured: FeaturedConnector;
      connecting: false | "assist" | "byo";
    }
  | {
      kind: "connection";
      row: ConnectionRowDTO;
      featured: FeaturedConnector | null;
      reconnecting: boolean;
    };

export default function SettingsConnectionsScreen({
  loadConnections,
  loadProviders,
  configureConnection,
  setConnectionStatus,
  detachConnection,
  beginAuthorize,
  completeAssistReturnLink,
  showToast,
  loadLinkedSyncs,
  loadAttachedSyncs,
  installSync,
  loadOAuthCallbackUri,
  onSignals,
  onVerbs,
}: SettingsConnectionsBridgeProps): JSX.Element {
  const [rows, setRows] = useState<ConnectionRowDTO[] | null>(null);
  // The last connections read that FAILED. It is its own state rather than an
  // absence of rows: a page that has read once and then lost the gateway is not
  // a page that is still loading, and the five-state model says so out loud.
  const [readError, setReadError] = useState<string | null>(null);
  const [lastReadAt, setLastReadAt] = useState<number | null>(null);
  const [attachedSyncs, setAttachedSyncs] = useState<AttachedSyncDTO[]>([]);
  const [providers, setProviders] = useState<ProviderOptionDTO[] | null>(null);
  const [filter, setFilter] = useState<ConnFilter>("all");
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const [sheet, setSheet] = useState<SheetMode>({ kind: "closed" });
  const [saving, setSaving] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [authorizingIds, setAuthorizingIds] = useState<Set<string>>(new Set());
  const [linkedSyncs, setLinkedSyncs] = useState<LinkedSyncDTO[] | null>(null);
  const [installingSync, setInstallingSync] = useState<string | null>(null);
  const [oauthCallbackUri, setOauthCallbackUri] = useState<string | null>(null);
  const [finishingManualHandoff, setFinishingManualHandoff] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollDeadline = useRef(0);

  const refresh = useCallback((): void => {
    void loadConnections()
      .then((fresh) => {
        setRows(fresh);
        setReadError(null);
        setLastReadAt(Date.now());
        // A sync list that cannot be read does not fail the page: the page is
        // about connections, and the syncs section simply does not appear.
        if (loadAttachedSyncs) {
          void loadAttachedSyncs(fresh)
            .then(setAttachedSyncs)
            .catch(() => setAttachedSyncs([]));
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setReadError(message);
        showToast(message);
      });
  }, [loadAttachedSyncs, loadConnections, showToast]);

  useEffect(() => {
    refresh();
    void loadProviders()
      .then(setProviders)
      .catch((error: unknown) =>
        showToast(error instanceof Error ? error.message : String(error))
      );
    if (loadOAuthCallbackUri) {
      void loadOAuthCallbackUri()
        .then(setOauthCallbackUri)
        .catch(() => setOauthCallbackUri(null));
    }
    return () => clearPollTimer(pollTimer);
  }, [
    loadConnections,
    loadProviders,
    loadOAuthCallbackUri,
    refresh,
    showToast,
  ]);

  useEffect(() => {
    const onHandoff = (event: Event): void => {
      const result = (event as CustomEvent<AssistHandoffResult>).detail;
      if (result.status === "complete") {
        setAuthorizingIds((current) => {
          const next = new Set(current);
          next.delete(result.connectionId);
          return next;
        });
        showToast("Connected with Centraid Assist.");
        refresh();
      } else if (result.status === "error") {
        setAuthorizingIds(new Set());
        showToast(result.message);
      }
    };
    window.addEventListener(ASSIST_HANDOFF_EVENT, onHandoff);
    return () => window.removeEventListener(ASSIST_HANDOFF_EVENT, onHandoff);
  }, [refresh, showToast]);

  const featured = useMemo(
    () => (providers ? buildFeatured(providers) : []),
    [providers]
  );

  const connectedKinds = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows ?? []) s.add(r.kind);
    return s;
  }, [rows]);

  const state = pageState(rows, readError);

  // The chips only exist in `full`, so a filter set there cannot survive the
  // list shrinking back — otherwise rows would stay hidden with no visible
  // control left to unhide them.
  const activeFilter =
    state === "full"
      ? (FILTERS.find((f) => f.id === filter) ?? FILTERS[0])
      : FILTERS[0];
  const visibleRows = useMemo(() => {
    const all = rows ?? [];
    if (activeFilter.health === null) return all;
    return all.filter((r) => r.health === activeFilter.health);
  }, [rows, activeFilter]);

  const countText = countLine(rows ?? []);
  // The health sentence is about ONE connection: the first that cannot reach
  // its service. A page that listed every lapse in the status line would be a
  // second copy of the list it is standing over.
  const lapsed = (rows ?? []).find(isLapsed) ?? null;
  const dependentSyncs = lapsed
    ? attachedSyncs.filter((s) => s.connectionId === lapsed.connectionId).length
    : 0;

  const withBusy = (id: string, fn: () => Promise<void>): void => {
    setBusyIds((s) => new Set(s).add(id));
    void fn()
      .catch((error: unknown) =>
        showToast(error instanceof Error ? error.message : String(error))
      )
      .finally(() => {
        setBusyIds((s) => {
          const next = new Set(s);
          next.delete(id);
          return next;
        });
        refresh();
      });
  };

  const pollAfterAuthorize = (connectionId: string): void => {
    pollUntilAuthorized(connectionId, {
      loadConnections,
      onRows: setRows,
      onSettled: (id) =>
        setAuthorizingIds((s) => {
          const n = new Set(s);
          n.delete(id);
          return n;
        }),
      pollDeadline,
      pollTimer,
    });
  };

  const onAuthorize = (row: ConnectionRowDTO): void => {
    setAuthorizingIds((s) => new Set(s).add(row.connectionId));
    void beginAuthorize(row.connectionId)
      .then(async (authUrl) => {
        if (row.oauthMode === "assist") {
          const host = await window.CentraidApi.getHostCapabilities?.();
          if (host?.platform === "web") {
            assertAssistWebOrigin();
            window.location.assign(authUrl);
            return;
          }
        }
        window.open(authUrl, "_blank", "noopener");
        pollAfterAuthorize(row.connectionId);
      })
      .catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : String(error));
        setAuthorizingIds((s) => {
          const n = new Set(s);
          n.delete(row.connectionId);
          return n;
        });
      });
  };

  const featuredForRow = (row: ConnectionRowDTO): FeaturedConnector | null => {
    const list = providers ? buildFeatured(providers) : [];
    return (
      list.find(
        (f) =>
          f.kind === row.kind &&
          (!row.provider || f.providerId === row.provider)
      ) ??
      list.find((f) => f.kind === row.kind) ??
      null
    );
  };

  const openConnectionDetail = (row: ConnectionRowDTO): void => {
    setLinkedSyncs(null);
    setSheet({
      kind: "connection",
      row,
      featured: featuredForRow(row),
      reconnecting: false,
    });
    if (loadLinkedSyncs) {
      void loadLinkedSyncs(row)
        .then(setLinkedSyncs)
        .catch(() => setLinkedSyncs([]));
    } else {
      setLinkedSyncs([]);
    }
  };

  const onReconnect = (row: ConnectionRowDTO): void => {
    if (row.credKind === "oauth2") {
      onAuthorize(row);
      return;
    }
    // api_key: re-open credential form without delete/recreate.
    const featuredLocal = featuredForRow(row);
    if (!featuredLocal) {
      showToast(
        "No provider preset for this connection — reconfigure from Featured."
      );
      return;
    }
    setSheet({
      kind: "connection",
      row,
      featured: featuredLocal,
      reconnecting: true,
    });
  };

  const onManualAssistHandoff = (rawUrl: string): void => {
    if (!completeAssistReturnLink) return;
    setFinishingManualHandoff(true);
    void completeAssistReturnLink(rawUrl)
      .then(({ connectionId }) => {
        setAuthorizingIds((current) => {
          const next = new Set(current);
          next.delete(connectionId);
          return next;
        });
        setSheet({ kind: "closed" });
        showToast("Connected with Centraid Assist.");
        refresh();
      })
      .catch((error: unknown) =>
        showToast(error instanceof Error ? error.message : String(error))
      )
      .finally(() => setFinishingManualHandoff(false));
  };

  const onSubmitWizard = (input: ConnectionFormInput): void => {
    setSaving(true);
    void configureConnection(input)
      .then(async (result) => {
        const connectionId =
          result && typeof result === "object" && "connectionId" in result
            ? result.connectionId
            : undefined;
        refresh();
        // oauth2: credentials alone are not enough — open the provider consent
        // screen so Gmail/Calendar/Drive actually authorize (needs-auth → ok).
        if (input.credKind === "oauth2" && connectionId) {
          setSheet({ kind: "closed" });
          setAuthorizingIds((s) => new Set(s).add(connectionId));
          try {
            const authUrl = await beginAuthorize(connectionId);
            if (input.oauthMode === "assist") {
              const host = await window.CentraidApi.getHostCapabilities?.();
              if (host?.platform === "web") {
                assertAssistWebOrigin();
                window.location.assign(authUrl);
                return;
              }
            }
            window.open(authUrl, "_blank", "noopener");
            pollAfterAuthorize(connectionId);
            showToast(
              input.oauthMode === "assist"
                ? `Finish connecting ${input.label} in your browser…`
                : `Authorize ${input.label} in the browser window…`
            );
          } catch (error: unknown) {
            showToast(error instanceof Error ? error.message : String(error));
            setAuthorizingIds((s) => {
              const n = new Set(s);
              n.delete(connectionId);
              return n;
            });
          }
          return;
        }
        setSheet({ kind: "closed" });
        showToast(`Connected · ${input.label}`);
      })
      .catch((error: unknown) =>
        showToast(error instanceof Error ? error.message : String(error))
      )
      .finally(() => setSaving(false));
  };

  const openDetail = (f: FeaturedConnector): void => {
    setSheet({ kind: "detail", featured: f, connecting: false });
  };

  const onInstallSync = (
    sync: LinkedSyncDTO,
    connection: ConnectionRowDTO
  ): void => {
    if (!installSync) return;
    setInstallingSync(sync.capabilityId);
    void installSync({ templateId: sync.templateId, connection })
      .then(() => {
        showToast(`Enabled · ${sync.title}`);
        return loadLinkedSyncs?.(connection).then(setLinkedSyncs);
      })
      .catch((error: unknown) =>
        showToast(error instanceof Error ? error.message : String(error))
      )
      .finally(() => setInstallingSync(null));
  };

  // The health action re-authorizes the lapsed connection, and it is published
  // to a channel that outlives this render — so it reaches the CURRENT handler
  // through a ref rather than closing over the one that existed when the query
  // resolved.
  const reconnectRef = useRef(onReconnect);
  useEffect(() => {
    reconnectRef.current = onReconnect;
  });

  useEffect(() => {
    if (!onSignals) return;
    const showsHealth = state === "ready" || state === "full";
    const health: RouteHealth | undefined = showsHealth
      ? lapsed
        ? {
            action: {
              label: "Re-authorize",
              run: () => reconnectRef.current(lapsed),
            },
            detail: `${sentence(
              lapsed.authNote ??
                (lapsed.lastRunAt
                  ? `It last worked ${relativeTime(lapsed.lastRunAt)}`
                  : "It has not worked yet")
            )} ${
              dependentSyncs === 0
                ? "No sync depends on it."
                : `${plural(dependentSyncs, "sync depends", "syncs depend")} on it.`
            }`,
            label: `${lapsed.label} ${
              lapsed.health === "failing"
                ? "is failing"
                : "needs re-authorization"
            }`,
          }
        : {
            detail:
              lastReadAt === null
                ? "Nothing needs re-authorizing."
                : `Read at ${new Date(lastReadAt).toLocaleTimeString(
                    undefined,
                    {
                      hour: "2-digit",
                      minute: "2-digit",
                    }
                  )}.`,
            label: "Every connection is working",
          }
      : undefined;
    onSignals({
      count: countText,
      state,
      ...(lastReadAt === null ? {} : { lastReadAt }),
      ...(health ? { health } : {}),
    });
  }, [countText, dependentSyncs, lapsed, lastReadAt, onSignals, state]);

  // The bar's two verbs both need state only this screen has: the Connect sheet
  // it opens, and whether the catalog section is showing.
  useEffect(() => {
    onVerbs?.({
      onCommit: () => setSheet({ kind: "picker" }),
      onSecondary: () => setCatalogOpen((open) => !open),
    });
  }, [onVerbs]);

  const hiddenByFilter = (rows?.length ?? 0) - visibleRows.length;
  const connectionRows: RowDef[] = visibleRows.map((row) => {
    const busy = busyIds.has(row.connectionId);
    const waiting = authorizingIds.has(row.connectionId);
    const configure = (): void => openConnectionDetail(row);
    return {
      action: {
        label: waiting ? "Still waiting…" : HEALTH_ACTION[row.health],
        onClick: () => {
          if (busy) return;
          if (isLapsed(row)) onReconnect(row);
          else if (row.health === "paused")
            withBusy(row.connectionId, () =>
              setConnectionStatus(row.connectionId, "active")
            );
          else configure();
        },
      },
      id: row.connectionId,
      meta: HEALTH_META[row.health],
      sub: connectionSub(row),
      title: row.label,
      ...(isLapsed(row) ? { net: true } : {}),
      // A row carries ONE action, and for a lapsed or paused connection that
      // action is what it needs next — so the door to everything else it can be
      // told (pause, resume, remove, its syncs) opens from the row's own detail
      // slot rather than becoming unreachable until it is healthy again.
      ...(row.health === "ok"
        ? {}
        : {
            children: (
              <Button
                label="Configure"
                onClick={configure}
                size="sm"
                variant="quiet"
              />
            ),
          }),
    };
  });

  const syncRows: RowDef[] = attachedSyncs.map((sync) => {
    const connection =
      (rows ?? []).find((r) => r.connectionId === sync.connectionId) ?? null;
    const stalled = connection ? isLapsed(connection) : false;
    return {
      action: {
        label: "Configure",
        onClick: () => {
          if (connection) openConnectionDetail(connection);
        },
      },
      id: sync.id,
      meta: stalled || !sync.enabled ? "Paused" : "On",
      sub: stalled
        ? "Paused while the connection is lapsed"
        : sync.enabled
          ? sync.cadence
          : `${sync.cadence} · paused by you`,
      title: `${sync.connectionLabel} → ${sync.name}`,
      ...(stalled ? { net: true } : {}),
    };
  });

  const catalogRows: RowDef[] = featured.map((f) => {
    const connected = connectedKinds.has(f.kind);
    return {
      action: {
        label: connected ? "Add another" : "Connect",
        onClick: () => openDetail(f),
      },
      id: f.key,
      sub: `${f.meta.short} · ${
        f.provider.credKind === "oauth2" ? "OAuth 2.0" : "API key"
      }`,
      title: f.meta.name,
      ...(connected ? { meta: "Connected" } : {}),
    };
  });

  const catalogSection = catalogOpen ? (
    <>
      <SectionBlock
        label="Catalog"
        meta={providers === null ? "" : String(catalogRows.length)}
      />
      {providers === null ? (
        <NoteBlock>Reading the catalog…</NoteBlock>
      ) : catalogRows.length === 0 ? (
        <NoteBlock>No providers are configured on this gateway.</NoteBlock>
      ) : (
        <RowsBlock rows={catalogRows} />
      )}
    </>
  ) : null;

  return (
    <div className={styles.page} data-testid="connectors-panel">
      {state === "error" ? (
        <>
          <PanelBlock
            action={{
              label: "Try again",
              onClick: () => {
                setTechnicalOpen(false);
                refresh();
              },
            }}
            action2={{
              label: technicalOpen
                ? "Hide the technical detail"
                : "Show the technical detail",
              onClick: () => setTechnicalOpen((open) => !open),
            }}
            body={CONNECTORS_ERROR_BODY}
            eyebrow="THIS PAGE COULD NOT LOAD"
            title={CONNECTORS_ERROR_TITLE}
            tone="net"
          />
          {technicalOpen && readError ? (
            <NoteBlock>{readError}</NoteBlock>
          ) : null}
        </>
      ) : state === "loading" ? (
        <>
          <PageSkeleton label="Reading connections" rows={6} />
          <NoteBlock>{SKELETON_NOTE}</NoteBlock>
        </>
      ) : state === "empty" ? (
        <>
          <EmptyBlock
            action={{
              label: "Open the catalog",
              onClick: () => setCatalogOpen(true),
            }}
            body={CONNECTORS_EMPTY_BODY}
            routine
            title={CONNECTORS_EMPTY_TITLE}
          />
          {catalogSection}
        </>
      ) : (
        <>
          {state === "full" ? (
            <ChipsBlock
              ariaLabel="Filter connections"
              chips={FILTERS.map((f) => ({
                id: f.id,
                label: f.label,
                on: f.id === filter,
              }))}
              onPick={(id) => setFilter(id as ConnFilter)}
            />
          ) : null}
          <SectionBlock
            label="Connections"
            meta={
              hiddenByFilter > 0
                ? `showing ${visibleRows.length} of ${rows?.length ?? 0}`
                : String(rows?.length ?? 0)
            }
          />
          {connectionRows.length === 0 ? (
            <EmptyBlock
              action={{
                label: "Show all",
                onClick: () => setFilter("all"),
              }}
              body="Every connection is in another state right now."
              routine
              title="Nothing matches that filter"
            />
          ) : (
            <RowsBlock rows={connectionRows} />
          )}
          {syncRows.length > 0 ? (
            <>
              <SectionBlock
                label="Attached data syncs"
                meta={String(syncRows.length)}
              />
              <RowsBlock rows={syncRows} />
            </>
          ) : null}
          <NoteBlock>
            A sync copies one narrow thing into the vault on a schedule.
          </NoteBlock>
          {catalogSection}
        </>
      )}
      {/* Detail / picker sheet */}
      {sheet.kind === "closed" ? null : (
        <div
          className={styles.backdrop}
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSheet({ kind: "closed" });
          }}
        >
          <dialog
            open
            className={styles.sheet}
            aria-modal="true"
            aria-labelledby="connector-sheet-title"
            data-testid="connector-sheet"
          >
            {sheet.kind === "picker" ? (
              <>
                <div className={styles.sheetHead}>
                  <div className={styles.sheetIdentity}>
                    <div>
                      <h2
                        id="connector-sheet-title"
                        className={styles.sheetTitle}
                      >
                        New Connector
                      </h2>
                      <p className={styles.sheetTag}>Choose a data source</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    className={styles.sheetClose}
                    aria-label="Close"
                    onClick={() => setSheet({ kind: "closed" })}
                  >
                    ×
                  </button>
                </div>
                <div className={styles.sheetBody}>
                  <div className={styles.pickerList}>
                    {featured.map((f) => (
                      <button
                        key={f.key}
                        type="button"
                        className={styles.pickerItem}
                        onClick={() => openDetail(f)}
                      >
                        <BrandMark meta={f.meta} size={32} />
                        <span className={styles.pickerMain}>
                          <span className={styles.pickerName}>
                            {f.meta.name}
                          </span>
                          <span className={styles.pickerSub}>
                            {f.meta.short}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </>
            ) : sheet.kind === "connection" ? (
              <>
                <div className={styles.sheetHead}>
                  <div className={styles.sheetIdentity}>
                    {sheet.featured ? (
                      <BrandMark meta={sheet.featured.meta} size={40} />
                    ) : null}
                    <div>
                      <h2
                        id="connector-sheet-title"
                        className={styles.sheetTitle}
                      >
                        {sheet.row.label}
                      </h2>
                      <p className={styles.sheetTag}>
                        {HEALTH_LABEL[sheet.row.health]}
                        {sheet.row.principal ? ` · ${sheet.row.principal}` : ""}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    className={styles.sheetClose}
                    aria-label="Close"
                    onClick={() => setSheet({ kind: "closed" })}
                  >
                    ×
                  </button>
                </div>
                <div
                  className={styles.sheetBody}
                  data-testid="connection-detail"
                >
                  <div className={styles.healthBlock}>
                    {sheet.row.lastRunAt
                      ? `Last run ${relativeTime(sheet.row.lastRunAt)}`
                      : "No successful run yet"}
                    {sheet.row.authNote ? ` · ${sheet.row.authNote}` : ""}
                  </div>
                  {(sheet.row.health === "needs-auth" ||
                    sheet.row.health === "failing") &&
                  !sheet.reconnecting ? (
                    <>
                      <div className={styles.sheetFoot}>
                        <Button
                          variant="primary"
                          label={
                            sheet.row.oauthMode === "assist"
                              ? authorizingIds.has(sheet.row.connectionId)
                                ? "Still waiting…"
                                : "Reconnect with Centraid Assist"
                              : "Reconnect"
                          }
                          onClick={() => onReconnect(sheet.row)}
                        />
                      </div>
                      {sheet.row.oauthMode === "assist" &&
                      completeAssistReturnLink ? (
                        <ManualAssistHandoff
                          busy={finishingManualHandoff}
                          onSubmit={onManualAssistHandoff}
                        />
                      ) : null}
                    </>
                  ) : null}
                  {sheet.reconnecting && sheet.featured ? (
                    <ConnectForm
                      featured={sheet.featured}
                      busy={saving}
                      oauthCallbackUri={oauthCallbackUri}
                      /* Reconnect re-authorizes THIS connection: keep its label
                         stable (no uniqueness suffix) so it updates in place. */
                      existingLabels={[]}
                      onCancel={() =>
                        setSheet({
                          kind: "connection",
                          row: sheet.row,
                          featured: sheet.featured,
                          reconnecting: false,
                        })
                      }
                      onSubmit={onSubmitWizard}
                    />
                  ) : (
                    <>
                      <div className={styles.aboutHead}>Syncs</div>
                      {linkedSyncs === null ? (
                        <div className={styles.emptyNote}>
                          Loading linked syncs…
                        </div>
                      ) : linkedSyncs.length === 0 ? (
                        <div className={styles.emptyNote}>
                          No pull syncs declared for this connector yet.
                        </div>
                      ) : (
                        <div
                          className={styles.syncList}
                          data-testid="connection-linked-syncs"
                        >
                          {linkedSyncs.map((s) => (
                            <div
                              key={s.capabilityId}
                              className={styles.syncRow}
                            >
                              <div>
                                <div className={styles.syncTitle}>
                                  {s.title}
                                </div>
                                <div className={styles.syncMeta}>
                                  {s.installedRef
                                    ? s.installedEnabled
                                      ? `Installed · ${s.installedRef}`
                                      : `Installed (paused) · ${s.installedRef}`
                                    : "Not installed"}
                                </div>
                              </div>
                              {s.installedRef ? null : (
                                <Button
                                  variant="primary"
                                  size="sm"
                                  label={
                                    installingSync === s.capabilityId
                                      ? "Enabling…"
                                      : "Enable sync"
                                  }
                                  disabled={
                                    !installSync || installingSync !== null
                                  }
                                  onClick={() => onInstallSync(s, sheet.row)}
                                />
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                      {/* Pause and Remove live HERE rather than on the row: the
                          row carries one action, and these two are the ones
                          that need the sentence beside them. */}
                      <div className={styles.sheetFoot}>
                        <Button
                          disabled={busyIds.has(sheet.row.connectionId)}
                          label={
                            sheet.row.health === "paused" ? "Resume" : "Pause"
                          }
                          onClick={() =>
                            withBusy(sheet.row.connectionId, () =>
                              setConnectionStatus(
                                sheet.row.connectionId,
                                sheet.row.health === "paused"
                                  ? "active"
                                  : "paused"
                              )
                            )
                          }
                          variant="secondary"
                        />
                        <Button
                          disabled={busyIds.has(sheet.row.connectionId)}
                          label="Remove"
                          onClick={() =>
                            withBusy(sheet.row.connectionId, () =>
                              detachConnection(
                                sheet.row.connectionId,
                                sheet.row.kind,
                                sheet.row.label
                              )
                            )
                          }
                          title="Deletes the connection and its credential — refused while outbox items or sync history remain."
                          variant="destructive"
                        />
                      </div>
                    </>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className={styles.sheetHead}>
                  <div className={styles.sheetIdentity}>
                    <BrandMark meta={sheet.featured.meta} size={40} />
                    <div>
                      <h2
                        id="connector-sheet-title"
                        className={styles.sheetTitle}
                      >
                        {sheet.featured.meta.name}
                      </h2>
                      <p className={styles.sheetTag}>
                        {sheet.featured.meta.short}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    className={styles.sheetClose}
                    aria-label="Close"
                    onClick={() => setSheet({ kind: "closed" })}
                  >
                    ×
                  </button>
                </div>
                <div className={styles.sheetBody}>
                  <p className={styles.sheetBlurb}>
                    {sheet.featured.meta.blurb}
                  </p>
                  <div
                    className={styles.authKindBanner}
                    data-kind={sheet.featured.provider.credKind}
                    data-testid="connector-auth-kind"
                  >
                    {sheet.featured.provider.credKind === "oauth2" ? (
                      <>
                        <strong>OAuth 2.0</strong>
                        <span>
                          {sheet.featured.provider.assist?.enabled
                            ? "Connect through Centraid Assist, or use your own OAuth client from Advanced."
                            : "Your own OAuth client — you sign in at the provider after saving credentials."}
                        </span>
                      </>
                    ) : (
                      <>
                        <strong>API key</strong>
                        <span>
                          Connect with a personal access token or integration
                          secret.
                        </span>
                      </>
                    )}
                  </div>

                  {sheet.connecting ? (
                    sheet.connecting === "assist" ? (
                      <AssistConnectForm
                        featured={sheet.featured}
                        busy={saving}
                        existingLabels={labelsForKind(
                          rows,
                          sheet.featured.kind
                        )}
                        onCancel={() =>
                          setSheet({
                            kind: "detail",
                            featured: sheet.featured,
                            connecting: false,
                          })
                        }
                        onSubmit={onSubmitWizard}
                      />
                    ) : (
                      <ConnectForm
                        featured={sheet.featured}
                        busy={saving}
                        oauthCallbackUri={oauthCallbackUri}
                        existingLabels={labelsForKind(
                          rows,
                          sheet.featured.kind
                        )}
                        onCancel={() =>
                          setSheet({
                            kind: "detail",
                            featured: sheet.featured,
                            connecting: false,
                          })
                        }
                        onSubmit={onSubmitWizard}
                      />
                    )
                  ) : (
                    <>
                      <div className={styles.about}>
                        <div className={styles.aboutHead}>
                          About this Connector
                        </div>
                        <div className={styles.aboutItem}>
                          <span className={styles.aboutIcon} aria-hidden="true">
                            <Icon name="Folder" size={14} />
                          </span>
                          <div className={styles.aboutText}>
                            <span className={styles.aboutTitle}>
                              {sheet.featured.meta.accessTitle}
                            </span>
                            <span className={styles.aboutDesc}>
                              {sheet.featured.meta.accessDesc}
                            </span>
                          </div>
                        </div>
                        <div className={styles.aboutItem}>
                          <span className={styles.aboutIcon} aria-hidden="true">
                            <Icon name="Key" size={14} />
                          </span>
                          <div className={styles.aboutText}>
                            <span className={styles.aboutTitle}>
                              {sheet.featured.provider.credKind === "oauth2"
                                ? sheet.featured.provider.assist?.enabled
                                  ? "Centraid Assist or your own OAuth client"
                                  : "OAuth 2.0 (your client)"
                                : "API key / token"}
                            </span>
                            <span className={styles.aboutDesc}>
                              {sheet.featured.provider.credKind === "oauth2"
                                ? sheet.featured.provider.assist?.enabled
                                  ? "The shared client secret lives in a stateless Cloudflare Worker; only your gateway stores tokens."
                                  : "Register a Web OAuth client with this gateway’s redirect URI, then paste Client ID + secret."
                                : "Credentials stay sealed on your gateway — never shared as training data."}
                            </span>
                          </div>
                        </div>
                        <div className={styles.aboutItem}>
                          <span className={styles.aboutIcon} aria-hidden="true">
                            <Icon name="CheckCircle" size={14} />
                          </span>
                          <div className={styles.aboutText}>
                            <span className={styles.aboutTitle}>
                              You control your data
                            </span>
                            <span className={styles.aboutDesc}>
                              Disconnect anytime. Reads only, on a schedule the
                              automation sets.
                            </span>
                          </div>
                        </div>
                      </div>
                      <p className={styles.sheetNote}>
                        {sheet.featured.provider.credKind === "oauth2"
                          ? sheet.featured.provider.assist?.enabled
                            ? "Tokens never pass through the browser, URL fragments, deep links, or Cloudflare storage."
                            : "OAuth 2.0 uses your own developer client (BYO)."
                          : "Paste an API key or personal token — review scopes first."}
                      </p>
                      <div className={styles.sheetFoot}>
                        <Button
                          variant="primary"
                          label={
                            sheet.featured.provider.credKind === "oauth2"
                              ? sheet.featured.provider.assist?.enabled
                                ? "Connect with Centraid"
                                : "Connect with OAuth 2.0 (Advanced)"
                              : "Connect"
                          }
                          onClick={() =>
                            setSheet({
                              kind: "detail",
                              featured: sheet.featured,
                              connecting:
                                sheet.featured.provider.credKind === "oauth2" &&
                                sheet.featured.provider.assist?.enabled
                                  ? "assist"
                                  : "byo",
                            })
                          }
                        />
                        {sheet.featured.provider.credKind === "oauth2" &&
                        sheet.featured.provider.assist?.enabled ? (
                          <Button
                            variant="secondary"
                            label="Use my own OAuth app (Advanced)"
                            onClick={() =>
                              setSheet({
                                kind: "detail",
                                featured: sheet.featured,
                                connecting: "byo",
                              })
                            }
                          />
                        ) : null}
                      </div>
                    </>
                  )}
                </div>
              </>
            )}
          </dialog>
        </div>
      )}
    </div>
  );
}

export { buildFeatured };
