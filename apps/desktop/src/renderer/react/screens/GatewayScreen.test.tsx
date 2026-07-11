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
          onAlertSecondsChange={onSeconds}
          onAlertsEnabledChange={onEnabled}
          health={null}
          loadHealth={noLoadHealth}
          streamLogs={noStreamLogs}
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
  });

  it('switching to the Components tab mounts the diagnostics screen', async () => {
    const loadHealth = vi
      .fn()
      .mockResolvedValue(
        makeHealth({ components: [{ component: 'vaults', status: 'ok', errorCount: 0 }] }),
      );
    await act(async () => {
      root.render(
        <GatewayScreen
          snapshot={base}
          now={NOW}
          onAlertSecondsChange={noop}
          onAlertsEnabledChange={noop}
          health={null}
          loadHealth={loadHealth}
          streamLogs={noStreamLogs}
        />,
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
      root.render(
        <GatewayScreen
          snapshot={base}
          now={NOW}
          onAlertSecondsChange={noop}
          onAlertsEnabledChange={noop}
          health={null}
          loadHealth={noLoadHealth}
          streamLogs={noStreamLogs}
        />,
      );
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
        <GatewayScreen
          snapshot={base}
          now={NOW}
          onAlertSecondsChange={noop}
          onAlertsEnabledChange={noop}
          health={null}
          loadHealth={loadHealth}
          streamLogs={noStreamLogs}
        />,
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
});
