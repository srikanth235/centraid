import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import StorageCard, { type StorageCardStatusDTO } from './StorageCard.js';

const NOW = Date.UTC(2026, 6, 11, 12, 0, 0);

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

async function mount(props: {
  loadStatus: () => Promise<StorageCardStatusDTO>;
  onOpenSettings?: () => void;
  now?: number;
}): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(
      <StorageCard
        now={props.now ?? NOW}
        loadStatus={props.loadStatus}
        onOpenSettings={props.onOpenSettings ?? (() => {})}
      />,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

const neverLoad = (): Promise<StorageCardStatusDTO> => new Promise(() => {});

describe('StorageCard — loading / error / empty', () => {
  it('renders a checking state before the first load resolves', async () => {
    const el = await mount({ loadStatus: neverLoad });
    expect(el.textContent).toContain('Checking storage status…');
  });

  it('renders a load error inline', async () => {
    const el = await mount({ loadStatus: vi.fn().mockRejectedValue(new Error('fetch failed')) });
    expect(el.textContent).toContain('Couldn’t reach the gateway: fetch failed');
  });

  it('renders the empty state with a link into Settings → Storage when no connections exist', async () => {
    const onOpenSettings = vi.fn();
    const el = await mount({
      loadStatus: vi.fn().mockResolvedValue({ connections: [], vaults: [] }),
      onOpenSettings,
    });
    expect(el.textContent).toContain('No remote storage connected yet');
    const link = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Settings → Storage'),
    ) as HTMLButtonElement;
    expect(link).toBeDefined();
    await act(async () => link.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('the Manage button calls onOpenSettings', async () => {
    const onOpenSettings = vi.fn();
    const el = await mount({
      loadStatus: vi.fn().mockResolvedValue({ connections: [], vaults: [] }),
      onOpenSettings,
    });
    const manageBtn = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Manage'),
    );
    await act(async () => manageBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});

describe('StorageCard — provider connection with quota', () => {
  const status: StorageCardStatusDTO = {
    connections: [
      {
        id: 'c1',
        kind: 'provider',
        name: 'Clawgnition',
        uses: ['backup', 'cas'],
        providerReported: {
          backup: { bytesStored: 10_000_000, quotaBytes: 100_000_000 },
          cas: { bytesStored: 5_000_000, quotaBytes: 100_000_000 },
        },
        localReplicatedBytes: 5_000_000,
        fetchedAt: new Date(NOW - 5 * 60_000).toISOString(),
      },
    ],
    vaults: [],
  };

  it('renders the quota bar with the used/quota figures', async () => {
    const el = await mount({ loadStatus: vi.fn().mockResolvedValue(status) });
    const bar = el.querySelector('[data-testid="quota-bar"]');
    expect(bar).toBeTruthy();
    expect(bar?.textContent).toContain('of');
    expect(bar?.textContent).toContain('15%'); // (10M+5M)/100M
  });

  it('shows an honest drift read when provider and local bytes agree (both 5,000,000)', async () => {
    const el = await mount({ loadStatus: vi.fn().mockResolvedValue(status) });
    const drift = el.querySelector<HTMLElement>('[data-testid="drift-line"]');
    expect(drift?.textContent).toContain('provider reports');
    expect(drift?.textContent).toContain('locally verified');
    expect(drift?.dataset.emphasis).toBeUndefined(); // no drift flag — they match
  });

  it('flags a real gap between provider-reported and locally-verified CAS bytes', async () => {
    const drifted: StorageCardStatusDTO = {
      connections: [
        {
          ...status.connections[0]!,
          localReplicatedBytes: 1_000_000, // provider says 5M, local only confirms 1M
        },
      ],
      vaults: [],
    };
    const el = await mount({ loadStatus: vi.fn().mockResolvedValue(drifted) });
    const drift = el.querySelector<HTMLElement>('[data-testid="drift-line"]');
    expect(drift?.dataset.emphasis).toBe('warn');
    expect(drift?.textContent).toContain('drift worth a look');
  });

  it('shows the fetchedAt provenance line', async () => {
    const el = await mount({ loadStatus: vi.fn().mockResolvedValue(status) });
    expect(el.textContent).toContain('provider figures as of');
  });
});

describe('StorageCard — unmetered / pending / byo-s3', () => {
  it('renders "unmetered" for a provider connection with quotaBytes: null', async () => {
    const status: StorageCardStatusDTO = {
      connections: [
        {
          id: 'c1',
          kind: 'provider',
          name: 'Unmetered Co',
          uses: ['cas'],
          providerReported: { cas: { bytesStored: 2_000_000, quotaBytes: null } },
          localReplicatedBytes: 2_000_000,
        },
      ],
      vaults: [],
    };
    const el = await mount({ loadStatus: vi.fn().mockResolvedValue(status) });
    expect(el.textContent).toContain('unmetered');
    expect(el.querySelector('[data-testid="quota-bar"]')).toBeNull();
  });

  it('renders a pending-usage note when a provider connection has no report yet', async () => {
    const status: StorageCardStatusDTO = {
      connections: [
        {
          id: 'c1',
          kind: 'provider',
          name: 'Brand New',
          uses: ['cas'],
          providerReported: null,
          localReplicatedBytes: 0,
        },
      ],
      vaults: [],
    };
    const el = await mount({ loadStatus: vi.fn().mockResolvedValue(status) });
    expect(el.textContent).toContain('hasn’t reported in yet');
  });

  it('a byo-s3 connection shows "locally verified" with no provider drift claim', async () => {
    const status: StorageCardStatusDTO = {
      connections: [
        {
          id: 'c1',
          kind: 'byo-s3',
          name: 'My Bucket',
          uses: ['cas'],
          providerReported: null,
          localReplicatedBytes: 3_000_000,
        },
      ],
      vaults: [],
    };
    const el = await mount({ loadStatus: vi.fn().mockResolvedValue(status) });
    const drift = el.querySelector('[data-testid="drift-line"]');
    expect(drift?.textContent).toContain('locally verified');
    expect(drift?.textContent).not.toContain('provider reports');
    expect(el.querySelector('[data-testid="quota-bar"]')).toBeNull();
  });
});

describe('StorageCard — per-vault replication rows', () => {
  it('renders replicated/backlog counts and flags a nonzero backlog', async () => {
    const status: StorageCardStatusDTO = {
      connections: [
        {
          id: 'c1',
          kind: 'byo-s3',
          name: 'My Bucket',
          uses: ['cas'],
          providerReported: null,
          localReplicatedBytes: 1000,
        },
      ],
      vaults: [
        {
          vaultId: 'v1',
          name: 'Main',
          configured: true,
          connectionId: 'c1',
          replicated: { count: 40, bytes: 1000 },
          backlog: { count: 3, bytes: 200 },
          lastSweep: {
            completedAt: new Date(NOW - 60_000).toISOString(),
            error: null,
            consecutiveFailures: 0,
          },
        },
      ],
    };
    const el = await mount({ loadStatus: vi.fn().mockResolvedValue(status) });
    const row = el.querySelector('[data-testid="storage-vault-row"]');
    expect(row?.textContent).toContain('Main');
    expect(row?.textContent).toContain('replicated 40');
    expect(row?.textContent).toContain('backlog 3');
    const warnSpan = row?.querySelector('[data-emphasis="warn"]');
    expect(warnSpan?.textContent).toContain('backlog');
  });

  it('surfaces a persistently-failing sweep error on the vault row', async () => {
    const status: StorageCardStatusDTO = {
      connections: [
        {
          id: 'c1',
          kind: 'byo-s3',
          name: 'My Bucket',
          uses: ['cas'],
          providerReported: null,
          localReplicatedBytes: 0,
        },
      ],
      vaults: [
        {
          vaultId: 'v1',
          name: 'Main',
          configured: true,
          connectionId: 'c1',
          replicated: { count: 0, bytes: 0 },
          backlog: { count: 5, bytes: 500 },
          lastSweep: {
            completedAt: null,
            error: 'ENOTFOUND s3.example.com',
            consecutiveFailures: 4,
          },
        },
      ],
    };
    const el = await mount({ loadStatus: vi.fn().mockResolvedValue(status) });
    expect(el.textContent).toContain('4x failing: ENOTFOUND s3.example.com');
  });

  it('flags a not-yet-configured vault as "local only"', async () => {
    const status: StorageCardStatusDTO = {
      connections: [
        {
          id: 'c1',
          kind: 'byo-s3',
          name: 'My Bucket',
          uses: ['cas'],
          providerReported: null,
          localReplicatedBytes: 0,
        },
      ],
      vaults: [
        {
          vaultId: 'v2',
          name: 'Side',
          configured: false,
          replicated: { count: 0, bytes: 0 },
          backlog: { count: 0, bytes: 0 },
          lastSweep: { completedAt: null, error: null, consecutiveFailures: 0 },
        },
      ],
    };
    const el = await mount({ loadStatus: vi.fn().mockResolvedValue(status) });
    expect(el.textContent).toContain('Side');
    expect(el.textContent).toContain('local only');
  });
});

describe('StorageCard — bounded cache-tier health (issue #405 §7)', () => {
  const withCache = (
    cache: StorageCardStatusDTO['vaults'][number]['cache'],
  ): StorageCardStatusDTO => ({
    connections: [
      {
        id: 'c1',
        kind: 'byo-s3',
        name: 'My Bucket',
        uses: ['cas'],
        providerReported: null,
        localReplicatedBytes: 0,
      },
    ],
    vaults: [
      {
        vaultId: 'v1',
        name: 'Main',
        configured: true,
        connectionId: 'c1',
        replicated: { count: 10, bytes: 1000 },
        backlog: { count: 0, bytes: 0 },
        lastSweep: { completedAt: null, error: null, consecutiveFailures: 0 },
        cache,
      },
    ],
  });

  it('renders a spool-vs-budget bar, a derived hit rate, and bytes served local vs remote', async () => {
    const el = await mount({
      loadStatus: vi.fn().mockResolvedValue(
        withCache({
          spoolBytes: 400_000,
          budgetBytes: 1_000_000,
          localHits: 80,
          readThroughs: 20,
          rangedRemoteReads: 5,
          bytesServedLocal: 4_000_000,
          bytesServedRemote: 1_000_000,
          evictedBlobs: 0,
          evictedBytes: 0,
          backpressureEvents: 0,
        }),
      ),
    });
    const section = el.querySelector<HTMLElement>('[data-testid="storage-cache-section"]');
    expect(section).toBeTruthy();
    expect(section?.textContent).toContain('40%'); // 400k / 1M spool
    expect(section?.textContent).toContain('of'); // "X of Y budget"
    expect(section?.textContent).toContain('hit rate 80%'); // 80 / (80+20)
    expect(section?.textContent).toContain('local');
    expect(section?.textContent).toContain('remote');
    // Raw counts live in the tooltip so the percentage never floats free.
    const hit = [...section!.querySelectorAll('span')].find((s) =>
      s.textContent?.includes('hit rate'),
    );
    expect(hit?.getAttribute('title')).toContain('80 local hits');
    expect(hit?.getAttribute('title')).toContain('20 remote read-throughs');
  });

  it('shows an "unlimited budget" state with no bar when budgetBytes is null', async () => {
    const el = await mount({
      loadStatus: vi.fn().mockResolvedValue(
        withCache({
          spoolBytes: 250_000,
          budgetBytes: null,
          localHits: 3,
          readThroughs: 0,
          rangedRemoteReads: 0,
          bytesServedLocal: 250_000,
          bytesServedRemote: 0,
          evictedBlobs: 0,
          evictedBytes: 0,
          backpressureEvents: 0,
        }),
      ),
    });
    const section = el.querySelector<HTMLElement>('[data-testid="storage-cache-section"]');
    expect(section?.textContent).toContain('unlimited budget');
    // No spool bar / percentage when the budget is unbounded.
    expect(section?.querySelector('[data-testid="cache-spool-track"]')).toBeNull();
    expect(section?.textContent).not.toContain('of 0 budget');
  });

  it('surfaces evictions and backpressure only when nonzero', async () => {
    const el = await mount({
      loadStatus: vi.fn().mockResolvedValue(
        withCache({
          spoolBytes: 950_000,
          budgetBytes: 1_000_000,
          localHits: 50,
          readThroughs: 50,
          rangedRemoteReads: 0,
          bytesServedLocal: 5_000_000,
          bytesServedRemote: 5_000_000,
          evictedBlobs: 12,
          evictedBytes: 3_000_000,
          backpressureEvents: 2,
        }),
      ),
    });
    const section = el.querySelector<HTMLElement>('[data-testid="storage-cache-section"]');
    expect(section?.textContent).toContain('evicted 12');
    expect(section?.textContent).toContain('backpressure 2×');
    expect(section?.textContent).toContain('hit rate 50%');
    // 95% spool ⇒ error severity on the bar.
    expect(
      section?.querySelector('[data-testid="cache-spool-track"][data-severity="error"]'),
    ).toBeTruthy();
  });

  it('on a local-only vault shows spool occupancy but hides the remote-facing noise', async () => {
    const status: StorageCardStatusDTO = {
      // A connection exists on the gateway (so the card renders vault rows),
      // but this particular vault isn't attached to it — a local-only vault.
      connections: [
        {
          id: 'c1',
          kind: 'byo-s3',
          name: 'My Bucket',
          uses: ['cas'],
          providerReported: null,
          localReplicatedBytes: 0,
        },
      ],
      vaults: [
        {
          vaultId: 'v2',
          name: 'Side',
          configured: false,
          replicated: { count: 0, bytes: 0 },
          backlog: { count: 0, bytes: 0 },
          lastSweep: { completedAt: null, error: null, consecutiveFailures: 0 },
          cache: {
            spoolBytes: 120_000,
            budgetBytes: null,
            localHits: 4,
            readThroughs: 0,
            rangedRemoteReads: 0,
            bytesServedLocal: 120_000,
            bytesServedRemote: 0,
            evictedBlobs: 0,
            evictedBytes: 0,
            backpressureEvents: 0,
          },
        },
      ],
    };
    const el = await mount({ loadStatus: vi.fn().mockResolvedValue(status) });
    const section = el.querySelector<HTMLElement>('[data-testid="storage-cache-section"]');
    expect(section).toBeTruthy();
    expect(section?.textContent).toContain('unlimited budget');
    // The remote read (hit rate / served / evictions) is all-zero noise on a
    // local-only vault — hidden, not shown as a misleading "100%".
    expect(section?.textContent).not.toContain('hit rate');
    expect(section?.textContent).not.toContain('served');
  });
});
