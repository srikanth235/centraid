import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BackupsScreen, { type BackupsScreenProps } from './BackupsScreen.js';

// The Backups page is now a layout over the single BackupCard (the separate
// Storage card was cut in the §7 collapse — its store-class quota bars folded
// into the five-metric Cost readout). What's worth pinning here is that the
// card mounts, is wired to its own loader, and never gates on a heartbeat.

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

async function mount(over: Partial<BackupsScreenProps> = {}): Promise<HTMLDivElement> {
  const props: BackupsScreenProps = {
    now: NOW,
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
    root.render(<BackupsScreen {...props} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return host;
}

describe('BackupsScreen', () => {
  it('renders the Backups card, wired to its own loader', async () => {
    const loadBackupStatus = vi.fn().mockResolvedValue({ configured: false, vaults: [] });
    const el = await mount({ loadBackupStatus });

    expect(loadBackupStatus).toHaveBeenCalled();
    const headings = [...el.querySelectorAll('h2')].map((h) => h.textContent);
    expect(headings).toContain('Backups');
  });

  it('pulls aggregate usage for the Cost metric when a loader is supplied', async () => {
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
    expect(el.querySelectorAll('h2').length).toBeGreaterThanOrEqual(1);
  });

  it('routes the card’s Manage link to the settings handler', async () => {
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
