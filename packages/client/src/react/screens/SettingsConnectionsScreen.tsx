// governance: allow-repo-hygiene file-size-limit (#363) single cohesive screen component for the Connectors gallery surface; splitting would fragment one visual unit
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { IconName } from '@centraid/design-tokens';
import { Button, Icon } from '../ui/index.js';
import { relativeTime } from '../format.js';
import { cx } from '../ui/cx.js';
import styles from './SettingsConnectionsScreen.module.css';
import controlsCss from '../styles/controls.module.css';
import { ConnectorBrandGlyph } from './connectorBrandMarks.js';

// Connectors gallery (issue #304 renderer half; primary sidebar page). Featured
// tile grid of gateway provider connectors (Gmail, Calendar, Drive, GitHub, …)
// with a detail/Connect sheet — not a sparse settings list. Same gateway I/O
// surface as before: configure / pause / authorize / remove.

export type ConnectionHealth = 'ok' | 'needs-auth' | 'paused' | 'failing';

export interface ConnectionRowDTO {
  connectionId: string;
  kind: string;
  label: string;
  principal: string | null;
  health: ConnectionHealth;
  /** `null` = no credential attached — the connection rides the
   *  harness-ambient lane rather than a BYO one. */
  credKind: 'oauth2' | 'api_key' | null;
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
  approval?: 'outbox';
  scope?: string;
}

export interface ProviderOptionDTO {
  id: string;
  name: string;
  credKind: 'oauth2' | 'api_key';
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
}

/** Linked automation summary on a connection detail (no secrets). */
export interface LinkedAutomationDTO {
  ref: string;
  name: string;
  enabled: boolean;
  kind: string | null;
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

/** The wizard's submitted form, already resolved to one connector — carries
 *  the chosen preset's auth/token URLs + host pin along so the data layer
 *  doesn't have to re-fetch the provider catalog to build the configure
 *  body. */
export interface ConnectionFormInput {
  providerId: string;
  connectorKind: string;
  label: string;
  credKind: 'oauth2' | 'api_key';
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
    input: ConnectionFormInput,
  ) => Promise<{ connectionId: string; status?: string } | void>;
  setConnectionStatus: (connectionId: string, status: 'active' | 'paused') => Promise<void>;
  /** Named `detachConnection` for historical reasons but performs the real
   *  removal (`sync.remove_connection`) — see `settingsConnectionsData.ts`. */
  detachConnection: (connectionId: string, kind: string, label: string) => Promise<void>;
  /** Begins the PKCE ceremony, returning the URL the owner's browser must
   *  visit. This screen opens it (`window.open`) — never navigates the app. */
  beginAuthorize: (connectionId: string) => Promise<string>;
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
}

const HEALTH_LABEL: Record<ConnectionHealth, string> = {
  failing: 'Failing',
  'needs-auth': 'Needs authorization',
  ok: 'Connected',
  paused: 'Paused',
};

const POLL_MS = 2000;
const POLL_WINDOW_MS = 45_000;

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
  'pull.gmail': {
    name: 'Gmail',
    short: 'Productivity',
    blurb: 'Search your inbox, summarize unread mail, and find messages from specific people.',
    accessTitle: 'Search your emails',
    accessDesc:
      'Search your inbox, summarize unread emails, and find messages from specific people.',
    tone: 'gmail',
    letter: 'M',
  },
  'pull.gcal': {
    name: 'Google Calendar',
    short: 'Productivity',
    blurb: 'Read calendar events and keep schedules in sync with the vault.',
    accessTitle: 'Access your calendar',
    accessDesc: 'Search events, summarize upcoming meetings, and keep the vault in sync.',
    tone: 'gcal',
    letter: '31',
  },
  'pull.gcontacts': {
    name: 'Google Contacts',
    short: 'Productivity',
    blurb: 'Pull people and contact details into the vault.',
    accessTitle: 'Access your contacts',
    accessDesc: 'Import people and contact details for vault-wide search.',
    tone: 'gcontacts',
    letter: 'P',
  },
  'pull.gdrive': {
    name: 'Google Drive',
    short: 'Productivity',
    blurb: 'Search for documents, summarize presentations, and ask questions about Drive files.',
    accessTitle: 'Access your files',
    accessDesc:
      'Search for documents, summarize presentations, and ask questions about your Drive files.',
    tone: 'gdrive',
    letter: 'D',
  },
  'pull.github': {
    name: 'GitHub',
    short: 'Developer',
    blurb:
      'Search repositories and code, explore issues and PRs, and keep project activity in the vault.',
    accessTitle: 'Access repositories',
    accessDesc: 'Search repositories and code, explore issues and PRs, and track project activity.',
    tone: 'github',
    letter: 'GH',
  },
  'pull.outlook': {
    name: 'Outlook Mail',
    short: 'Productivity',
    blurb: 'Search Outlook / Microsoft 365 mail and keep threads in the vault.',
    accessTitle: 'Search your emails',
    accessDesc: 'Read recent Outlook messages and stage them for vault-wide search.',
    tone: 'outlook',
    letter: 'O',
  },
  'pull.outlookcal': {
    name: 'Outlook Calendar',
    short: 'Productivity',
    blurb: 'Pull Outlook calendar events into Agenda.',
    accessTitle: 'Access your calendar',
    accessDesc: 'Import events from your Microsoft 365 calendar.',
    tone: 'outlookcal',
    letter: '31',
  },
  'pull.outlookcontacts': {
    name: 'Outlook Contacts',
    short: 'Productivity',
    blurb: 'Import Outlook people into your vault CRM.',
    accessTitle: 'Access your contacts',
    accessDesc: 'Pull Microsoft contacts as people, merge-aware on email and phone.',
    tone: 'outlookcontacts',
    letter: 'P',
  },
  'pull.onedrive': {
    name: 'OneDrive',
    short: 'Productivity',
    blurb: 'Recent OneDrive files as searchable vault messages.',
    accessTitle: 'Access your files',
    accessDesc: 'List recent OneDrive files so the assistant can find and summarize them.',
    tone: 'onedrive',
    letter: '☁',
  },
  'pull.gitlab': {
    name: 'GitLab',
    short: 'Developer',
    blurb: 'Issues and merge requests you are involved in, as vault threads.',
    accessTitle: 'Access projects',
    accessDesc: 'Pull GitLab issues and MRs with a personal access token.',
    tone: 'gitlab',
    letter: 'GL',
  },
  'pull.linear': {
    name: 'Linear',
    short: 'Developer',
    blurb: 'Linear issues land as searchable threads in the vault.',
    accessTitle: 'Access issues',
    accessDesc: 'List issues from your Linear workspaces via personal API key.',
    tone: 'linear',
    letter: 'Li',
  },
  'pull.notion': {
    name: 'Notion',
    short: 'Notes',
    blurb: 'Pages shared with your integration become searchable vault messages.',
    accessTitle: 'Access pages',
    accessDesc: 'Only pages you explicitly connect to the integration are imported.',
    tone: 'notion',
    letter: 'N',
  },
  'pull.todoist': {
    name: 'Todoist',
    short: 'Tasks',
    blurb: 'Active Todoist tasks stage into the vault for search and agents.',
    accessTitle: 'Access tasks',
    accessDesc: 'List open Todoist tasks (completed history is not bulk-imported).',
    tone: 'todoist',
    letter: '✓',
  },
  'pull.slack': {
    name: 'Slack',
    short: 'Communication',
    blurb: 'Recent DMs and channel messages land as vault threads.',
    accessTitle: 'Access conversations',
    accessDesc: 'Read recent Slack history you already can see — never posts.',
    tone: 'slack',
    letter: '#',
  },
  'pull.dropbox': {
    name: 'Dropbox',
    short: 'Files',
    blurb: 'Dropbox folder metadata for vault search — no bulk download.',
    accessTitle: 'Access files',
    accessDesc: 'List file metadata from your Dropbox so agents can find paths and names.',
    tone: 'dropbox',
    letter: 'Db',
  },
};

function connectorLabel(kind: string): string {
  return FEATURED_META[kind]?.name ?? kindLabelFallback(kind);
}

function kindLabelFallback(kind: string): string {
  const tail = kind.includes('.') ? kind.slice(kind.indexOf('.') + 1) : kind;
  return tail.charAt(0).toUpperCase() + tail.slice(1);
}

function metaFor(kind: string): FeaturedMeta {
  return (
    FEATURED_META[kind] ?? {
      name: kindLabelFallback(kind),
      short: 'Connector',
      blurb: 'Connect this data source to the vault.',
      accessTitle: 'Access your data',
      accessDesc: 'Authorize Centraid to read from this service on a schedule you set.',
      tone: 'default',
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
        c.templateId.endsWith('-send') &&
        p.connectors.some((x) => x.kind === c.kind && !x.templateId.endsWith('-send'))
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

function ConnectionRow({
  row,
  busy,
  authorizing,
  onToggleStatus,
  onDetach,
  onReconnect,
  onOpenDetail,
}: {
  row: ConnectionRowDTO;
  busy: boolean;
  authorizing: boolean;
  onToggleStatus: () => void;
  onDetach: () => void;
  onReconnect: () => void;
  onOpenDetail: () => void;
}): JSX.Element {
  const needsReconnect = row.health === 'needs-auth' || row.health === 'failing';
  return (
    <div className={styles.row} data-health={row.health} data-testid="connector-row">
      <button type="button" className={styles.rowMain} onClick={onOpenDetail}>
        <span className={styles.dot} data-health={row.health} />
        <div className={styles.rowMeta}>
          <div className={styles.rowName}>{row.label}</div>
          <span className={styles.rowSub}>
            {`${row.kind}${row.principal ? ` · ${row.principal}` : ''}${
              row.lastRunAt ? ` · last run ${relativeTime(row.lastRunAt)}` : ''
            }`}
          </span>
          {row.authNote ? <span className={styles.rowAuthNote}>{row.authNote}</span> : null}
        </div>
        <span className={styles.healthLabel} data-health={row.health}>
          {HEALTH_LABEL[row.health]}
        </span>
      </button>
      <div className={styles.rowActions}>
        {needsReconnect ? (
          <span data-testid="connector-reconnect">
            <Button
              variant="primary"
              size="sm"
              label={authorizing ? 'Waiting…' : 'Reconnect'}
              disabled={busy}
              onClick={onReconnect}
            />
          </span>
        ) : null}
        <Button
          variant="soft"
          size="sm"
          label={row.health === 'paused' ? 'Resume' : 'Pause'}
          disabled={busy}
          onClick={onToggleStatus}
        />
        <button
          type="button"
          className={cx(controlsCss.chip, controlsCss.chipDanger)}
          disabled={busy}
          title="Remove this connection entirely — deletes it and its credential. Refused if it still has undecided outbox items or sync history."
          onClick={onDetach}
        >
          Remove
        </button>
      </div>
    </div>
  );
}

function SetupGuide({ steps }: { steps: string[] }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.setupGuide}>
      <button type="button" className={styles.setupToggle} onClick={() => setOpen((o) => !o)}>
        <Icon name="ChevronDown" size={12} />
        <span>{open ? 'Hide setup guide' : 'Show setup guide'}</span>
      </button>
      {open ? (
        <ol className={styles.setupList}>
          {steps.map((s, i) => (
            // eslint-disable-next-line react/no-array-index-key -- (#330) static step list
            <li key={i}>{s}</li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function ConnectForm({
  featured,
  busy,
  oauthCallbackUri,
  onCancel,
  onSubmit,
}: {
  featured: FeaturedConnector;
  busy: boolean;
  /** Shown for oauth2 so the owner can paste it into Google Cloud Console etc. */
  oauthCallbackUri: string | null;
  onCancel: () => void;
  onSubmit: (input: ConnectionFormInput) => void;
}): JSX.Element {
  const provider = featured.provider;
  const isOauth = provider.credKind === 'oauth2';
  const [label, setLabel] = useState(
    () => `${provider.name.split(' (')[0] ?? provider.name} · ${featured.meta.name}`,
  );
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [apiKey, setApiKey] = useState('');

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
      label: label.trim(),
      providerId: provider.id,
      scopes: featured.scope ?? provider.scopes,
      tokenUrl: provider.tokenUrl,
    });
  };

  return (
    <div className={styles.wizard} data-testid="connector-wizard">
      <div className={styles.authKindBanner} data-kind={provider.credKind}>
        {isOauth ? (
          <>
            <strong>OAuth 2.0</strong>
            <span>
              Use your own client ID and secret (BYO). After you save, Centraid opens the provider
              consent screen to authorize access.
            </span>
          </>
        ) : (
          <>
            <strong>API key</strong>
            <span>Paste a personal access token or integration secret for this service.</span>
          </>
        )}
      </div>

      <label className={styles.wizardField}>
        <span className={styles.wizardLabel}>Label</span>
        <input
          className={styles.textInput}
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </label>

      {isOauth ? (
        <>
          {oauthCallbackUri ? (
            <label className={styles.wizardField}>
              <span className={styles.wizardLabel}>Redirect URI (add this to your OAuth app)</span>
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
                placeholder={provider.id === 'google' ? '….apps.googleusercontent.com' : undefined}
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
        <Button variant="ghost" size="sm" label="Cancel" onClick={onCancel} />
        <Button
          variant="primary"
          size="sm"
          label={busy ? 'Saving…' : isOauth ? 'Save & authorize' : 'Save connection'}
          disabled={!ready || busy}
          onClick={submit}
        />
      </div>
    </div>
  );
}

function BrandMark({ meta, size = 36 }: { meta: FeaturedMeta; size?: number }): JSX.Element {
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
  | { kind: 'closed' }
  | { kind: 'picker' }
  | { kind: 'detail'; featured: FeaturedConnector; connecting: boolean }
  | {
      kind: 'connection';
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
  showToast,
  loadLinkedSyncs,
  installSync,
  loadOAuthCallbackUri,
}: SettingsConnectionsBridgeProps): JSX.Element {
  const [rows, setRows] = useState<ConnectionRowDTO[] | null>(null);
  const [providers, setProviders] = useState<ProviderOptionDTO[] | null>(null);
  const [query, setQuery] = useState('');
  const [sheet, setSheet] = useState<SheetMode>({ kind: 'closed' });
  const [saving, setSaving] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [authorizingIds, setAuthorizingIds] = useState<Set<string>>(new Set());
  const [linkedSyncs, setLinkedSyncs] = useState<LinkedSyncDTO[] | null>(null);
  const [installingSync, setInstallingSync] = useState<string | null>(null);
  const [oauthCallbackUri, setOauthCallbackUri] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollDeadline = useRef(0);

  const refresh = useMemo(
    () => (): void => {
      void loadConnections()
        .then(setRows)
        .catch((err: unknown) => showToast(err instanceof Error ? err.message : String(err)));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (#330) refresh tracks loadConnections only
    [loadConnections],
  );

  useEffect(() => {
    refresh();
    void loadProviders()
      .then(setProviders)
      .catch((err: unknown) => showToast(err instanceof Error ? err.message : String(err)));
    if (loadOAuthCallbackUri) {
      void loadOAuthCallbackUri()
        .then(setOauthCallbackUri)
        .catch(() => setOauthCallbackUri(null));
    }
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (#524) mount-once load
  }, [loadConnections, loadProviders, loadOAuthCallbackUri]);

  const featured = useMemo(() => (providers ? buildFeatured(providers) : []), [providers]);

  const connectedKinds = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows ?? []) s.add(r.kind);
    return s;
  }, [rows]);

  const q = query.trim().toLowerCase();
  const filteredFeatured = useMemo(() => {
    if (!q) return featured;
    return featured.filter(
      (f) =>
        f.meta.name.toLowerCase().includes(q) ||
        f.meta.short.toLowerCase().includes(q) ||
        f.kind.toLowerCase().includes(q) ||
        f.provider.name.toLowerCase().includes(q),
    );
  }, [featured, q]);

  const filteredRows = useMemo(() => {
    if (!rows) return null;
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.label.toLowerCase().includes(q) ||
        r.kind.toLowerCase().includes(q) ||
        (r.principal?.toLowerCase().includes(q) ?? false),
    );
  }, [rows, q]);

  const withBusy = (id: string, fn: () => Promise<void>): void => {
    setBusyIds((s) => new Set(s).add(id));
    void fn()
      .catch((err: unknown) => showToast(err instanceof Error ? err.message : String(err)))
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
    pollDeadline.current = Date.now() + POLL_WINDOW_MS;
    const tick = (): void => {
      void loadConnections()
        .catch(() => [] as ConnectionRowDTO[])
        .then((freshRows) => {
          setRows(freshRows);
          const row = freshRows.find((r) => r.connectionId === connectionId);
          const done = !row || row.health !== 'needs-auth';
          if (done || Date.now() >= pollDeadline.current) {
            setAuthorizingIds((s) => {
              const n = new Set(s);
              n.delete(connectionId);
              return n;
            });
            return;
          }
          pollTimer.current = setTimeout(tick, POLL_MS);
        });
    };
    pollTimer.current = setTimeout(tick, POLL_MS);
  };

  const onAuthorize = (row: ConnectionRowDTO): void => {
    setAuthorizingIds((s) => new Set(s).add(row.connectionId));
    void beginAuthorize(row.connectionId)
      .then((authUrl) => {
        window.open(authUrl, '_blank', 'noopener');
        pollAfterAuthorize(row.connectionId);
      })
      .catch((err: unknown) => {
        showToast(err instanceof Error ? err.message : String(err));
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
      list.find((f) => f.kind === row.kind && (!row.provider || f.providerId === row.provider)) ??
      list.find((f) => f.kind === row.kind) ??
      null
    );
  };

  const openConnectionDetail = (row: ConnectionRowDTO): void => {
    setLinkedSyncs(null);
    setSheet({
      kind: 'connection',
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
    if (row.credKind === 'oauth2') {
      onAuthorize(row);
      return;
    }
    // api_key: re-open credential form without delete/recreate.
    const featured = featuredForRow(row);
    if (!featured) {
      showToast('No provider preset for this connection — reconfigure from Featured.');
      return;
    }
    setSheet({ kind: 'connection', row, featured, reconnecting: true });
  };

  const onSubmitWizard = (input: ConnectionFormInput): void => {
    setSaving(true);
    void configureConnection(input)
      .then(async (result) => {
        const connectionId =
          result && typeof result === 'object' && 'connectionId' in result
            ? result.connectionId
            : undefined;
        refresh();
        // oauth2: credentials alone are not enough — open the provider consent
        // screen so Gmail/Calendar/Drive actually authorize (needs-auth → ok).
        if (input.credKind === 'oauth2' && connectionId) {
          setSheet({ kind: 'closed' });
          setAuthorizingIds((s) => new Set(s).add(connectionId));
          try {
            const authUrl = await beginAuthorize(connectionId);
            window.open(authUrl, '_blank', 'noopener');
            pollAfterAuthorize(connectionId);
            showToast(`Authorize ${input.label} in the browser window…`);
          } catch (err: unknown) {
            showToast(err instanceof Error ? err.message : String(err));
            setAuthorizingIds((s) => {
              const n = new Set(s);
              n.delete(connectionId);
              return n;
            });
          }
          return;
        }
        setSheet({ kind: 'closed' });
        showToast(`Connected · ${input.label}`);
      })
      .catch((err: unknown) => showToast(err instanceof Error ? err.message : String(err)))
      .finally(() => setSaving(false));
  };

  const openDetail = (f: FeaturedConnector): void => {
    setSheet({ kind: 'detail', featured: f, connecting: false });
  };

  const onInstallSync = (sync: LinkedSyncDTO, connection: ConnectionRowDTO): void => {
    if (!installSync) return;
    setInstallingSync(sync.capabilityId);
    void installSync({ templateId: sync.templateId, connection })
      .then(() => {
        showToast(`Enabled · ${sync.title}`);
        return loadLinkedSyncs?.(connection).then(setLinkedSyncs);
      })
      .catch((err: unknown) => showToast(err instanceof Error ? err.message : String(err)))
      .finally(() => setInstallingSync(null));
  };

  return (
    <div className={styles.page} data-testid="connectors-panel">
      <header className={styles.toolbar}>
        <div className={styles.titleBlock}>
          <h1 className={styles.title}>Connectors</h1>
          <p className={styles.subtitle}>
            Data sources the vault pulls from — Gmail, Calendar, GitHub, and anything else you
            connect yourself.
          </p>
        </div>
        <div className={styles.toolbarActions}>
          <label className={styles.searchWrap}>
            <Icon name={'Search' as IconName} size={14} />
            <input
              className={styles.searchInput}
              type="search"
              placeholder="Search…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search connectors"
            />
          </label>
          <Button
            variant="primary"
            size="sm"
            label="New Connector"
            onClick={() => setSheet({ kind: 'picker' })}
          />
        </div>
      </header>

      {/* Connected — unhealthy first (attention queue via sortConnectionsByAttention). */}
      <section className={styles.section}>
        <div className={styles.sectionLabel}>
          {filteredRows?.some((r) => r.health === 'needs-auth' || r.health === 'failing')
            ? 'Your connections · needs attention'
            : 'Your connections'}
        </div>
        {filteredRows === null ? (
          <div className={styles.emptyNote}>Reading connectors…</div>
        ) : filteredRows.length === 0 ? (
          <div className={styles.emptyNote}>
            {rows && rows.length === 0
              ? 'No connectors configured yet. Pick one from Featured below.'
              : 'No connected connectors match your search.'}
          </div>
        ) : (
          <div className={styles.connectedList}>
            {filteredRows.map((row) => (
              <ConnectionRow
                key={row.connectionId}
                row={row}
                busy={busyIds.has(row.connectionId)}
                authorizing={authorizingIds.has(row.connectionId)}
                onReconnect={() => onReconnect(row)}
                onOpenDetail={() => openConnectionDetail(row)}
                onDetach={() =>
                  withBusy(row.connectionId, () =>
                    detachConnection(row.connectionId, row.kind, row.label),
                  )
                }
                onToggleStatus={() =>
                  withBusy(row.connectionId, () =>
                    setConnectionStatus(
                      row.connectionId,
                      row.health === 'paused' ? 'active' : 'paused',
                    ),
                  )
                }
              />
            ))}
          </div>
        )}
      </section>

      {/* Featured catalog */}
      <section className={styles.section}>
        <div className={styles.sectionLabel}>Featured</div>
        {providers === null ? (
          <div className={styles.emptyNote}>Loading catalog…</div>
        ) : filteredFeatured.length === 0 ? (
          <div className={styles.emptyNote}>
            {featured.length === 0
              ? 'No providers configured on this gateway.'
              : 'No connectors match your search.'}
          </div>
        ) : (
          <div className={styles.grid} data-testid="connectors-featured">
            {filteredFeatured.map((f) => {
              const connected = connectedKinds.has(f.kind);
              const authLabel = f.provider.credKind === 'oauth2' ? 'OAuth 2.0' : 'API key';
              return (
                <button
                  key={f.key}
                  type="button"
                  className={cx(styles.tile, connected ? styles.tileConnected : undefined)}
                  data-testid="connector-tile"
                  data-cred-kind={f.provider.credKind}
                  onClick={() => openDetail(f)}
                >
                  <BrandMark meta={f.meta} />
                  <span className={styles.tileMain}>
                    <span className={styles.tileName}>{f.meta.name}</span>
                    <span className={styles.tileMeta}>
                      {f.meta.short} · {authLabel}
                    </span>
                  </span>
                  {connected ? (
                    <span className={styles.tileBadge}>Connected</span>
                  ) : (
                    <span className={styles.tileBadgeMuted}>{authLabel}</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* Detail / picker sheet */}
      {sheet.kind !== 'closed' ? (
        <div
          className={styles.backdrop}
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSheet({ kind: 'closed' });
          }}
        >
          <div
            className={styles.sheet}
            role="dialog"
            aria-modal="true"
            aria-labelledby="connector-sheet-title"
            data-testid="connector-sheet"
          >
            {sheet.kind === 'picker' ? (
              <>
                <div className={styles.sheetHead}>
                  <div className={styles.sheetIdentity}>
                    <div>
                      <h2 id="connector-sheet-title" className={styles.sheetTitle}>
                        New Connector
                      </h2>
                      <p className={styles.sheetTag}>Choose a data source</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    className={styles.sheetClose}
                    aria-label="Close"
                    onClick={() => setSheet({ kind: 'closed' })}
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
                        <span className={styles.tileMain}>
                          <span className={styles.pickerName}>{f.meta.name}</span>
                          <span className={styles.pickerSub}>{f.meta.short}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </>
            ) : sheet.kind === 'connection' ? (
              <>
                <div className={styles.sheetHead}>
                  <div className={styles.sheetIdentity}>
                    {sheet.featured ? <BrandMark meta={sheet.featured.meta} size={40} /> : null}
                    <div>
                      <h2 id="connector-sheet-title" className={styles.sheetTitle}>
                        {sheet.row.label}
                      </h2>
                      <p className={styles.sheetTag}>
                        {HEALTH_LABEL[sheet.row.health]}
                        {sheet.row.principal ? ` · ${sheet.row.principal}` : ''}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    className={styles.sheetClose}
                    aria-label="Close"
                    onClick={() => setSheet({ kind: 'closed' })}
                  >
                    ×
                  </button>
                </div>
                <div className={styles.sheetBody} data-testid="connection-detail">
                  <div className={styles.healthBlock}>
                    {sheet.row.lastRunAt
                      ? `Last run ${relativeTime(sheet.row.lastRunAt)}`
                      : 'No successful run yet'}
                    {sheet.row.authNote ? ` · ${sheet.row.authNote}` : ''}
                  </div>
                  {(sheet.row.health === 'needs-auth' || sheet.row.health === 'failing') &&
                  !sheet.reconnecting ? (
                    <div className={styles.sheetFoot}>
                      <Button
                        variant="primary"
                        label="Reconnect"
                        onClick={() => onReconnect(sheet.row)}
                      />
                    </div>
                  ) : null}
                  {sheet.reconnecting && sheet.featured ? (
                    <ConnectForm
                      featured={sheet.featured}
                      busy={saving}
                      oauthCallbackUri={oauthCallbackUri}
                      onCancel={() =>
                        setSheet({
                          kind: 'connection',
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
                        <div className={styles.emptyNote}>Loading linked syncs…</div>
                      ) : linkedSyncs.length === 0 ? (
                        <div className={styles.emptyNote}>
                          No pull syncs declared for this connector yet.
                        </div>
                      ) : (
                        <div className={styles.syncList} data-testid="connection-linked-syncs">
                          {linkedSyncs.map((s) => (
                            <div key={s.capabilityId} className={styles.syncRow}>
                              <div>
                                <div className={styles.syncTitle}>{s.title}</div>
                                <div className={styles.syncMeta}>
                                  {s.installedRef
                                    ? s.installedEnabled
                                      ? `Installed · ${s.installedRef}`
                                      : `Installed (paused) · ${s.installedRef}`
                                    : 'Not installed'}
                                </div>
                              </div>
                              {s.installedRef ? null : (
                                <Button
                                  variant="primary"
                                  size="sm"
                                  label={
                                    installingSync === s.capabilityId ? 'Enabling…' : 'Enable sync'
                                  }
                                  disabled={!installSync || installingSync !== null}
                                  onClick={() => onInstallSync(s, sheet.row)}
                                />
                              )}
                            </div>
                          ))}
                        </div>
                      )}
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
                      <h2 id="connector-sheet-title" className={styles.sheetTitle}>
                        {sheet.featured.meta.name}
                      </h2>
                      <p className={styles.sheetTag}>{sheet.featured.meta.short}</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    className={styles.sheetClose}
                    aria-label="Close"
                    onClick={() => setSheet({ kind: 'closed' })}
                  >
                    ×
                  </button>
                </div>
                <div className={styles.sheetBody}>
                  <p className={styles.sheetBlurb}>{sheet.featured.meta.blurb}</p>
                  <div
                    className={styles.authKindBanner}
                    data-kind={sheet.featured.provider.credKind}
                    data-testid="connector-auth-kind"
                  >
                    {sheet.featured.provider.credKind === 'oauth2' ? (
                      <>
                        <strong>OAuth 2.0</strong>
                        <span>
                          Connect with your own Google / Microsoft / Dropbox OAuth client. You will
                          sign in at the provider after saving credentials.
                        </span>
                      </>
                    ) : (
                      <>
                        <strong>API key</strong>
                        <span>Connect with a personal access token or integration secret.</span>
                      </>
                    )}
                  </div>

                  {!sheet.connecting ? (
                    <>
                      <div className={styles.about}>
                        <div className={styles.aboutHead}>About this Connector</div>
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
                              {sheet.featured.provider.credKind === 'oauth2'
                                ? 'OAuth 2.0 (your client)'
                                : 'API key / token'}
                            </span>
                            <span className={styles.aboutDesc}>
                              {sheet.featured.provider.credKind === 'oauth2'
                                ? 'Register a Web application OAuth client with this gateway’s redirect URI, paste Client ID + secret here, then authorize in the browser.'
                                : 'Credentials stay sealed on your gateway — never shared as training data.'}
                            </span>
                          </div>
                        </div>
                        <div className={styles.aboutItem}>
                          <span className={styles.aboutIcon} aria-hidden="true">
                            <Icon name="CheckCircle" size={14} />
                          </span>
                          <div className={styles.aboutText}>
                            <span className={styles.aboutTitle}>You control your data</span>
                            <span className={styles.aboutDesc}>
                              Disconnect anytime. Reads only, on a schedule the automation sets.
                            </span>
                          </div>
                        </div>
                      </div>
                      <p className={styles.sheetNote}>
                        {sheet.featured.provider.credKind === 'oauth2'
                          ? 'OAuth 2.0 uses your own developer client (BYO). Centraid never hosts a shared Google app.'
                          : 'Paste an API key or personal token. Review scopes before connecting.'}
                      </p>
                      <div className={styles.sheetFoot}>
                        <Button
                          variant="primary"
                          label={
                            sheet.featured.provider.credKind === 'oauth2'
                              ? 'Connect with OAuth 2.0'
                              : 'Connect'
                          }
                          onClick={() =>
                            setSheet({
                              kind: 'detail',
                              featured: sheet.featured,
                              connecting: true,
                            })
                          }
                        />
                      </div>
                    </>
                  ) : (
                    <ConnectForm
                      featured={sheet.featured}
                      busy={saving}
                      oauthCallbackUri={oauthCallbackUri}
                      onCancel={() =>
                        setSheet({
                          kind: 'detail',
                          featured: sheet.featured,
                          connecting: false,
                        })
                      }
                      onSubmit={onSubmitWizard}
                    />
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// Re-export for tests that assert display names.
export { connectorLabel, buildFeatured };
