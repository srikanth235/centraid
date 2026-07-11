import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Icon } from '../ui/index.js';
import { relativeTime } from '../format.js';
import { cx } from '../ui/cx.js';
import styles from './SettingsConnectionsScreen.module.css';
import drawerGroupCss from '../styles/drawerGroup.module.css';
import controlsCss from '../styles/controls.module.css';
import buttonCss from '../ui/Button.module.css';

// Settings → Connections (issue #304's missing renderer half): the owner
// surface over the gateway's broker-owned OAuth / BYO-client connections.
// Lists every configured data-source connection with its health, offers an
// inline "Add connection" wizard sourced from the gateway's provider
// presets (Google, GitHub, …), and drives pause/resume/authorize/remove.
//
// Kept prop-driven like SettingsProvidersScreen: this file owns the view +
// wizard/interaction state only. The gateway I/O + confirm-gating for the
// destructive remove action live in `routes/settingsConnectionsData.ts`.
// "Remove" is a full delete (`sync.remove_connection`), refused by the
// server when the connection still has undecided outbox items or receipted
// sync history — that refusal surfaces through `showToast`.

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
  configureConnection: (input: ConnectionFormInput) => Promise<void>;
  setConnectionStatus: (connectionId: string, status: 'active' | 'paused') => Promise<void>;
  /** Named `detachConnection` for historical reasons (the wiring in
   *  `SettingsRoute.tsx` imports it under this name) but performs the real
   *  removal (`sync.remove_connection`) — see `settingsConnectionsData.ts`'s
   *  `makeDetachConnection`. */
  detachConnection: (connectionId: string, kind: string, label: string) => Promise<void>;
  /** Begins the PKCE ceremony, returning the URL the owner's browser must
   *  visit. This screen opens it (`window.open`, intercepted by main's
   *  `setWindowOpenHandler` into the OS browser) — it never navigates the
   *  app window itself. */
  beginAuthorize: (connectionId: string) => Promise<string>;
  showToast: (message: string) => void;
}

const HEALTH_LABEL: Record<ConnectionHealth, string> = {
  failing: 'Failing',
  'needs-auth': 'Needs authorization',
  ok: 'Connected',
  paused: 'Paused',
};

const POLL_MS = 2000;
const POLL_WINDOW_MS = 45_000;

function connectorLabel(kind: string): string {
  // "pull.gmail" → "Gmail", "pull.github" → "Github" — cosmetic only; the
  // wire kind is what's actually sent.
  const tail = kind.includes('.') ? kind.slice(kind.indexOf('.') + 1) : kind;
  return tail.charAt(0).toUpperCase() + tail.slice(1);
}

function ConnectionRow({
  row,
  busy,
  authorizing,
  onToggleStatus,
  onDetach,
  onAuthorize,
}: {
  row: ConnectionRowDTO;
  busy: boolean;
  authorizing: boolean;
  onToggleStatus: () => void;
  onDetach: () => void;
  onAuthorize: () => void;
}): JSX.Element {
  return (
    <div className={styles.row} data-health={row.health}>
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
      <div className={styles.rowActions}>
        {row.credKind === 'oauth2' && row.health !== 'ok' ? (
          <button
            type="button"
            className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
            disabled={busy}
            onClick={onAuthorize}
          >
            {authorizing ? 'Waiting…' : 'Authorize'}
          </button>
        ) : null}
        <button
          type="button"
          className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
          disabled={busy}
          onClick={onToggleStatus}
        >
          {row.health === 'paused' ? 'Resume' : 'Pause'}
        </button>
        <button
          type="button"
          className={cx(controlsCss.chip, styles.removeBtn)}
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
            // eslint-disable-next-line react/no-array-index-key -- (#330) static step list, no reorder/insert
            <li key={i}>{s}</li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function AddConnectionWizard({
  providers,
  busy,
  onCancel,
  onSubmit,
}: {
  providers: ProviderOptionDTO[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: ConnectionFormInput) => void;
}): JSX.Element {
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '');
  const provider = providers.find((p) => p.id === providerId) ?? providers[0];
  const [connectorKind, setConnectorKind] = useState(provider?.connectors[0]?.kind ?? '');
  const connector =
    provider?.connectors.find((c) => c.kind === connectorKind) ?? provider?.connectors[0];
  const [label, setLabel] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [apiKey, setApiKey] = useState('');

  // Re-seed the connector + label whenever the provider changes.
  useEffect(() => {
    const first = provider?.connectors[0]?.kind ?? '';
    setConnectorKind(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (#330) intentionally re-seeds only on providerId change
  }, [providerId]);
  useEffect(() => {
    if (provider && connector) {
      const providerName = provider.name.split(' (')[0] ?? provider.name;
      setLabel(
        provider.connectors.length > 1
          ? `${providerName} · ${connectorLabel(connector.kind)}`
          : providerName,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (#330) intentionally re-seeds only on providerId/connectorKind change
  }, [providerId, connectorKind]);

  if (!provider || !connector) {
    return <div className={controlsCss.note}>No providers configured on this gateway.</div>;
  }

  const ready =
    label.trim().length > 0 &&
    (provider.credKind === 'oauth2'
      ? clientId.trim().length > 0 && clientSecret.trim().length > 0
      : apiKey.trim().length > 0);

  const submit = (): void => {
    if (!ready) return;
    onSubmit({
      allowedHosts: provider.allowedHosts,
      apiKey: provider.credKind === 'api_key' ? apiKey.trim() : undefined,
      authUrl: provider.authUrl,
      clientId: provider.credKind === 'oauth2' ? clientId.trim() : undefined,
      clientSecret: provider.credKind === 'oauth2' ? clientSecret.trim() : undefined,
      connectorKind: connector.kind,
      credKind: provider.credKind,
      label: label.trim(),
      providerId: provider.id,
      scopes: connector.scope ?? provider.scopes,
      tokenUrl: provider.tokenUrl,
    });
  };

  return (
    <div className={styles.wizard}>
      <div className={styles.wizardRow}>
        <label className={styles.wizardField}>
          <span className={styles.wizardLabel}>Provider</span>
          <select
            className={styles.select}
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {provider.connectors.length > 1 ? (
          <label className={styles.wizardField}>
            <span className={styles.wizardLabel}>Data source</span>
            <select
              className={styles.select}
              value={connectorKind}
              onChange={(e) => setConnectorKind(e.target.value)}
            >
              {provider.connectors.map((c) => (
                <option key={c.kind} value={c.kind}>
                  {connectorLabel(c.kind)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
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

      {provider.credKind === 'oauth2' ? (
        <div className={styles.wizardRow}>
          <label className={styles.wizardField}>
            <span className={styles.wizardLabel}>Client ID</span>
            <input
              className={styles.textInput}
              type="text"
              autoComplete="off"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
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
        <button type="button" className={controlsCss.chip} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className={cx(buttonCss.btn, buttonCss.primary, buttonCss.sm)}
          disabled={!ready || busy}
          onClick={submit}
        >
          {busy ? 'Saving…' : 'Save connection'}
        </button>
      </div>
    </div>
  );
}

export default function SettingsConnectionsScreen({
  loadConnections,
  loadProviders,
  configureConnection,
  setConnectionStatus,
  detachConnection,
  beginAuthorize,
  showToast,
}: SettingsConnectionsBridgeProps): JSX.Element {
  const [rows, setRows] = useState<ConnectionRowDTO[] | null>(null);
  const [providers, setProviders] = useState<ProviderOptionDTO[] | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [authorizingIds, setAuthorizingIds] = useState<Set<string>>(new Set());
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollDeadline = useRef(0);

  const refresh = useMemo(
    () => (): void => {
      void loadConnections()
        .then(setRows)
        .catch((err: unknown) => showToast(err instanceof Error ? err.message : String(err)));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (#330) refresh() identity is meant to track loadConnections only
    [loadConnections],
  );

  useEffect(() => {
    refresh();
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (#330) refresh() is stable via useMemo, re-run only on loadConnections
  }, [loadConnections]);

  const openWizard = (): void => {
    setWizardOpen(true);
    if (!providers) {
      void loadProviders()
        .then(setProviders)
        .catch((err: unknown) => {
          showToast(err instanceof Error ? err.message : String(err));
          setWizardOpen(false);
        });
    }
  };

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
        // Intercepted by the main process's setWindowOpenHandler into the
        // OS default browser — no custom IPC channel needed (main.ts already
        // routes http(s)/mailto window.open calls to shell.openExternal).
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

  const onSubmitWizard = (input: ConnectionFormInput): void => {
    setSaving(true);
    void configureConnection(input)
      .then(() => {
        setWizardOpen(false);
        refresh();
      })
      .catch((err: unknown) => showToast(err instanceof Error ? err.message : String(err)))
      .finally(() => setSaving(false));
  };

  return (
    <div className={drawerGroupCss.group}>
      <div className={drawerGroupCss.groupLabel}>Connections</div>
      <div className={drawerGroupCss.groupBody}>
        <div className={controlsCss.note}>
          Data sources the vault pulls from — Gmail, Calendar, GitHub, and anything else you connect
          with your own OAuth client or API key. Reads only, on a schedule the automation sets.
        </div>

        <div className={styles.panel}>
          {rows === null ? (
            <div className={controlsCss.note}>Reading connections…</div>
          ) : rows.length === 0 ? (
            <div className={styles.empty}>No connections configured yet.</div>
          ) : (
            rows.map((row) => (
              <ConnectionRow
                key={row.connectionId}
                row={row}
                busy={busyIds.has(row.connectionId)}
                authorizing={authorizingIds.has(row.connectionId)}
                onAuthorize={() => onAuthorize(row)}
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
            ))
          )}
        </div>

        {wizardOpen ? (
          providers === null ? (
            <div className={controlsCss.note}>Loading providers…</div>
          ) : (
            <AddConnectionWizard
              providers={providers}
              busy={saving}
              onCancel={() => setWizardOpen(false)}
              onSubmit={onSubmitWizard}
            />
          )
        ) : (
          <button
            type="button"
            className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
            onClick={openWizard}
          >
            <Icon name="Plus" size={13} />
            <span>Add connection</span>
          </button>
        )}
      </div>
    </div>
  );
}
