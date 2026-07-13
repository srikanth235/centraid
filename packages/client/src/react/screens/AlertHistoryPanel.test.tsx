import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GatewayRuntimeSnapshot } from '../shell/routes/gatewayData.js';
import { buildAlertHistoryRows } from '../shell/routes/gatewayData.js';
import AlertHistoryPanel from './AlertHistoryPanel.js';

const T0 = Date.UTC(2026, 6, 11, 12, 0, 0);
const NOW = T0 + 3_600_000;

// Only the fields buildAlertHistoryRows reads matter here.
const snapshot = {
  alertHistory: [
    { at: T0 - 3_600_000, kind: 'down', detail: 'fetch failed', previousSession: true },
    { at: NOW - 5000, kind: 'recovered', durationMs: 5000, previousSession: false },
  ],
} as GatewayRuntimeSnapshot;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('AlertHistoryPanel', () => {
  it('renders persisted entries newest-first, marking earlier-session ones', async () => {
    await act(async () => {
      root.render(<AlertHistoryPanel rows={buildAlertHistoryRows(snapshot)} />);
    });
    expect(host.textContent).toContain('Alert history');
    expect(host.textContent).toContain('Recovered');
    expect(host.textContent).toContain('Gateway down');
    expect(host.textContent).toContain('fetch failed');
    expect(host.textContent).toContain('earlier session');
    // Newest first — "Recovered" (current session) renders before "Gateway down" (earlier).
    const recoveredIdx = host.textContent?.indexOf('Recovered') ?? -1;
    const downIdx = host.textContent?.indexOf('Gateway down') ?? -1;
    expect(recoveredIdx).toBeGreaterThanOrEqual(0);
    expect(downIdx).toBeGreaterThan(recoveredIdx);
    expect(host.querySelectorAll('[data-testid="alert-history-row"]').length).toBe(2);
  });

  it('shows the empty state when no history has landed yet', async () => {
    await act(async () => {
      root.render(<AlertHistoryPanel rows={[]} />);
    });
    expect(host.textContent).toContain('No alerts recorded yet');
  });
});
