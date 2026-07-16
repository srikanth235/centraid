import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayRuntimeSnapshot } from '../shell/routes/gatewayData.js';
import type { GatewayHealthDTO } from './SettingsDiagnosticsScreen.js';
import GatewayScreen from './GatewayScreen.js';

const T0 = Date.UTC(2026, 6, 11, 12, 0, 0);
const NOW = T0 + 3_600_000; // one hour into the session

const base: GatewayRuntimeSnapshot = {
  gatewayId: 'local',
  gatewayLabel: 'Local',
  gatewayKind: 'local',
  trackingSince: T0,
  status: 'up',
  statusSince: T0,
  lastCheckAt: NOW - 2000,
  latencyMs: 3,
  gatewayStartedAt: T0 - 60_000,
  gatewayUptimeMs: NOW - 2000 - (T0 - 60_000),
  version: '0.1.0',
  schemaEpoch: 1,
  checksTotal: 720,
  checksFailed: 6,
  samples: [
    { at: NOW - 15_000, ok: true, latencyMs: 3 },
    { at: NOW - 10_000, ok: false },
    { at: NOW - 5000, ok: true, latencyMs: 4 },
  ],
  outages: [{ startedAt: NOW - 10_000, endedAt: NOW - 5000, alertedAt: NOW - 8000 }],
  alert: { enabled: true, thresholdSeconds: 120 },
  pollIntervalMs: 5000,
  alertHistory: [{ at: NOW - 5000, kind: 'recovered', durationMs: 5000, previousSession: false }],
};

function makeHealth(over: Partial<GatewayHealthDTO> = {}): GatewayHealthDTO {
  return {
    status: 'ok',
    startedAt: new Date(T0).toISOString(),
    uptimeMs: 3_600_000,
    components: [],
    recentEvents: [],
    ...over,
  };
}

const noop = (): void => {};
const noLoadHealth = (): Promise<GatewayHealthDTO> => Promise.resolve(makeHealth());
const noStreamLogs = (): Promise<void> => new Promise<void>(() => {}); // never resolves — no lines, "live" shell only
// Never-resolving stubs for the ops props (restart / export) — tests that
// don't exercise them just need the Overview render to be stable.
const noRestartGateway = (): Promise<{ ok: boolean; error?: string }> => new Promise(() => {});
const noExportDiagnostics = (): Promise<
  { ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }
> => new Promise(() => {});

// One spreadable bag of the never-resolving stubs — interaction tests
// override the handful of props they actually exercise.
const stubProps = {
  onAlertSecondsChange: noop,
  onAlertsEnabledChange: noop,
  health: null,
  loadHealth: noLoadHealth,
  streamLogs: noStreamLogs,
  onRestartGateway: noRestartGateway,
  onExportDiagnostics: noExportDiagnostics,
} as const;

const render = (snapshot: GatewayRuntimeSnapshot, health: GatewayHealthDTO | null = null): string =>
  renderToStaticMarkup(
    <GatewayScreen
      snapshot={snapshot}
      now={NOW}
      onAlertSecondsChange={noop}
      onAlertsEnabledChange={noop}
      health={health}
      loadHealth={noLoadHealth}
      streamLogs={noStreamLogs}
      onRestartGateway={noRestartGateway}
      onExportDiagnostics={noExportDiagnostics}
    />,
  );

describe('GatewayScreen — Overview tab (default)', () => {
  it('renders the operational hero with the gauge cluster', () => {
    const html = render(base);
    expect(html).toContain('<h1>Gateway</h1>');
    expect(html).toContain('Operational');
    expect(html).toContain('local gateway “Local”');
    expect(html).toContain('3 ms');
    expect(html).toContain('99.2%'); // (720-6)/720
    expect(html).toContain('720 checks this session');
    expect(html).toContain('data-status="up"');
    // Server uptime figure ticks forward from the last heartbeat.
    expect(html).toContain('1h 01m 00s');
  });

  it('renders the tab strip with Overview active', () => {
    const html = render(base);
    expect(html).toContain('role="tablist"');
    expect(html).toContain('Components');
    expect(html).toContain('Logs');
    expect(html).toContain('Alerts');
  });

  it('renders one heartbeat tick per sample, flagging failures', () => {
    const html = render(base);
    expect(html.split('data-ok="true"').length - 1).toBe(2);
    expect(html.split('data-ok="false"').length - 1).toBe(1);
  });

  it('renders the unreachable state with the failure detail and blanked gauges', () => {
    const html = render({
      ...base,
      status: 'down',
      statusSince: NOW - 30_000,
      lastError: 'fetch failed',
      outages: [...base.outages, { startedAt: NOW - 30_000 }],
    });
    expect(html).toContain('Unreachable');
    expect(html).toContain('data-status="down"');
    expect(html).toContain('fetch failed');
    expect(html).toContain('— ongoing');
    expect(html).not.toContain('1h 01m 00s'); // uptime blanks while down
  });

  it('shows the outage log with the notified badge, or the empty state', () => {
    expect(render(base)).toContain('notified');
    const html = render({ ...base, checksFailed: 0, outages: [] });
    expect(html).toContain('No downtime recorded this session');
  });

  it('reconciles a healthy heartbeat with a failing component into "Degraded"', () => {
    const html = render(base, makeHealth({ status: 'error' }));
    expect(html).toContain('Degraded');
    expect(html).toContain('data-status="degraded"');
    // Heartbeat itself is still up — the uptime figure keeps ticking.
    expect(html).toContain('1h 01m 00s');
  });

  it('lets the heartbeat win when the process is unreachable, even with healthy components', () => {
    const html = render({ ...base, status: 'down' }, makeHealth({ status: 'ok' }));
    expect(html).toContain('Unreachable');
    expect(html).toContain('data-status="down"');
  });
});

describe('GatewayScreen interactions', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const clickTab = async (label: string): Promise<void> => {
    const btn = [...host.querySelectorAll('[role="tab"]')].find((b) =>
      b.textContent?.startsWith(label),
    ) as HTMLButtonElement;
    await act(async () => btn.click());
  };

  it('shows the Components tab badge count from unhealthy components', async () => {
    await act(async () => {
      root.render(
        <GatewayScreen
          snapshot={base}
          now={NOW}
          onAlertSecondsChange={noop}
          onAlertsEnabledChange={noop}
          health={makeHealth({
            status: 'error',
            components: [
              { component: 'vaults', status: 'ok', errorCount: 0 },
              { component: 'connections', status: 'error', errorCount: 4 },
            ],
          })}
          loadHealth={noLoadHealth}
          streamLogs={noStreamLogs}
          onRestartGateway={noRestartGateway}
          onExportDiagnostics={noExportDiagnostics}
        />,
      );
    });
    const componentsTab = [...host.querySelectorAll('[role="tab"]')].find((b) =>
      b.textContent?.startsWith('Components'),
    );
    expect(componentsTab?.textContent).toContain('1');
  });

  it('moves the down-alert preset/switch controls under the Alerts tab', async () => {
    const onSeconds = vi.fn();
    const onEnabled = vi.fn();
    await act(async () => {
      root.render(
        <GatewayScreen
          snapshot={base}
          now={NOW}
          {...stubProps}
          onAlertSecondsChange={onSeconds}
          onAlertsEnabledChange={onEnabled}
        />,
      );
    });
    // Not visible on Overview.
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === '5m')).toBe(false);

    await clickTab('Alerts');
    const fiveMin = [...host.querySelectorAll('button')].find((b) => b.textContent === '5m');
    await act(async () => fiveMin?.click());
    expect(onSeconds).toHaveBeenCalledWith(300);

    const toggle = host.querySelector<HTMLButtonElement>('[role="switch"]');
    await act(async () => toggle?.click());
    expect(onEnabled).toHaveBeenCalledWith(false);

    // Panel rendering itself is covered by AlertHistoryPanel.test.tsx.
    expect(host.querySelector('[data-testid="alert-history-panel"]')).not.toBeNull();
  });

  it('switching to the Components tab mounts the diagnostics screen', async () => {
    const loadHealth = vi
      .fn()
      .mockResolvedValue(
        makeHealth({ components: [{ component: 'vaults', status: 'ok', errorCount: 0 }] }),
      );
    await act(async () => {
      root.render(
        <GatewayScreen snapshot={base} now={NOW} {...stubProps} loadHealth={loadHealth} />,
      );
    });
    await clickTab('Components');
    await act(async () => {
      await Promise.resolve();
    });
    expect(loadHealth).toHaveBeenCalled();
    expect(host.textContent).toContain('Vaults');
  });

  it('switching to the Logs tab mounts the log stream', async () => {
    await act(async () => {
      root.render(<GatewayScreen snapshot={base} now={NOW} {...stubProps} />);
    });
    await clickTab('Logs');
    expect(host.querySelector('input[type="search"]')).not.toBeNull();
    expect(host.textContent).toContain('No log lines yet');
  });

  it('jumps from a failing component straight into a focused Logs search', async () => {
    const loadHealth = vi.fn().mockResolvedValue(
      makeHealth({
        status: 'error',
        components: [
          {
            component: 'connections',
            status: 'error',
            lastError: 'ETIMEDOUT',
            errorCount: 4,
          },
        ],
      }),
    );
    await act(async () => {
      root.render(
        <GatewayScreen snapshot={base} now={NOW} {...stubProps} loadHealth={loadHealth} />,
      );
    });
    await clickTab('Components');
    await act(async () => {
      await Promise.resolve();
    });
    const jumpBtn = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'View in logs',
    ) as HTMLButtonElement;
    expect(jumpBtn).toBeDefined();
    await act(async () => jumpBtn.click());

    // Landed on the Logs tab, search box seeded with the component id.
    const search = host.querySelector<HTMLInputElement>('input[type="search"]');
    expect(search?.value).toBe('connections');
  });

  // Backup/Storage now live on their own page — see BackupsScreen.test.tsx.
  // This asserts the split held: the Gateway page must not re-grow them.
  it('no longer mounts the Backup or Storage cards', async () => {
    await act(async () => {
      root.render(<GatewayScreen snapshot={base} now={NOW} {...stubProps} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(host.textContent).not.toContain('Backups');
    expect(host.textContent).not.toContain('Save this recovery kit somewhere offline');
    expect(host.textContent).not.toContain('Storage');
  });

  it('restarts the gateway and clears back to idle on success', async () => {
    const onRestartGateway = vi.fn().mockResolvedValue({ ok: true });
    await act(async () => {
      root.render(
        <GatewayScreen
          snapshot={base}
          now={NOW}
          onAlertSecondsChange={noop}
          onAlertsEnabledChange={noop}
          health={null}
          loadHealth={noLoadHealth}
          streamLogs={noStreamLogs}
          onRestartGateway={onRestartGateway}
          onExportDiagnostics={noExportDiagnostics}
        />,
      );
    });
    const restartBtn = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Restart gateway'),
    ) as HTMLButtonElement;
    expect(restartBtn).toBeDefined();
    await act(async () => {
      restartBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onRestartGateway).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Restart gateway'); // back to idle label
  });

  it('surfaces a refused restart (remote gateway) inline without throwing', async () => {
    const onRestartGateway = vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'restart is only available for a local gateway' });
    await act(async () => {
      root.render(
        <GatewayScreen
          snapshot={base}
          now={NOW}
          onAlertSecondsChange={noop}
          onAlertsEnabledChange={noop}
          health={null}
          loadHealth={noLoadHealth}
          streamLogs={noStreamLogs}
          onRestartGateway={onRestartGateway}
          onExportDiagnostics={noExportDiagnostics}
        />,
      );
    });
    const restartBtn = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Restart gateway'),
    ) as HTMLButtonElement;
    await act(async () => {
      restartBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).toContain('restart is only available for a local gateway');
  });

  it('exports diagnostics from the Logs tab toolbar and shows the saved path', async () => {
    const onExportDiagnostics = vi.fn().mockResolvedValue({ ok: true, path: '/tmp/diag.json' });
    await act(async () => {
      root.render(
        <GatewayScreen
          snapshot={base}
          now={NOW}
          onAlertSecondsChange={noop}
          onAlertsEnabledChange={noop}
          health={null}
          loadHealth={noLoadHealth}
          streamLogs={noStreamLogs}
          onRestartGateway={noRestartGateway}
          onExportDiagnostics={onExportDiagnostics}
        />,
      );
    });
    await clickTab('Logs');
    const exportBtn = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Export diagnostics'),
    ) as HTMLButtonElement;
    expect(exportBtn).toBeDefined();
    await act(async () => {
      exportBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onExportDiagnostics).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('/tmp/diag.json');
  });

  it('shows nothing extra when the export dialog is canceled, and surfaces a real failure inline', async () => {
    const onExportDiagnostics = vi.fn().mockResolvedValue({ ok: false, canceled: true });
    await act(async () => {
      root.render(
        <GatewayScreen
          snapshot={base}
          now={NOW}
          onAlertSecondsChange={noop}
          onAlertsEnabledChange={noop}
          health={null}
          loadHealth={noLoadHealth}
          streamLogs={noStreamLogs}
          onRestartGateway={noRestartGateway}
          onExportDiagnostics={onExportDiagnostics}
        />,
      );
    });
    await clickTab('Logs');
    const exportBtn = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Export diagnostics'),
    ) as HTMLButtonElement;
    await act(async () => {
      exportBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.textContent).not.toContain('Saved to');
    expect(exportBtn.textContent).toContain('Export diagnostics'); // back to idle label
  });
});
