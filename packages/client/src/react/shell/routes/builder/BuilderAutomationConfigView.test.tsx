import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// ConfigView pulls in gateway-client.js (writeAppFile/publish/readAutomation)
// for the trigger save path — stub it the same way AppFrame.test.tsx does so
// a static render doesn't need `window.CentraidApi` (only present under
// Electron, not jsdom).
vi.mock('../../../../gateway-client.js', () => ({
  writeAppFile: vi.fn(),
  publish: vi.fn(),
  readAutomation: vi.fn(),
  listAutomationRuns: vi.fn().mockResolvedValue([]),
}));

const { default: ConfigView } = await import('./BuilderAutomationConfigView.js');

function row(triggers: CentraidAutomationManifest['triggers']): CentraidAutomationRow {
  const manifest: CentraidAutomationManifest = {
    name: 'Invoice watcher',
    version: '0.1.0',
    enabled: true,
    prompt: 'Watch invoices',
    triggers,
    requires: {},
    history: { keep: { count: 100 } },
    generated: { by: 'agent', at: new Date().toISOString() },
  };
  return {
    id: 'invoice-watcher',
    dir: '/tmp/apps/invoice-watcher',
    name: 'Invoice watcher',
    triggers,
    enabled: true,
    ownerApp: 'invoice-watcher',
    ref: 'invoice-watcher/invoice-watcher',
    manifest,
  };
}

// GAP 2: a condition trigger's `where` clause used to be swallowed entirely
// ("Fires when <entity> matches its condition", full stop). It must render
// readably instead.
describe('ConfigView — condition trigger where clause (GAP 2)', () => {
  it('pretty-prints the where clause in a monospace block', () => {
    const r = row([
      {
        kind: 'condition',
        entity: 'business.invoice',
        where: [
          { column: 'status', op: 'eq', value: 'open' },
          { column: 'due_in_days', op: 'within-days', value: 3 },
        ],
      },
    ]);
    const html = renderToStaticMarkup(<ConfigView automationRow={r} flashSections={new Set()} />);
    expect(html).toContain('Fires when business.invoice matches its condition');
    expect(html).toContain('whereBlock');
    expect(html).toContain('status eq &quot;open&quot;');
    expect(html).toContain('due_in_days within-days 3');
  });

  it('renders no where block when the clause is absent', () => {
    const r = row([{ kind: 'condition', entity: 'business.invoice' }]);
    const html = renderToStaticMarkup(<ConfigView automationRow={r} flashSections={new Set()} />);
    expect(html).not.toContain('whereBlock');
  });
});

describe('ConfigView — Activity card (wide-layout follow-up)', () => {
  it('shows an exact next-fire time for a cron trigger', () => {
    const r = row([{ kind: 'cron', expr: '0 9 * * *' }]);
    const html = renderToStaticMarkup(<ConfigView automationRow={r} flashSections={new Set()} />);
    expect(html).toContain('Next fires');
    expect(html).not.toContain('Manual only');
  });

  it('describes a data/condition trigger by its poll cadence instead of a fabricated time', () => {
    const r = row([{ kind: 'data', entities: ['core.transaction'], every: '15m' }]);
    const html = renderToStaticMarkup(<ConfigView automationRow={r} flashSections={new Set()} />);
    expect(html).toContain('Checks 15m');
  });

  it('reads "Waiting for a webhook call" for a webhook-only automation', () => {
    const r = row([{ kind: 'webhook', id: 'abc123' }]);
    const html = renderToStaticMarkup(<ConfigView automationRow={r} flashSections={new Set()} />);
    expect(html).toContain('Waiting for a webhook call');
  });

  it('reads "Manual only" with no triggers at all', () => {
    const r = row([]);
    const html = renderToStaticMarkup(<ConfigView automationRow={r} flashSections={new Set()} />);
    expect(html).toContain('Manual only');
  });
});

describe('ConfigView — Vault access section', () => {
  it('renders scopes and the why line when the manifest carries a vault block', () => {
    const r = row([{ kind: 'cron', expr: '0 9 * * *' }]);
    const withVault = {
      ...r,
      manifest: {
        ...r.manifest,
        vault: {
          purpose: 'dpv:ServiceProvision',
          why: 'Reads invoice status to draft a reminder.',
          scopes: [{ schema: 'business', table: 'invoice', verbs: 'read' }],
        },
      },
    } as CentraidAutomationRow;
    const html = renderToStaticMarkup(
      <ConfigView automationRow={withVault} flashSections={new Set()} />,
    );
    expect(html).toContain('Vault access');
    expect(html).toContain('Reads invoice status to draft a reminder.');
    expect(html).toContain('business.invoice');
    expect(html).toContain('read');
  });

  it('renders no Vault access section when the manifest carries no vault block', () => {
    const r = row([{ kind: 'cron', expr: '0 9 * * *' }]);
    const html = renderToStaticMarkup(<ConfigView automationRow={r} flashSections={new Set()} />);
    expect(html).not.toContain('Vault access');
  });
});

describe('ConfigView — trigger editor affordances (GAP 1)', () => {
  it('offers an Add trigger control and per-trigger Edit/Remove buttons', () => {
    const r = row([{ kind: 'cron', expr: '0 9 * * *' }]);
    const html = renderToStaticMarkup(<ConfigView automationRow={r} flashSections={new Set()} />);
    expect(html).toContain('Add trigger');
    expect(html).toContain('Edit trigger');
    expect(html).toContain('Remove trigger');
  });

  it('shows a manual-only message with an Add trigger control when there are no triggers', () => {
    const r = row([]);
    const html = renderToStaticMarkup(<ConfigView automationRow={r} flashSections={new Set()} />);
    expect(html).toContain('Manual runs only');
    expect(html).toContain('Add trigger');
  });
});
