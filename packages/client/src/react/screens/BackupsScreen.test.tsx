import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BackupsScreen, { type BackupsScreenProps } from './BackupsScreen.js';

// The Backups page is a layout over two cards that each own their own fetch
// and their own loading/error state — the interesting behaviour lives in
// BackupCard.test.tsx / StorageCard.test.tsx. What's worth pinning here is
// the split itself: both cards mount on THIS page (they used to be children
// of the Gateway Overview grid), and each is wired to its own loader.

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
    loadStorageStatus: () => Promise.resolve({ connections: [], vaults: [] }),
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
  it('renders both cards, each wired to its own loader', async () => {
    const loadBackupStatus = vi.fn().mockResolvedValue({ configured: false, vaults: [] });
    const loadStorageStatus = vi.fn().mockResolvedValue({ connections: [], vaults: [] });
    const el = await mount({ loadBackupStatus, loadStorageStatus });

    expect(loadBackupStatus).toHaveBeenCalled();
    expect(loadStorageStatus).toHaveBeenCalled();

    const headings = [...el.querySelectorAll('h2')].map((h) => h.textContent);
    expect(headings).toContain('Backups');
    expect(headings).toContain('Storage');
  });

  it('renders the backup not-configured explainer and the recovery-kit gate', async () => {
    const el = await mount();
    expect(el.textContent).toContain('Backups aren’t set up yet');
    // The seal-key nudge is a permanent fixture, not gated on configured.
    expect(el.textContent).toContain('Save this recovery kit somewhere offline');
  });

  it('does not gate on a gateway heartbeat — it paints with no runtime snapshot', async () => {
    // Guards the deliberate difference from GatewayRoute: nothing on this page
    // consumes useGatewayRuntime(), so the cards must reach their own states
    // (here: the not-configured explainer) with no snapshot anywhere in scope.
    const el = await mount();
    expect(el.textContent).not.toContain('Listening for the gateway heartbeat');
    expect(el.querySelectorAll('h2').length).toBeGreaterThanOrEqual(2);
  });

  it('routes the Storage card’s Manage link to the settings handler', async () => {
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
