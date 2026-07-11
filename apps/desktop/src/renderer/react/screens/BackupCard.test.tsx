import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BackupCard, { type BackupStatusDTO } from './BackupCard.js';

const NOW = Date.UTC(2026, 6, 11, 12, 0, 0);

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
  vi.useRealTimers();
});

async function mount(props: {
  loadStatus: () => Promise<BackupStatusDTO>;
  onRunNow: () => Promise<{ accepted: boolean; alreadyRunning?: boolean }>;
  now?: number;
}): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(
      <BackupCard now={props.now ?? NOW} loadStatus={props.loadStatus} onRunNow={props.onRunNow} />,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

const neverRun = (): Promise<{ accepted: boolean }> => new Promise(() => {});

describe('BackupCard — not configured', () => {
  it('renders an explainer and the permanent seal-key nudge, no "Back up now" button', async () => {
    const el = await mount({
      loadStatus: vi.fn().mockResolvedValue({ configured: false, vaults: [] }),
      onRunNow: neverRun,
    });
    expect(el.textContent).toContain('Backups aren’t set up for this gateway');
    expect(el.textContent).toContain('backup');
    expect(el.textContent).toContain('centraid-gateway backup kit');
    expect(el.textContent).toContain('store it offline');
    expect(
      [...el.querySelectorAll('button')].some((b) => b.textContent?.includes('Back up now')),
    ).toBe(false);
  });
});

describe('BackupCard — configured', () => {
  it('renders per-vault ages, flags a never-backed-up vault, and shows the seal-key nudge', async () => {
    const status: BackupStatusDTO = {
      configured: true,
      vaults: [
        {
          vaultId: 'v1',
          name: 'Main',
          lastBackupAt: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
          lastVerifyAt: new Date(NOW - 25 * 60 * 60 * 1000).toISOString(), // 1d 1h ago
        },
        { vaultId: 'v2', name: 'Side' }, // never backed up
      ],
    };
    const el = await mount({ loadStatus: vi.fn().mockResolvedValue(status), onRunNow: neverRun });
    expect(el.textContent).toContain('Main');
    expect(el.textContent).toContain('backed up 2h 00m ago');
    expect(el.textContent).toContain('verified 1d 1h ago');
    expect(el.textContent).toContain('Side');
    expect(el.textContent).toContain('backed up never');
    expect(el.textContent).toContain('centraid-gateway backup kit');
    const warn = el.querySelector('[data-emphasis="warn"]');
    expect(warn?.textContent).toContain('never');
  });

  it('surfaces a vault-level lastError without hiding the row', async () => {
    const status: BackupStatusDTO = {
      configured: true,
      vaults: [
        {
          vaultId: 'v1',
          name: 'Main',
          lastError: 'another machine has taken over this vault (conflict_generation)',
        },
      ],
    };
    const el = await mount({ loadStatus: vi.fn().mockResolvedValue(status), onRunNow: neverRun });
    expect(el.textContent).toContain('conflict_generation');
    expect(el.querySelectorAll('[data-testid="backup-vault-row"]').length).toBe(1);
  });

  it('shows a running badge for a vault mid-backup', async () => {
    const status: BackupStatusDTO = {
      configured: true,
      vaults: [{ vaultId: 'v1', name: 'Main', running: true }],
    };
    const el = await mount({ loadStatus: vi.fn().mockResolvedValue(status), onRunNow: neverRun });
    expect(el.textContent).toContain('backing up…');
  });

  it('"Back up now" POSTs the run and refreshes status afterward', async () => {
    const before: BackupStatusDTO = {
      configured: true,
      vaults: [{ vaultId: 'v1', name: 'Main' }],
    };
    const after: BackupStatusDTO = {
      configured: true,
      vaults: [{ vaultId: 'v1', name: 'Main', lastBackupAt: new Date(NOW).toISOString() }],
    };
    const loadStatus = vi.fn().mockResolvedValueOnce(before).mockResolvedValue(after);
    const onRunNow = vi.fn().mockResolvedValue({ accepted: true });
    const el = await mount({ loadStatus, onRunNow });

    expect(el.textContent).toContain('backed up never');
    const runBtn = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Back up now'),
    ) as HTMLButtonElement;
    expect(runBtn).toBeDefined();

    await act(async () => {
      runBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onRunNow).toHaveBeenCalledTimes(1);
    expect(loadStatus).toHaveBeenCalledTimes(2); // initial + post-run refresh
    expect(el.textContent).toContain('backed up ');
    expect(el.textContent).not.toContain('backed up never');
  });

  it('renders the run error inline without crashing the card', async () => {
    const status: BackupStatusDTO = { configured: true, vaults: [{ vaultId: 'v1', name: 'Main' }] };
    const loadStatus = vi.fn().mockResolvedValue(status);
    const onRunNow = vi.fn().mockRejectedValue(new Error('gateway unreachable'));
    const el = await mount({ loadStatus, onRunNow });

    const runBtn = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Back up now'),
    ) as HTMLButtonElement;
    await act(async () => {
      runBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(el.textContent).toContain('gateway unreachable');
  });

  it('shows a load error when the gateway is unreachable', async () => {
    const el = await mount({
      loadStatus: vi.fn().mockRejectedValue(new Error('fetch failed')),
      onRunNow: neverRun,
    });
    expect(el.textContent).toContain('Couldn’t reach the gateway: fetch failed');
  });
});
