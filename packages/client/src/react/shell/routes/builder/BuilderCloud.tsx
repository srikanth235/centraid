// governance: allow-repo-hygiene file-size-limit (#363) single cohesive builder-tab panel (cloud/publish surface); splitting would fragment one visual unit
import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import {
  appLiveUrl,
  appLogs,
  deleteAutomation,
  listAutomations,
  listVersions,
  readAutomationRun,
  runAutomationNow,
  setAutomationEnabled,
} from '../../../../gateway-client.js';
import { relativeWhen } from '../../../../format.js';
import { iconSvg } from '../../iconSvg.js';
import { cx } from '../../../ui/cx.js';
import buttonCss from '../../../ui/Button.module.css';
import styles from './BuilderCloud.module.css';
import toastCss from '../../../styles/toast.module.css';

// React port of the vanilla builder's Cloud tab (builder.ts `renderCloud`,
// ~lines 1722–2463). Renders the same global `.cloud-*` class names — the
// styles already live in styles.css. The component returns the inner
// `.cloud-pane` (rail + stage); the shell wraps it in `.right-pane-content`.
//
// Faithful to the vanilla behaviour: rail section switching, the overview
// hero + status tiles + recent-activity feed (from `listVersions`), the
// automations list with enable/disable/run-now/delete + run-result readback,
// and the live logs tail with a 3s poll while the Logs section is active.
// Storage / Users / Secrets / Edge-functions stay disabled "Coming soon"
// rail rows exactly as the vanilla renders them (no SQL browser).

// ---------------------------------------------------------------------------
// Inline SVG glyphs — copied verbatim from builder.ts (~lines 84, 95–108). The
// cloud-rail sub-section glyphs plus the topbar Refresh icon. Kept as string
// builders so they can feed dangerouslySetInnerHTML, matching the vanilla
// `innerHTML` shape byte-for-byte.
const RefreshIcon = (size = 14): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.5-6.3L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16"/><path d="M3 21v-5h5"/></svg>`;
const CloudOverviewIcon = (size = 14): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>`;
const UsersIcon = (size = 14): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
const StorageIcon = (size = 14): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><line x1="7" y1="7" x2="7.01" y2="7"/><line x1="7" y1="17" x2="7.01" y2="17"/></svg>`;
const SecretsIcon = (size = 14): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="m10.85 12.15 9.65-9.65"/><path d="m18 5 3 3"/><path d="m15 8 3 3"/></svg>`;
const FunctionsIcon = (size = 14): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H6a2 2 0 0 0-2 2v3"/><path d="M4 15v3a2 2 0 0 0 2 2h3"/><path d="M15 4h3a2 2 0 0 1 2 2v3"/><path d="M20 15v3a2 2 0 0 1-2 2h-3"/><path d="M10 9c1 0 1 .5 1 1.5S10.5 12 11 13s2 1.5 2 1.5"/></svg>`;
const LogsIcon = (size = 14): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="14" y2="18"/></svg>`;
const AutomationsIcon = (size = 14): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>`;

type CloudSection =
  | 'overview'
  | 'automations'
  | 'users'
  | 'storage'
  | 'secrets'
  | 'functions'
  | 'logs';

const SECTIONS: [CloudSection, string, (n?: number) => string, boolean][] = [
  ['overview', 'Overview', CloudOverviewIcon, true],
  ['automations', 'Automations', AutomationsIcon, true],
  ['logs', 'Logs', LogsIcon, true],
  ['users', 'Users', UsersIcon, false],
  ['storage', 'Storage', StorageIcon, false],
  ['secrets', 'Secrets', SecretsIcon, false],
  ['functions', 'Edge functions', FunctionsIcon, false],
];

type VersionsCache =
  | { activeVersion?: string; versions: CentraidVersionRecord[] }
  | undefined
  | 'pending'
  | 'error';
type LogsCache = CentraidLogEntry[] | undefined | 'pending' | 'error';
type AutomationsCache = CentraidAutomationRow[] | undefined | 'pending' | 'error';

// Per-row run state so the spinner + last-result chip survive a re-render.
// Keyed by automation name. Mirrors the vanilla `automationRunState` Map.
type RunState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; ok: boolean; durationMs: number; error?: string; finishedAt: number };

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// The live deployment URL, formatted for the hero line (vanilla
// `formatPreviewUrl`). Draft-preview URLs collapse to a label; everything
// else shows host + path.
function formatPreviewUrl(src: string): string {
  try {
    const u = new URL(src);
    if (u.pathname.includes('/_draft/')) return 'Draft preview';
    return u.host + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    return src;
  }
}

// Ephemeral confirmation toast — mirrors the vanilla builder's `showToast`
// (a `toastCss.toast` appended to <body>, auto-removed after 2.4s).
function showToast(text: string): void {
  const existing = toastCss.toast ? document.body.querySelector(`.${toastCss.toast}`) : null;
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = toastCss.toast ?? '';
  toast.innerHTML = `${iconSvg('Check', 13, 2.5)} <span></span>`;
  const span = toast.querySelector('span');
  if (span) span.textContent = text;
  document.body.append(toast);
  setTimeout(() => toast.remove(), 2400);
}

// Poll the run ledger until a run finishes — run-now fires in the background,
// so a caller reporting an outcome must wait for it (vanilla
// `waitForAutomationRun`).
async function waitForAutomationRun(runId: string): Promise<CentraidAutomationRunRecord> {
  const deadline = Date.now() + 6 * 60 * 1000;
  while (Date.now() < deadline) {
    const rec = await readAutomationRun({ runId });
    if (rec && rec.endedAt !== undefined) return rec;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error('run did not finish within 6 minutes');
}

export interface BuilderCloudProps {
  appId: string;
}

export default function BuilderCloud({ appId }: BuilderCloudProps): JSX.Element {
  const [active, setActive] = useState<CloudSection>('overview');

  // Overview — active version + count, plus the derived live URL.
  const [versionsCache, setVersionsCache] = useState<VersionsCache>(undefined);
  const [liveUrl, setLiveUrl] = useState<string | undefined>(undefined);

  // Logs — newest-first, polled every 3s while the Logs section is visible.
  const [logsCache, setLogsCache] = useState<LogsCache>(undefined);
  const [logsError, setLogsError] = useState<string | undefined>(undefined);
  const [logsLevelFilter, setLogsLevelFilter] = useState<CentraidLogLevel | 'all'>('all');
  const [logsSearch, setLogsSearch] = useState('');
  const logsCacheRef = useRef<LogsCache>(undefined);

  // Automations (issue #70) — the per-gateway mirror, filtered to this app.
  const [automationsCache, setAutomationsCache] = useState<AutomationsCache>(undefined);
  const [automationsError, setAutomationsError] = useState<string | undefined>(undefined);
  const [runStates, setRunStates] = useState<Record<string, RunState>>({});
  const automationsCacheRef = useRef<AutomationsCache>(undefined);

  // ---- Overview: fetch versions once per app, then derive the live URL. ----
  useEffect(() => {
    let cancelled = false;
    if (!appId) {
      setVersionsCache(undefined);
      return;
    }
    setVersionsCache('pending');
    void (async () => {
      let result: { activeVersion?: string; versions: CentraidVersionRecord[] };
      try {
        result = await listVersions({ id: appId });
      } catch {
        // The gateway 404s/409s before the first publish; treat every failure
        // as "no versions yet" rather than surfacing the raw error.
        result = { versions: [] };
      }
      if (cancelled) return;
      setVersionsCache(result);
      if (result.activeVersion) {
        try {
          const r = await appLiveUrl({ id: appId });
          if (!cancelled) setLiveUrl(r.url);
        } catch {
          /* preview URL is non-essential */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [appId]);

  // ---- Logs data + 3s poll (only while the Logs section is active). ----
  const refreshLogs = useCallback(async (): Promise<void> => {
    if (!appId) return;
    if (logsCacheRef.current === 'pending') return;
    logsCacheRef.current = 'pending';
    try {
      const r = await appLogs({ id: appId, limit: 200 });
      logsCacheRef.current = r.entries;
      setLogsCache(r.entries);
      setLogsError(undefined);
    } catch (err) {
      logsCacheRef.current = 'error';
      setLogsCache('error');
      setLogsError(err instanceof Error ? err.message : String(err));
    }
  }, [appId]);

  useEffect(() => {
    if (active !== 'logs' || !appId) return;
    void refreshLogs();
    // Mirror the vanilla `cloudLogsPoll` / `stopCloudLogsPoll`: start a 3s
    // interval on entry, clear it on section-switch / unmount. No leaks.
    const handle = setInterval(() => {
      void refreshLogs();
    }, 3000);
    return () => clearInterval(handle);
  }, [active, appId, refreshLogs]);

  // ---- Automations data + mutations. ----
  const refreshAutomations = useCallback(async (): Promise<void> => {
    if (!appId) return;
    if (automationsCacheRef.current === 'pending') return;
    automationsCacheRef.current = 'pending';
    setAutomationsCache('pending');
    try {
      const all = await listAutomations();
      // Automations are user-owned apps; show the ones associated with the
      // app being built (issue #91).
      const filtered = all.filter((r) => r.manifest.apps?.includes(appId));
      automationsCacheRef.current = filtered;
      setAutomationsCache(filtered);
      setAutomationsError(undefined);
    } catch (err) {
      automationsCacheRef.current = 'error';
      setAutomationsCache('error');
      setAutomationsError(err instanceof Error ? err.message : String(err));
    }
  }, [appId]);

  useEffect(() => {
    if (active === 'automations' && automationsCacheRef.current === undefined) {
      void refreshAutomations();
    }
  }, [active, refreshAutomations]);

  const onToggleAutomation = useCallback(
    async (row: CentraidAutomationRow, next: boolean): Promise<void> => {
      if (!appId) return;
      try {
        await setAutomationEnabled({ automationId: row.ref, enabled: next });
        await refreshAutomations();
      } catch (err) {
        automationsCacheRef.current = 'error';
        setAutomationsCache('error');
        setAutomationsError(err instanceof Error ? err.message : String(err));
      }
    },
    [appId, refreshAutomations],
  );

  const onRunAutomation = useCallback(
    async (row: CentraidAutomationRow): Promise<void> => {
      if (!appId) return;
      setRunStates((s) => ({ ...s, [row.name]: { kind: 'running' } }));
      try {
        // run-now fires in the background and returns the run id; poll the
        // ledger for the finished record to report the outcome.
        const { runId } = await runAutomationNow({ automationId: row.ref });
        const rec = await waitForAutomationRun(runId);
        setRunStates((s) => ({
          ...s,
          [row.name]: {
            kind: 'done',
            ok: rec.ok,
            durationMs: (rec.endedAt ?? Date.now()) - rec.startedAt,
            ...(rec.error ? { error: rec.error } : {}),
            finishedAt: Date.now(),
          },
        }));
      } catch (err) {
        setRunStates((s) => ({
          ...s,
          [row.name]: {
            kind: 'done',
            ok: false,
            durationMs: 0,
            error: err instanceof Error ? err.message : String(err),
            finishedAt: Date.now(),
          },
        }));
      }
    },
    [appId],
  );

  const onDeleteAutomation = useCallback(
    async (row: CentraidAutomationRow): Promise<void> => {
      if (!appId) return;
      const ok = confirm(
        `Delete automation "${row.name}"?\n\nThis permanently removes the automation app directory and its run history.`,
      );
      if (!ok) return;
      try {
        await deleteAutomation({ automationId: row.ref });
        setRunStates((s) => {
          const next = { ...s };
          delete next[row.name];
          return next;
        });
        await refreshAutomations();
      } catch (err) {
        automationsCacheRef.current = 'error';
        setAutomationsCache('error');
        setAutomationsError(err instanceof Error ? err.message : String(err));
      }
    },
    [appId, refreshAutomations],
  );

  // ---- Rail. Ready items first, then a "Coming soon" group. ----
  const selectSection = (key: CloudSection, ready: boolean): void => {
    if (!ready) return;
    if (active === key) return;
    setActive(key);
  };
  const railBtn = (
    key: CloudSection,
    label: string,
    renderIcon: (n?: number) => string,
    ready: boolean,
  ): JSX.Element => (
    <button
      key={key}
      type="button"
      className={styles.railItem}
      data-active={String(active === key)}
      data-ready={String(ready)}
      onClick={() => selectSection(key, ready)}
      dangerouslySetInnerHTML={{
        __html: `${renderIcon(14)}<span class="${styles.railLabel}">${label}</span>`,
      }}
    />
  );
  const soon = SECTIONS.filter((s) => !s[3]);

  const def = SECTIONS.find(([k]) => k === active);
  const title = def?.[1] ?? '';
  const subtitle =
    active === 'overview'
      ? 'Status of your app on the gateway.'
      : active === 'logs'
        ? 'Recent log lines from query and action handlers.'
        : active === 'automations'
          ? 'Cron-scheduled actions registered for this app. Toggle, run now, or remove them.'
          : 'View and manage the data stored in your app.';

  return (
    <div className={styles.pane}>
      <div className={styles.rail}>
        {SECTIONS.filter((s) => s[3]).map(([key, label, renderIcon, ready]) =>
          railBtn(key, label, renderIcon, ready),
        )}
        {soon.length > 0 && (
          <>
            <div className={styles.railGroupHead}>Coming soon</div>
            {soon.map(([key, label, renderIcon, ready]) => railBtn(key, label, renderIcon, ready))}
          </>
        )}
      </div>

      <div className={cx(styles.stage, active === 'overview' && styles.stageAtmospheric)}>
        {/* The Overview surface opens straight into its hero strip, so the
            stage head is rendered for every section except Overview. */}
        {active !== 'overview' && (
          <div className={styles.stageHead}>
            <div>
              <h2>{title}</h2>
              <p>{subtitle}</p>
            </div>
            {active === 'logs' && (
              <button
                type="button"
                aria-label="Refresh logs"
                className={cx(buttonCss.btn, buttonCss.ghost, styles.refreshBtn)}
                title="Refresh logs"
                onClick={() => void refreshLogs()}
                dangerouslySetInnerHTML={{ __html: `${RefreshIcon(13)}<span>Refresh</span>` }}
              />
            )}
            {active === 'automations' && (
              <button
                type="button"
                aria-label="Refresh automations"
                className={cx(buttonCss.btn, buttonCss.ghost, styles.refreshBtn)}
                title="Refresh automations"
                onClick={() => void refreshAutomations()}
                dangerouslySetInnerHTML={{ __html: `${RefreshIcon(13)}<span>Refresh</span>` }}
              />
            )}
          </div>
        )}

        {active === 'overview' ? (
          <Overview appId={appId} versionsCache={versionsCache} liveUrl={liveUrl} />
        ) : active === 'logs' ? (
          <Logs
            appId={appId}
            logsCache={logsCache}
            logsError={logsError}
            logsLevelFilter={logsLevelFilter}
            logsSearch={logsSearch}
            onLevel={setLogsLevelFilter}
            onSearch={setLogsSearch}
          />
        ) : active === 'automations' ? (
          <Automations
            appId={appId}
            automationsCache={automationsCache}
            automationsError={automationsError}
            runStates={runStates}
            onToggle={(row, next) => {
              void onToggleAutomation(row, next);
            }}
            onRun={(row) => {
              void onRunAutomation(row);
            }}
            onDelete={(row) => {
              void onDeleteAutomation(row);
            }}
          />
        ) : (
          <div className={styles.empty}>
            Not yet available. The backend for this section will land in a future release.
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview — hero strip (live URL) + status stat tiles + recent-activity feed.
function Overview({
  appId,
  versionsCache,
  liveUrl,
}: {
  appId: string;
  versionsCache: VersionsCache;
  liveUrl: string | undefined;
}): JSX.Element {
  if (!appId) return <div className={styles.empty}>No app yet.</div>;

  const ready =
    versionsCache !== undefined && versionsCache !== 'pending' && versionsCache !== 'error';
  const versionList = ready ? versionsCache.versions : [];
  const activeVersionId = ready ? versionsCache.activeVersion : undefined;
  const activeVersion =
    versionList.find((v) => v.current || v.versionId === activeVersionId) ?? versionList[0];

  const copyUrl = (url: string, msg: string): void => {
    void navigator.clipboard
      .writeText(url)
      .then(() => showToast(msg))
      .catch(() => showToast('Copy failed'));
  };

  const heroBtn = (glyph: string, label: string, onClick: () => void): JSX.Element => (
    <button
      className={styles.heroBtn}
      type="button"
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: `${glyph}<span>${label}</span>` }}
    />
  );

  const verLabel = activeVersion?.declaredVersion ? ` · V${activeVersion.declaredVersion}` : '';
  const whenLabel = activeVersion
    ? ` · PUBLISHED ${relativeWhen(activeVersion.uploadedAt).toUpperCase()}`
    : '';

  // Gateway reachability is derived from whether the versions fetch resolved.
  const anyOk = ready;
  const stillLoading = versionsCache === 'pending' || versionsCache === undefined;

  const ordered = ready
    ? [...versionsCache.versions].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
    : [];

  return (
    <>
      {/* Hero strip — the live deployment URL is the headline fact. */}
      <div className={styles.hero} data-live={String(!!liveUrl)}>
        <div
          className={styles.heroTile}
          data-status={liveUrl ? 'live' : 'off'}
          dangerouslySetInnerHTML={{ __html: iconSvg('Eye', 21) }}
        />
        {liveUrl ? (
          <>
            <div className={styles.heroMeta}>
              <div className={styles.heroEyebrow}>
                <span className={styles.heroDot} data-status="live" />
                <span>{`LIVE${verLabel}${whenLabel}`}</span>
              </div>
              <span className={styles.heroUrl}>{formatPreviewUrl(liveUrl)}</span>
            </div>
            <div className={styles.heroActions}>
              {heroBtn(iconSvg('Eye', 13), 'Open', () => {
                window.open(liveUrl, '_blank');
              })}
              {heroBtn(iconSvg('Copy', 13), 'Copy', () => copyUrl(liveUrl, 'Copied URL'))}
              {heroBtn(iconSvg('Share', 13), 'Share', () => copyUrl(liveUrl, 'Share link copied'))}
            </div>
          </>
        ) : (
          <div className={styles.heroMeta}>
            <div className={styles.heroEyebrow}>
              <span className={styles.heroDot} data-status="off" />
              <span>NOT DEPLOYED</span>
            </div>
            <span className={cx(styles.heroUrl, styles.heroUrlMuted)}>
              Publish to get a live URL
            </span>
          </div>
        )}
      </div>

      {/* Status — stat tiles (Versions · Gateway). */}
      <div className={styles.sectionLabel}>Status</div>
      <div className={styles.statGrid}>
        <div className={styles.statCard}>
          <div className={styles.statEyebrow}>
            <span>Versions</span>
          </div>
          {stillLoading ? (
            <div className={cx(styles.statValue, styles.statMuted)}>Loading…</div>
          ) : versionsCache === 'error' ? (
            <div className={cx(styles.statValue, styles.statMuted)}>—</div>
          ) : (
            <>
              <div className={styles.statValue}>{versionList.length}</div>
              <div className={styles.statSub}>
                {activeVersion
                  ? `active · ${activeVersion.uploadedAt.slice(0, 10)}`
                  : 'No active version'}
              </div>
            </>
          )}
        </div>

        <div className={styles.statCard}>
          <div className={styles.statEyebrow}>
            <span>Gateway</span>
          </div>
          {stillLoading && !anyOk ? (
            <div className={cx(styles.statValue, styles.statMuted)}>Checking…</div>
          ) : anyOk ? (
            <>
              <div className={cx(styles.statValue, styles.statMid, styles.statInline)}>
                <span className={styles.statusDot} data-status="live" />
                Reachable
              </div>
            </>
          ) : (
            <>
              <div className={cx(styles.statValue, styles.statMid, styles.statInline)}>
                <span className={styles.statusDot} data-status="off" />
                Unreachable
              </div>
              <div className={styles.statSub}>Check Settings → Gateway</div>
            </>
          )}
        </div>
      </div>

      {/* Recent activity — the version history as a deploy log. */}
      <div className={styles.sectionLabel}>Recent activity</div>
      <div className={styles.feed}>
        {stillLoading ? (
          <div className={styles.feedEmpty}>Loading activity…</div>
        ) : versionsCache === 'error' || versionList.length === 0 ? (
          <div className={styles.feedEmpty}>No activity yet — publish your app to deploy it.</div>
        ) : (
          ordered.map((v) => {
            const isActive = v.current || v.versionId === activeVersionId;
            return (
              <div className={styles.feedRow} key={v.versionId}>
                <div
                  className={styles.feedTile}
                  dangerouslySetInnerHTML={{ __html: iconSvg('Save', 14) }}
                />
                <div className={styles.feedTitleRow}>
                  <span className={styles.feedTitle}>
                    {v.declaredVersion ? `Published v${v.declaredVersion}` : 'Published'}
                  </span>
                  {isActive && <span className={styles.feedLive}>Active</span>}
                </div>
                <span className={styles.feedWhen}>{`Builder · ${relativeWhen(v.uploadedAt)}`}</span>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Logs — newest-first list with level chips + search. Polling lives in the
// parent effect; this renders the filtered snapshot.
function Logs({
  appId,
  logsCache,
  logsError,
  logsLevelFilter,
  logsSearch,
  onLevel,
  onSearch,
}: {
  appId: string;
  logsCache: LogsCache;
  logsError: string | undefined;
  logsLevelFilter: CentraidLogLevel | 'all';
  logsSearch: string;
  onLevel: (lvl: CentraidLogLevel | 'all') => void;
  onSearch: (v: string) => void;
}): JSX.Element {
  if (!appId) return <div className={styles.empty}>No app yet.</div>;

  const levels: Array<CentraidLogLevel | 'all'> = ['all', 'info', 'warn', 'error'];

  let body: JSX.Element;
  if (logsCache === 'pending' || logsCache === undefined) {
    body = <div className={cx(styles.empty, styles.emptyQuiet)}>Loading logs…</div>;
  } else if (logsCache === 'error') {
    body = (
      <div className={styles.empty}>
        Could not load logs.
        <br />
        <span className={styles.statSub}>{logsError ?? 'unknown error'}</span>
      </div>
    );
  } else {
    const needle = logsSearch.trim().toLowerCase();
    const filtered = logsCache.filter((entry) => {
      if (logsLevelFilter !== 'all' && entry.level !== logsLevelFilter) return false;
      if (!needle) return true;
      return (
        entry.msg.toLowerCase().includes(needle) ||
        entry.handler.toLowerCase().includes(needle) ||
        entry.source.toLowerCase().includes(needle)
      );
    });
    if (filtered.length === 0) {
      body = (
        <div className={cx(styles.empty, styles.emptyQuiet)}>
          {logsCache.length === 0
            ? 'No logs yet. Run a query or action to produce log lines.'
            : 'No logs match the current filter.'}
        </div>
      );
    } else {
      body = (
        <>
          {filtered.map((entry, i) => {
            const when = new Date(entry.ts);
            const ts = `${pad2(when.getHours())}:${pad2(when.getMinutes())}:${pad2(when.getSeconds())}`;
            return (
              <div className={styles.logsRow} data-level={entry.level} key={`${entry.ts}-${i}`}>
                <span className={styles.logsTs}>{ts}</span>
                <span className={styles.logsLevel}>{entry.level.toUpperCase()}</span>
                <span className={styles.logsSource}>{`${entry.source}/${entry.handler}`}</span>
                <span className={styles.logsMsg}>{entry.msg}</span>
              </div>
            );
          })}
        </>
      );
    }
  }

  return (
    <div className={styles.logs}>
      <div className={styles.logsFilter}>
        {levels.map((lvl) => (
          <button
            key={lvl}
            type="button"
            className={styles.logsChip}
            data-active={String(logsLevelFilter === lvl)}
            data-level={lvl}
            onClick={() => {
              if (logsLevelFilter !== lvl) onLevel(lvl);
            }}
          >
            {lvl === 'all' ? 'All' : lvl.charAt(0).toUpperCase() + lvl.slice(1)}
          </button>
        ))}
        <input
          className={styles.logsSearch}
          placeholder="Filter…"
          type="search"
          value={logsSearch}
          onChange={(e) => onSearch(e.target.value)}
        />
      </div>
      <div className={styles.logsList}>{body}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Automations — the per-app cron/webhook automation list with toggle, run-now,
// delete, and per-row run-result readback.
function Automations({
  appId,
  automationsCache,
  automationsError,
  runStates,
  onToggle,
  onRun,
  onDelete,
}: {
  appId: string;
  automationsCache: AutomationsCache;
  automationsError: string | undefined;
  runStates: Record<string, RunState>;
  onToggle: (row: CentraidAutomationRow, next: boolean) => void;
  onRun: (row: CentraidAutomationRow) => void;
  onDelete: (row: CentraidAutomationRow) => void;
}): JSX.Element {
  if (!appId) return <div className={styles.empty}>No app yet.</div>;

  if (automationsCache === undefined || automationsCache === 'pending') {
    return (
      <div className={styles.automations}>
        <div className={cx(styles.empty, styles.emptyQuiet)}>Loading automations…</div>
      </div>
    );
  }

  if (automationsCache === 'error') {
    return (
      <div className={styles.automations}>
        <div className={styles.empty}>
          Could not load automations.
          <br />
          <span className={styles.statSub}>{automationsError ?? 'unknown error'}</span>
        </div>
      </div>
    );
  }

  if (automationsCache.length === 0) {
    return (
      <div className={styles.automations}>
        <div className={styles.empty}>
          No automations yet.
          <br />
          <span className={styles.statSub}>
            Ask the builder to "set up an automation that runs every…" or drop a manifest into the
            app's <code>automations/</code> folder, then republish to deploy.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.automations}>
      {automationsCache.map((row) => (
        <AutomationRow
          key={row.ref}
          row={row}
          runState={runStates[row.name] ?? { kind: 'idle' }}
          onToggle={onToggle}
          onRun={onRun}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}

function AutomationRow({
  row,
  runState,
  onToggle,
  onRun,
  onDelete,
}: {
  row: CentraidAutomationRow;
  runState: RunState;
  onToggle: (row: CentraidAutomationRow, next: boolean) => void;
  onRun: (row: CentraidAutomationRow) => void;
  onDelete: (row: CentraidAutomationRow) => void;
}): JSX.Element {
  const cron =
    row.triggers.map((t) => (t.kind === 'cron' ? t.expr : 'webhook')).join(' · ') || 'manual';

  return (
    <div className={styles.automationRow} data-enabled={String(row.enabled)}>
      {/* Header: name + trigger expr + enabled toggle. */}
      <div className={styles.automationHead}>
        <div className={styles.automationTitle}>
          <span className={styles.automationName}>{row.name}</span>
          <span className={styles.automationCron} title="Triggers">
            {cron}
          </span>
        </div>
        <label className={styles.automationToggle}>
          <input
            type="checkbox"
            checked={row.enabled}
            onChange={(e) => onToggle(row, e.target.checked)}
          />
          <span className={styles.automationToggleText}>{row.enabled ? 'On' : 'Off'}</span>
        </label>
      </div>

      {/* Prompt body — the user's NL prompt verbatim. */}
      <div className={styles.automationPrompt}>{row.manifest.prompt}</div>

      {/* Metadata strip: automation id · model · generated-by. */}
      <div className={styles.automationMeta}>
        <span className={styles.automationMetaItem} title="Automation app id">
          {row.id}
        </span>
        {row.manifest.requires.model && (
          <span className={styles.automationMetaItem} title="Model used by ctx.agent calls">
            {row.manifest.requires.model}
          </span>
        )}
        <span className={cx(styles.automationMetaItem, styles.automationMetaFaint)}>
          {`by ${row.manifest.generated.by}`}
        </span>
      </div>

      {/* Actions: Run now · Delete · per-row run-result chip. */}
      <div className={styles.automationActions}>
        <button
          type="button"
          className={cx(buttonCss.btn, buttonCss.ghost)}
          disabled={runState.kind === 'running'}
          onClick={() => onRun(row)}
        >
          {runState.kind === 'running' ? 'Running…' : 'Run now'}
        </button>
        <button
          type="button"
          className={cx(buttonCss.btn, buttonCss.ghost)}
          onClick={() => onDelete(row)}
        >
          Delete
        </button>
        {runState.kind === 'done' && (
          <span className={styles.automationResult} data-ok={String(runState.ok)}>
            {runState.ok
              ? `OK in ${runState.durationMs}ms`
              : `FAILED in ${runState.durationMs}ms — ${runState.error ?? 'unknown error'}`}
          </span>
        )}
      </div>
    </div>
  );
}
