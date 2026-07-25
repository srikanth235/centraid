import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import StorageScreen, { type StorageScreenProps } from './StorageScreen.js';
import type { LocalUsageReportDTO } from '../../gateway-client-local-storage.js';

// The Storage page (issue #544) stacks three cards: the local footprint, the
// owner's limits, and the offsite Backups card that used to be the whole
// page. What's worth pinning here is that all three mount, each is wired to
// its own loader, none gates on a heartbeat, and a limit save round-trips
// through the gateway rather than being patched into local state.

const NOW = Date.UTC(2026, 6, 11, 12, 0, 0);

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.clearAllMocks();
});

const noop = (): void => {};
const noRunBackupNow = (): Promise<{ accepted: boolean }> => new Promise(() => {});
const noConfirmRecoveryKit = (): Promise<{ confirmedAt: number }> => new Promise(() => {});

const GB = 1024 ** 3;

function report(over: Partial<LocalUsageReportDTO> = {}): LocalUsageReportDTO {
  return {
    scannedAt: NOW,
    totalBytes: 3 * GB,
    components: [{ component: 'logs', bytes: 100 * 1024 ** 2, files: 4 }],
    vaults: [
      {
        vaultId: 'v1',
        name: 'Personal',
        bytes: 3 * GB - 100 * 1024 ** 2,
        components: [
          { component: 'attachments', bytes: 2 * GB, files: 900 },
          { component: 'ledger', bytes: GB - 100 * 1024 ** 2, files: null },
        ],
      },
    ],
    disk: { freeBytes: 120 * GB, totalBytes: 500 * GB },
    limits: { totalLimitBytes: null, warnAtPercent: 80, journalLimitBytes: null },
    limit: { status: 'ok', fractionUsed: null, usedBytes: 3 * GB, limitBytes: null },
    ...over,
  };
}

async function mount(over: Partial<StorageScreenProps> = {}): Promise<HTMLDivElement> {
  const props: StorageScreenProps = {
    now: NOW,
    loadLocalUsage: () => Promise.resolve(report()),
    saveStorageLimits: () =>
      Promise.resolve({ totalLimitBytes: null, warnAtPercent: 80, journalLimitBytes: null }),
    loadBackupStatus: () => Promise.resolve({ configured: false, vaults: [] }),
    onRunBackupNow: noRunBackupNow,
    onConfirmRecoveryKit: noConfirmRecoveryKit,
    onOpenStorageSettings: noop,
    ...over,
  };
  host = document.createElement('div');
  document.body.append(host);
  await act(async () => {
    root = createRoot(host as HTMLDivElement);
    root.render(<StorageScreen {...props} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return host;
}

describe('StorageScreen', () => {
  it('renders all three cards, each wired to its own loader', async () => {
    const loadBackupStatus = vi.fn().mockResolvedValue({ configured: false, vaults: [] });
    const loadLocalUsage = vi.fn().mockResolvedValue(report());
    const el = await mount({ loadBackupStatus, loadLocalUsage });

    expect(loadBackupStatus).toHaveBeenCalled();
    expect(loadLocalUsage).toHaveBeenCalled();
    const headings = [...el.querySelectorAll('h2')].map((h) => h.textContent);
    expect(headings).toContain('On this machine');
    expect(headings).toContain('Limits');
    expect(headings).toContain('Backups');
  });

  it('shows the footprint total and its component legend', async () => {
    const el = await mount();
    expect(el.textContent).toContain('3.0 GB');
    const legend = el.querySelector('[data-testid="footprint-legend"]')!;
    expect(legend.textContent).toContain('Attachments');
    expect(legend.textContent).toContain('Ledger');
    // Gateway-level components fold into the same legend as vault ones.
    expect(legend.textContent).toContain('Logs');
  });

  it('says plainly that an over-budget total blocks nothing', async () => {
    const el = await mount({
      loadLocalUsage: () =>
        Promise.resolve(
          report({
            limits: { totalLimitBytes: 2 * GB, warnAtPercent: 80, journalLimitBytes: null },
            limit: {
              status: 'error',
              fractionUsed: 1.5,
              usedBytes: 3 * GB,
              limitBytes: 2 * GB,
            },
          }),
        ),
    });
    expect(el.textContent).toContain('Nothing is being blocked');
  });

  it('round-trips a limit change through the gateway and re-reads the report', async () => {
    const saveStorageLimits = vi.fn().mockResolvedValue({
      totalLimitBytes: 30 * GB,
      warnAtPercent: 80,
      journalLimitBytes: null,
    });
    const loadLocalUsage = vi.fn().mockResolvedValue(report());
    const el = await mount({ saveStorageLimits, loadLocalUsage });

    const budget = el.querySelector('[data-testid="limit-control-budget"]')!;
    const preset = [...budget.querySelectorAll('button')].find(
      (b) => b.textContent === '30 GB',
    ) as HTMLButtonElement;
    expect(preset).toBeDefined();
    await act(async () => preset.click());
    await act(async () => {
      await Promise.resolve();
    });

    expect(saveStorageLimits).toHaveBeenCalledWith({ totalLimitBytes: 30 * GB });
    // The evaluation is the gateway's call, so the screen re-reads rather
    // than patching its cached report.
    expect(loadLocalUsage.mock.calls.length).toBeGreaterThan(1);
  });

  it('refuses an unparseable custom limit without calling the gateway', async () => {
    const saveStorageLimits = vi.fn();
    const el = await mount({ saveStorageLimits });

    const ledger = el.querySelector('[data-testid="limit-control-ledger"]')!;
    const input = ledger.querySelector('input') as HTMLInputElement;
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      nativeSetter.call(input, 'lots');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const set = [...ledger.querySelectorAll('button')].find(
      (b) => b.textContent === 'Set',
    ) as HTMLButtonElement;
    await act(async () => set.click());

    expect(saveStorageLimits).not.toHaveBeenCalled();
    expect(ledger.querySelector('[data-testid="limit-error-ledger"]')?.textContent).toContain(
      'Enter a size',
    );
  });

  it('pulls aggregate provider usage for the Cost metric when a loader is supplied', async () => {
    const loadStorageUsage = vi.fn().mockResolvedValue(null);
    await mount({
      loadBackupStatus: vi.fn().mockResolvedValue({ configured: true, vaults: [] }),
      loadStorageUsage,
    });
    expect(loadStorageUsage).toHaveBeenCalled();
  });

  it('renders the backup not-configured explainer and the recovery-kit gate', async () => {
    const el = await mount();
    expect(el.textContent).toContain('isn’t backed up offsite yet');
    // The seal-key nudge is a permanent fixture, not gated on configured.
    expect(el.textContent).toContain('Save this recovery kit somewhere offline');
  });

  it('does not gate on a gateway heartbeat — it paints with no runtime snapshot', async () => {
    const el = await mount();
    expect(el.textContent).not.toContain('Listening for the gateway heartbeat');
    expect(el.querySelectorAll('h2').length).toBeGreaterThanOrEqual(3);
  });

  it('routes the backup card’s Manage link to the settings handler', async () => {
    const onOpenStorageSettings = vi.fn();
    const el = await mount({ onOpenStorageSettings });
    const manage = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Manage'),
    ) as HTMLButtonElement;
    expect(manage).toBeDefined();
    await act(async () => manage.click());
    expect(onOpenStorageSettings).toHaveBeenCalled();
  });
});
