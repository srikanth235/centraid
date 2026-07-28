// governance: allow-repo-hygiene file-size-limit (#436) one suite per screen — the five-metric surface, diagnostics disclosure, recovery-kit gate, and policy/inventory cases all exercise the single BackupCard contract and share its render/bridge fixtures
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UsageInput } from '../../storage-metrics.js';
import BackupCard, { type BackupCardProps, type BackupStatusDTO } from './BackupCard.js';
import type { BackupReconciliationDTO } from './BackupInventoryPanel.js';
import type { BackupPolicyDTO, BackupPolicyPatchDTO } from './BackupPolicyPanel.js';

const NOW = Date.UTC(2026, 6, 11, 12, 0, 0);

let root: Root | null = null;
let container: HTMLDivElement | null = null;
describe('screens/BackupCard', () => {
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
    loadUsage?: () => Promise<UsageInput | null>;
    streamCustody?: (onChange: () => void, signal: AbortSignal) => Promise<void>;
    onRunNow: () => Promise<{ accepted: boolean; alreadyRunning?: boolean }>;
    onConfirmRecoveryKit?: (input: {
      kit: unknown;
      password: string;
      lossConsent: true;
    }) => Promise<{ confirmedAt: number }>;
    onExportRecoveryKit?: (input: {
      password: string;
    }) => Promise<{ ok: boolean; canceled?: boolean; error?: string }>;
    onUpdatePolicy?: (
      vaultId: string,
      patch: BackupPolicyPatchDTO,
    ) => Promise<{ policy: BackupPolicyDTO }>;
    onVerifyBucket?: (
      vaultId: string,
    ) => Promise<{ vaultId: string; reconciliation: BackupReconciliationDTO }>;
    now?: number;
  }): Promise<HTMLDivElement> {
    container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container as HTMLDivElement);
      root.render(
        <BackupCard
          now={props.now ?? NOW}
          loadStatus={props.loadStatus}
          loadUsage={props.loadUsage}
          streamCustody={props.streamCustody}
          onRunNow={props.onRunNow}
          onConfirmRecoveryKit={props.onConfirmRecoveryKit ?? neverConfirmKit}
          onExportRecoveryKit={props.onExportRecoveryKit}
          onUpdatePolicy={props.onUpdatePolicy}
          onVerifyBucket={props.onVerifyBucket}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    return container;
  }

  const neverRun = (): Promise<{ accepted: boolean }> => new Promise(() => {});
  const neverConfirmKit = (): Promise<{ confirmedAt: number }> => new Promise(() => {});

  function setInputValue(input: HTMLInputElement, value: string): void {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function selectRecoveryKit(el: HTMLDivElement, kit: unknown): Promise<void> {
    const fileInput = el.querySelector('input[type="file"]') as HTMLInputElement;
    const contents = JSON.stringify(kit);
    const file = new File([contents], 'centraid-recovery-kit.json', {
      type: 'application/json',
    });
    Object.defineProperty(file, 'text', { value: async () => contents });
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: [file],
    });
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  }

  const POLICY: BackupPolicyDTO = {
    rpoSeconds: 60,
    snapshotIntervalHours: 24,
    verifyEveryDays: 7,
    outboxBudgetBytes: 512 * 1024 ** 2,
    reservedHeadroomBytes: 256 * 1024 ** 2,
    walBaseRollBytes: 16 * 1024 ** 2,
    walBaseRollHours: 24,
  };

  describe('BackupCard — not configured', () => {
    it('renders an explainer and the permanent recovery-kit nudge, no action buttons', async () => {
      const el = await mount({
        loadStatus: vi
          .fn<BackupCardProps['loadStatus']>()
          .mockResolvedValue({ configured: false, vaults: [] }),
        onRunNow: neverRun,
      });
      expect(el.textContent).toContain('isn’t backed up offsite yet');
      expect(el.textContent).toContain('Settings → Storage');
      expect(el.textContent).toContain('somewhere offline');
      expect(
        [...el.querySelectorAll('button')].some((b) => b.textContent?.includes('Back up now')),
      ).toBe(false);
      // Not configured means there's no keyring to have exported a kit
      // from yet — the confirm button (which would 409) is withheld.
      expect(
        [...el.querySelectorAll('button')].some((b) =>
          b.textContent?.includes("I've saved my recovery kit"),
        ),
      ).toBe(false);
    });
  });

  describe('BackupCard — configured', () => {
    it('treats a custody SSE transition as an immediate status completion edge', async () => {
      let emit!: () => void;
      const streamCustody = vi.fn<NonNullable<BackupCardProps['streamCustody']>>(
        (onChange, signal) => {
          emit = onChange;
          return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
        },
      );
      const loadStatus = vi.fn<BackupCardProps['loadStatus']>().mockResolvedValue({
        configured: true,
        vaults: [
          {
            vaultId: 'v1',
            name: 'Main',
            pendingOffsite: { count: 1, bytes: 9 },
          },
        ],
      });
      await mount({ loadStatus, streamCustody, onRunNow: neverRun });

      await act(async () => {
        emit();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(streamCustody).toHaveBeenCalledOnce();
      expect(loadStatus).toHaveBeenCalledTimes(2);
    });

    it('answers custody questions and persists an RPO preset inline', async () => {
      const onUpdatePolicy = vi
        .fn<NonNullable<BackupCardProps['onUpdatePolicy']>>()
        .mockResolvedValue({
          policy: { ...POLICY, rpoSeconds: 900 },
        });
      const status: BackupStatusDTO = {
        configured: true,
        provider: 'Clawgnition',
        vaults: [
          {
            vaultId: 'v1',
            name: 'Main',
            policy: POLICY,
            destination: { kind: 'provider', connectionId: 'provider-1' },
            pendingOffsite: { count: 2, bytes: 5 * 1024 ** 2 },
          },
        ],
      };
      const el = await mount({
        loadStatus: vi.fn<BackupCardProps['loadStatus']>().mockResolvedValue(status),
        onRunNow: neverRun,
        onUpdatePolicy,
      });
      expect(el.textContent).toContain('Where do backups go?');
      expect(el.textContent).toContain('Provider · Clawgnition');
      expect(el.textContent).toContain('2 pending · 5.0 MB waiting offsite');
      const rpo = [...el.querySelectorAll('label')]
        .find((label) => label.textContent?.includes('Recovery point'))
        ?.querySelector('select') as HTMLSelectElement;
      await act(async () => {
        rpo.value = '900';
        rpo.dispatchEvent(new Event('change', { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(onUpdatePolicy).toHaveBeenCalledWith('v1', { rpoSeconds: 900 });
      expect(el.textContent).toContain('Policy saved');
    });

    it('shows provider-attested holdings, lifecycle history, and verifies them against the bucket', async () => {
      const reconciliation: BackupReconciliationDTO = {
        checkedAt: new Date(NOW - 60_000).toISOString(),
        mode: 'scheduled',
        status: 'ok',
        backup: {
          configured: true,
          source: 'provider',
          providerAttested: true,
          objectCount: 9,
          bytes: 20 * 1024 ** 2,
          softDeletedCount: 0,
          missing: { count: 0, sample: [] },
          orphans: { count: 0, sample: [] },
        },
        cas: {
          configured: true,
          source: 'provider',
          providerAttested: true,
          objectCount: 42,
          bytes: 800 * 1024 ** 2,
          softDeletedCount: 0,
          missing: { count: 0, sample: [] },
          orphans: { count: 0, sample: [] },
        },
        walGaps: { count: 0, sample: [] },
        snapshots: {
          live: 2,
          pruned: 1,
          recent: [
            {
              seq: 8,
              totalBytes: 12 * 1024 ** 2,
              objectCount: 4,
              createdAt: Math.floor(NOW / 1000),
              prunedAt: null,
              format: 'centraid-snapshot/1',
            },
          ],
        },
        walCoverage: {
          earliestTickMs: NOW - 6.5 * 24 * 60 * 60 * 1000,
          latestTickMs: NOW,
          spanDays: 6.5,
          segmentCount: 31,
          markerCount: 7,
        },
        audit: {
          source: 'provider',
          eventCount: 3,
          recent: [
            {
              at: Math.floor(NOW / 1000),
              kind: 'prune',
              detail: { retentionRung: 'daily' },
            },
          ],
        },
      };
      const bucketResult: BackupReconciliationDTO = {
        ...reconciliation,
        mode: 'bucket',
        backup: {
          ...reconciliation.backup,
          source: 'bucket',
          providerAttested: false,
        },
        cas: {
          ...reconciliation.cas,
          source: 'bucket',
          providerAttested: false,
        },
      };
      const onVerifyBucket = vi
        .fn<NonNullable<BackupCardProps['onVerifyBucket']>>()
        .mockResolvedValue({
          vaultId: 'v1',
          reconciliation: bucketResult,
        });
      const el = await mount({
        loadStatus: vi.fn<BackupCardProps['loadStatus']>().mockResolvedValue({
          configured: true,
          provider: 'Clawgnition',
          vaults: [
            {
              vaultId: 'v1',
              name: 'Main',
              // Snapshot backup is remote while the active CAS remains local.
              // Inventory must not disappear merely because the two stores use
              // different destinations.
              destination: { kind: 'gateway-local' },
              reconciliation,
            },
          ],
        }),
        onRunNow: neverRun,
        onVerifyBucket,
      });
      expect(el.textContent).toContain('What does your provider hold?');
      expect(el.textContent).toContain('42 objects · 800.0 MB');
      expect(el.textContent).toContain('Provider-attested');
      expect(el.textContent).toContain('6.5 days · 31 segments');
      expect(el.textContent).toContain('Retention rung: daily');

      const verify = [...el.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Verify against bucket'),
      ) as HTMLButtonElement;
      await act(async () => {
        verify.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(onVerifyBucket).toHaveBeenCalledWith('v1');
      expect(el.textContent).toContain('Computed from bucket listing');
      expect(el.textContent).toContain('raw bucket check');
    });

    it('renders per-vault ages, flags a never-backed-up vault, and states recovery scope', async () => {
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
      const el = await mount({
        loadStatus: vi.fn<BackupCardProps['loadStatus']>().mockResolvedValue(status),
        onRunNow: neverRun,
      });
      expect(el.textContent).toContain('Main');
      expect(el.textContent).toContain('backed up 2h 00m ago');
      expect(el.textContent).toContain('verified 1d 1h ago');
      expect(el.textContent).toContain('Side');
      expect(el.textContent).toContain('backed up never');
      expect(el.textContent).toContain('unlocks backed-up vaults');
      expect(el.textContent).toContain('local-only vaults are not included');
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
      const el = await mount({
        loadStatus: vi.fn<BackupCardProps['loadStatus']>().mockResolvedValue(status),
        onRunNow: neverRun,
      });
      expect(el.textContent).toContain('conflict_generation');
      expect(el.querySelectorAll('[data-testid="backup-vault-row"]')).toHaveLength(1);
    });

    it('shows a running badge for a vault mid-backup', async () => {
      const status: BackupStatusDTO = {
        configured: true,
        vaults: [{ vaultId: 'v1', name: 'Main', running: true }],
      };
      const el = await mount({
        loadStatus: vi.fn<BackupCardProps['loadStatus']>().mockResolvedValue(status),
        onRunNow: neverRun,
      });
      expect(el.textContent).toContain('backing up…');
    });

    it('"Back up now" POSTs the run and refreshes status afterward', async () => {
      const before: BackupStatusDTO = {
        configured: true,
        vaults: [{ vaultId: 'v1', name: 'Main' }],
      };
      const after: BackupStatusDTO = {
        configured: true,
        vaults: [
          {
            vaultId: 'v1',
            name: 'Main',
            lastBackupAt: new Date(NOW).toISOString(),
          },
        ],
      };
      const loadStatus = vi
        .fn<BackupCardProps['loadStatus']>()
        .mockResolvedValueOnce(before)
        .mockResolvedValue(after);
      const onRunNow = vi.fn<BackupCardProps['onRunNow']>().mockResolvedValue({ accepted: true });
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

      expect(onRunNow).toHaveBeenCalledOnce();
      expect(loadStatus).toHaveBeenCalledTimes(2); // initial + post-run refresh
      expect(el.textContent).toContain('backed up ');
      expect(el.textContent).not.toContain('backed up never');
    });

    it('renders the run error inline without crashing the card', async () => {
      const status: BackupStatusDTO = {
        configured: true,
        vaults: [{ vaultId: 'v1', name: 'Main' }],
      };
      const loadStatus = vi.fn<BackupCardProps['loadStatus']>().mockResolvedValue(status);
      const onRunNow = vi
        .fn<BackupCardProps['onRunNow']>()
        .mockRejectedValue(new Error('gateway unreachable'));
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
        loadStatus: vi
          .fn<BackupCardProps['loadStatus']>()
          .mockRejectedValue(new Error('fetch failed')),
        onRunNow: neverRun,
      });
      expect(el.textContent).toContain('Couldn’t reach the gateway: fetch failed');
    });
  });

  describe('BackupCard — recovery-kit gate', () => {
    it('requires a password before a configured gateway can export its wrapped kit', async () => {
      const status: BackupStatusDTO = {
        configured: true,
        vaults: [{ vaultId: 'v1', name: 'Main' }],
        recoveryKit: { confirmedAt: null },
      };
      const el = await mount({
        loadStatus: vi.fn<BackupCardProps['loadStatus']>().mockResolvedValue(status),
        onRunNow: neverRun,
      });
      expect(el.querySelector('[data-testid="recovery-kit-gate"]')).not.toBeNull();
      expect(el.querySelector('[data-testid="recovery-kit-confirmed"]')).toBeNull();
      expect(el.textContent).toContain('Recovery-kit password');
      const exportButton = [...el.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Export wrapped recovery kit'),
      ) as HTMLButtonElement;
      expect(exportButton).toBeDefined();
      expect(exportButton.disabled).toBe(true);
    });

    it('renders the quiet confirmed state with the date when already confirmed', async () => {
      const confirmedAt = Math.floor(NOW / 1000);
      const status: BackupStatusDTO = {
        configured: true,
        vaults: [{ vaultId: 'v1', name: 'Main' }],
        recoveryKit: { confirmedAt },
      };
      const el = await mount({
        loadStatus: vi.fn<BackupCardProps['loadStatus']>().mockResolvedValue(status),
        onRunNow: neverRun,
      });
      const confirmed = el.querySelector('[data-testid="recovery-kit-confirmed"]');
      expect(confirmed).not.toBeNull();
      expect(confirmed?.textContent).toContain('Recovery kit confirmed');
      expect(el.querySelector('[data-testid="recovery-kit-gate"]')).toBeNull();
      expect(
        [...el.querySelectorAll('button')].some((b) =>
          b.textContent?.includes("I've saved my recovery kit"),
        ),
      ).toBe(false);
    });

    it('verifies the re-selected wrapped kit and flips to the confirmed state', async () => {
      const status: BackupStatusDTO = {
        configured: true,
        vaults: [{ vaultId: 'v1', name: 'Main' }],
        recoveryKit: { confirmedAt: null },
      };
      const confirmedAt = Math.floor(NOW / 1000);
      const onConfirmRecoveryKit = vi
        .fn<BackupCardProps['onConfirmRecoveryKit']>()
        .mockResolvedValue({ confirmedAt });
      const onExportRecoveryKit = vi
        .fn<NonNullable<BackupCardProps['onExportRecoveryKit']>>()
        .mockResolvedValue({ ok: true });
      const el = await mount({
        loadStatus: vi.fn<BackupCardProps['loadStatus']>().mockResolvedValue(status),
        onRunNow: neverRun,
        onConfirmRecoveryKit,
        onExportRecoveryKit,
      });

      const password = el.querySelector('input[type="password"]') as HTMLInputElement;
      await act(async () => {
        setInputValue(password, 'correct horse');
        const exportButton = [...el.querySelectorAll('button')].find((button) =>
          button.textContent?.includes('Export wrapped recovery kit'),
        ) as HTMLButtonElement;
        exportButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => selectRecoveryKit(el, { format: 'centraid-recovery-kit/2' }));
      const consent = el.querySelector('input[type="checkbox"]') as HTMLInputElement;
      const verifyButton = [...el.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Verify selected recovery kit'),
      ) as HTMLButtonElement;
      await act(async () => {
        consent.click();
        verifyButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(onExportRecoveryKit).toHaveBeenCalledWith({
        password: 'correct horse',
      });
      expect(onConfirmRecoveryKit).toHaveBeenCalledWith({
        kit: { format: 'centraid-recovery-kit/2' },
        password: 'correct horse',
        lossConsent: true,
      });
      expect(el.querySelector('[data-testid="recovery-kit-confirmed"]')).not.toBeNull();
      expect(el.querySelector('[data-testid="recovery-kit-gate"]')).toBeNull();
    });

    it('exports through the native save flow before offering verification', async () => {
      const status: BackupStatusDTO = {
        configured: true,
        vaults: [{ vaultId: 'v1', name: 'Main' }],
        recoveryKit: { confirmedAt: null },
      };
      const onExportRecoveryKit = vi
        .fn<NonNullable<BackupCardProps['onExportRecoveryKit']>>()
        .mockResolvedValue({ ok: true });
      const onConfirmRecoveryKit = vi
        .fn<BackupCardProps['onConfirmRecoveryKit']>()
        .mockResolvedValue({ confirmedAt: Math.floor(NOW / 1000) });
      const el = await mount({
        loadStatus: vi.fn<BackupCardProps['loadStatus']>().mockResolvedValue(status),
        onRunNow: neverRun,
        onExportRecoveryKit,
        onConfirmRecoveryKit,
      });
      const password = el.querySelector('input[type="password"]') as HTMLInputElement;
      const exportBtn = [...el.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Export wrapped recovery kit'),
      ) as HTMLButtonElement;
      await act(async () => {
        setInputValue(password, 'correct horse');
        exportBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(onExportRecoveryKit).toHaveBeenCalledWith({
        password: 'correct horse',
      });
      expect(onConfirmRecoveryKit).not.toHaveBeenCalled();
      expect(el.textContent).toContain('Re-select the saved file');
    });

    it('surfaces a verification failure inline without crashing the card', async () => {
      const status: BackupStatusDTO = {
        configured: true,
        vaults: [{ vaultId: 'v1', name: 'Main' }],
        recoveryKit: { confirmedAt: null },
      };
      const onConfirmRecoveryKit = vi
        .fn<BackupCardProps['onConfirmRecoveryKit']>()
        .mockRejectedValue(new Error('gateway unreachable'));
      const onExportRecoveryKit = vi
        .fn<NonNullable<BackupCardProps['onExportRecoveryKit']>>()
        .mockResolvedValue({ ok: true });
      const el = await mount({
        loadStatus: vi.fn<BackupCardProps['loadStatus']>().mockResolvedValue(status),
        onRunNow: neverRun,
        onConfirmRecoveryKit,
        onExportRecoveryKit,
      });

      const password = el.querySelector('input[type="password"]') as HTMLInputElement;
      await act(async () => {
        setInputValue(password, 'correct horse');
        const exportButton = [...el.querySelectorAll('button')].find((button) =>
          button.textContent?.includes('Export wrapped recovery kit'),
        ) as HTMLButtonElement;
        exportButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => selectRecoveryKit(el, { format: 'centraid-recovery-kit/2' }));
      const consent = el.querySelector('input[type="checkbox"]') as HTMLInputElement;
      const verifyButton = [...el.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Verify selected recovery kit'),
      ) as HTMLButtonElement;
      await act(async () => {
        consent.click();
        verifyButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(el.textContent).toContain('gateway unreachable');
      // Still gated — the failed verification didn't flip the state.
      expect(el.querySelector('[data-testid="recovery-kit-gate"]')).not.toBeNull();
    });

    it('treats a missing recoveryKit field as unconfirmed (pre-wave-4 fixture)', async () => {
      const status = {
        configured: true,
        vaults: [{ vaultId: 'v1', name: 'Main' }],
      } as BackupStatusDTO;
      const el = await mount({
        loadStatus: vi.fn<BackupCardProps['loadStatus']>().mockResolvedValue(status),
        onRunNow: neverRun,
      });
      expect(el.querySelector('[data-testid="recovery-kit-gate"]')).not.toBeNull();
    });
  });

  describe('BackupCard — five-metric surface (§6)', () => {
    const freshStatus: BackupStatusDTO = {
      configured: true,
      provider: 'Clawgnition',
      vaults: [
        {
          vaultId: 'v1',
          name: 'Main',
          policy: POLICY,
          destination: { kind: 'provider', connectionId: 'p1' },
          // All four clocks recent so freshness reads green.
          lastBackupAt: new Date(NOW - 60_000).toISOString(),
          lastVerifyAt: new Date(NOW - 60_000).toISOString(),
          lastWalDrainAt: new Date(NOW - 60_000).toISOString(),
          pendingOffsite: { count: 0, bytes: 0 },
        },
      ],
      recoveryKit: { confirmedAt: Math.floor(NOW / 1000) },
      home: {
        retention: {
          kind: 'ladder',
          keepAllDays: 7,
          dailyDays: 30,
          weeklyDays: 90,
        },
        restoreCostClass: 'metered-egress',
      },
    };

    it('renders exactly the five metrics, sourced from the DTOs', async () => {
      const el = await mount({
        loadStatus: vi.fn<BackupCardProps['loadStatus']>().mockResolvedValue(freshStatus),
        loadUsage: vi.fn<NonNullable<BackupCardProps['loadUsage']>>().mockResolvedValue({
          backup: { bytesStored: 2 * 1024 ** 3, quotaBytes: 10 * 1024 ** 3 },
        }),
        onRunNow: neverRun,
      });

      // Freshness — green "everything safe as of T".
      const freshness = el.querySelector('[data-testid="metric-freshness"]');
      expect(freshness?.textContent).toContain('Everything safe as of');
      expect(freshness?.querySelector('[data-tone="ok"]')).not.toBeNull();

      // Recovery window — the ladder's daily rung (30 days).
      expect(el.querySelector('[data-testid="metric-recovery"]')?.textContent).toContain(
        'Undo anything from the last 30 days',
      );

      // Privacy — the structural constant.
      expect(el.querySelector('[data-testid="metric-privacy"]')?.textContent).toContain(
        'Your provider cannot read your data',
      );

      // Cost — aggregate bytes / quota with a bar.
      const cost = el.querySelector('[data-testid="metric-cost"]');
      expect(cost?.textContent).toContain('2.0 GB of 10.0 GB');
      expect(cost?.querySelector('[data-testid="cost-bar"]')).not.toBeNull();

      // Exit — always-available export + honest metered note.
      expect(el.querySelector('[data-testid="export-everything"]')).not.toBeNull();
      expect(el.querySelector('[data-testid="exit-metered-note"]')).not.toBeNull();
    });

    it('drops the recovery-window metric when the provider promises no retention', async () => {
      const el = await mount({
        loadStatus: vi.fn<BackupCardProps['loadStatus']>().mockResolvedValue({
          ...freshStatus,
          home: {
            retention: { kind: 'none' },
            restoreCostClass: 'free-egress',
          },
        }),
        onRunNow: neverRun,
      });
      expect(el.querySelector('[data-testid="metric-recovery"]')).toBeNull();
      expect(el.querySelector('[data-testid="exit-metered-note"]')).toBeNull();
    });

    it('reads Cost as unmetered when the provider reports no quota', async () => {
      const el = await mount({
        loadStatus: vi.fn<BackupCardProps['loadStatus']>().mockResolvedValue(freshStatus),
        loadUsage: vi.fn<NonNullable<BackupCardProps['loadUsage']>>().mockResolvedValue({
          backup: { bytesStored: 512 * 1024 ** 2, quotaBytes: null },
        }),
        onRunNow: neverRun,
      });
      const cost = el.querySelector('[data-testid="metric-cost"]');
      expect(cost?.textContent).toContain('unmetered');
      expect(cost?.querySelector('[data-testid="cost-bar"]')).toBeNull();
    });

    it('reads freshness as unknown when a custody clock has never happened', async () => {
      const el = await mount({
        loadStatus: vi.fn<BackupCardProps['loadStatus']>().mockResolvedValue({
          ...freshStatus,
          vaults: [{ ...freshStatus.vaults[0]!, lastVerifyAt: undefined }],
        }),
        onRunNow: neverRun,
      });
      const freshness = el.querySelector('[data-testid="metric-freshness"]');
      expect(freshness?.textContent).toContain('Not yet proven safe offsite');
    });

    it('keeps the four custody clocks + run trigger behind the Diagnostics disclosure', async () => {
      const el = await mount({
        loadStatus: vi.fn<BackupCardProps['loadStatus']>().mockResolvedValue(freshStatus),
        onRunNow: neverRun,
      });
      const diagnostics = el.querySelector<HTMLDetailsElement>(
        '[data-testid="backup-diagnostics"]',
      );
      expect(diagnostics?.tagName).toBe('DETAILS');
      expect(diagnostics?.open).toBe(false); // collapsed by default
      // The clocks live inside it, not on the primary surface.
      expect(diagnostics?.querySelector('[data-testid="freshness-clocks"]')).not.toBeNull();
      expect(
        [...(diagnostics?.querySelectorAll('button') ?? [])].some((b) =>
          b.textContent?.includes('Back up now'),
        ),
      ).toBe(true);
    });

    it('never renders a casAck "Confirm an attachment" control', async () => {
      const el = await mount({
        loadStatus: vi.fn<BackupCardProps['loadStatus']>().mockResolvedValue(freshStatus),
        onRunNow: neverRun,
      });
      expect(el.textContent).not.toContain('Confirm an attachment');
      expect(el.textContent).not.toContain('Storage class');
    });
  });
});
