import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayRuntimeSnapshot } from '../shell/routes/gatewayData.js';
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

const noop = (): void => {};
const render = (snapshot: GatewayRuntimeSnapshot): string =>
  renderToStaticMarkup(
    <GatewayScreen
      snapshot={snapshot}
      now={NOW}
      onAlertSecondsChange={noop}
      onAlertsEnabledChange={noop}
    />,
  );

describe('GatewayScreen', () => {
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

  it('marks the active threshold preset and shows an off-ladder value as its own chip', () => {
    expect(render(base)).toContain('presetActive');
    const custom = render({ ...base, alert: { enabled: true, thresholdSeconds: 600 } });
    expect(custom).toContain('>10m<');
  });

  it('dims the threshold ladder when alerts are disabled', () => {
    const html = render({ ...base, alert: { enabled: false, thresholdSeconds: 120 } });
    expect(html).toContain('data-disabled');
    expect(html).toContain('aria-checked="false"');
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

  it('reports preset clicks and the toggle flip', async () => {
    const onSeconds = vi.fn();
    const onEnabled = vi.fn();
    await act(async () => {
      root.render(
        <GatewayScreen
          snapshot={base}
          now={NOW}
          onAlertSecondsChange={onSeconds}
          onAlertsEnabledChange={onEnabled}
        />,
      );
    });
    const fiveMin = [...host.querySelectorAll('button')].find((b) => b.textContent === '5m');
    await act(async () => fiveMin?.click());
    expect(onSeconds).toHaveBeenCalledWith(300);

    const toggle = host.querySelector<HTMLButtonElement>('[role="switch"]');
    await act(async () => toggle?.click());
    expect(onEnabled).toHaveBeenCalledWith(false);
  });
});
