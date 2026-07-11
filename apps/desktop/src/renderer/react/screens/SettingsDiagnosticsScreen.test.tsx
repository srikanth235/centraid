import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SettingsDiagnosticsScreen, {
  type GatewayHealthDTO,
  type SettingsDiagnosticsBridgeProps,
} from './SettingsDiagnosticsScreen.js';

function makeHealth(over: Partial<GatewayHealthDTO> = {}): GatewayHealthDTO {
  return {
    status: 'ok',
    startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    uptimeMs: 3 * 60 * 60 * 1000,
    components: [
      { component: 'vaults', status: 'ok', detail: '1 vault mounted', errorCount: 0 },
      {
        component: 'automations',
        status: 'ok',
        detail: 'scheduler running for 1 vault',
        errorCount: 0,
      },
      { component: 'outbox', status: 'ok', errorCount: 0 },
    ],
    recentEvents: [],
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

async function mount(props: SettingsDiagnosticsBridgeProps): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(<SettingsDiagnosticsScreen {...props} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

describe('SettingsDiagnosticsScreen', () => {
  it('renders the overall banner, component rows, and empty events state', async () => {
    const el = await mount({ loadHealth: vi.fn().mockResolvedValue(makeHealth()) });
    expect(el.textContent).toContain('All systems go');
    expect(el.textContent).toContain('Gateway up 3h 0m');
    const rows = el.querySelectorAll('[data-testid="diag-component"]');
    expect(rows.length).toBe(3);
    expect(el.textContent).toContain('Vaults');
    expect(el.textContent).toContain('1 vault mounted');
    expect(el.textContent).toContain('Automation scheduler');
    expect(el.textContent).toContain('Nothing logged since the gateway started.');
  });

  it('surfaces a failing component with its last error and the event tail', async () => {
    const health = makeHealth({
      status: 'error',
      components: [
        { component: 'vaults', status: 'ok', detail: '1 vault mounted', errorCount: 0 },
        {
          component: 'outbox',
          status: 'error',
          lastError: 'outbox drain failed: ECONNREFUSED',
          lastErrorAt: new Date().toISOString(),
          errorCount: 3,
        },
      ],
      recentEvents: [
        {
          at: new Date().toISOString(),
          component: 'outbox',
          level: 'error',
          message: 'outbox drain failed: ECONNREFUSED',
        },
      ],
    });
    const el = await mount({ loadHealth: vi.fn().mockResolvedValue(health) });
    expect(el.textContent).toContain('Something is failing');
    // The failing row leads with its actionable last error, not the detail.
    expect(el.textContent).toContain('outbox drain failed: ECONNREFUSED');
    expect(el.textContent).toContain('3 errs');
    expect(el.querySelectorAll('[data-testid="diag-event"]').length).toBe(1);
    const dot = el.querySelectorAll('[data-health="error"]');
    expect(dot.length).toBeGreaterThan(0);
  });

  it('re-fetches on Refresh', async () => {
    const loadHealth = vi.fn().mockResolvedValue(makeHealth());
    const el = await mount({ loadHealth });
    expect(loadHealth).toHaveBeenCalledTimes(1);
    const refreshBtn = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Refresh'),
    ) as HTMLButtonElement;
    await act(async () => refreshBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(loadHealth).toHaveBeenCalledTimes(2);
  });

  it('shows the load error when the gateway is unreachable', async () => {
    const el = await mount({ loadHealth: vi.fn().mockRejectedValue(new Error('fetch failed')) });
    expect(el.textContent).toContain('Couldn’t reach the gateway: fetch failed');
  });

  it('offers a "View in logs" jump on failing components, not healthy ones', async () => {
    const onJumpToLogs = vi.fn();
    const health = makeHealth({
      components: [
        { component: 'vaults', status: 'ok', errorCount: 0 },
        { component: 'outbox', status: 'error', errorCount: 2, lastError: 'ECONNREFUSED' },
      ],
    });
    const el = await mount({ loadHealth: vi.fn().mockResolvedValue(health), onJumpToLogs });
    const jumpButtons = [...el.querySelectorAll('button')].filter(
      (b) => b.textContent === 'View in logs',
    );
    expect(jumpButtons.length).toBe(1); // only the failing row offers it
    const jumpButton = jumpButtons[0]!;
    await act(async () => jumpButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onJumpToLogs).toHaveBeenCalledWith('outbox');
  });

  it('omits the jump link when no onJumpToLogs is wired (unchanged Settings-era behavior)', async () => {
    const health = makeHealth({
      components: [{ component: 'outbox', status: 'error', errorCount: 1 }],
    });
    const el = await mount({ loadHealth: vi.fn().mockResolvedValue(health) });
    expect([...el.querySelectorAll('button')].some((b) => b.textContent === 'View in logs')).toBe(
      false,
    );
  });
});
