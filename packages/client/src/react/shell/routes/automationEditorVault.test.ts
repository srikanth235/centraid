import { describe, expect, it, vi } from 'vitest';
import { vaultForTriggers } from './AutomationEditorRoute.js';

// The route module pulls the whole gateway-client surface in transitively; we
// only exercise the pure `vaultForTriggers` derivation, so stub the client so
// importing the route doesn't need a live gateway. (`vi.mock` is hoisted above
// the imports at transform time — same mock seam every other route test uses.)
vi.mock('../../../gateway-client.js', () => ({}));

describe('vaultForTriggers', () => {
  it('returns undefined when no data/condition trigger contributes an entity', () => {
    expect(vaultForTriggers([{ kind: 'cron', expr: '0 9 * * *' }])).toBeUndefined();
    expect(vaultForTriggers([{ kind: 'webhook' }])).toBeUndefined();
    expect(vaultForTriggers([])).toBeUndefined();
  });

  it('derives read scopes from condition + data triggers, splitting schema.table', () => {
    const vault = vaultForTriggers([
      { kind: 'condition', entity: 'business.invoice' },
      { kind: 'data', entities: ['core.transaction', 'core.party'] },
    ]);
    expect(vault).toEqual({
      purpose: 'dpv:ServiceProvision',
      why: 'Evaluate automation triggers.',
      scopes: [
        { schema: 'business', table: 'invoice', verbs: 'read' },
        { schema: 'core', table: 'transaction', verbs: 'read' },
        { schema: 'core', table: 'party', verbs: 'read' },
      ],
    });
  });

  it('maps a bare (dotless) entity to a schema-only scope with no table', () => {
    expect(vaultForTriggers([{ kind: 'condition', entity: 'inbox' }])).toEqual({
      purpose: 'dpv:ServiceProvision',
      why: 'Evaluate automation triggers.',
      scopes: [{ schema: 'inbox', verbs: 'read' }],
    });
  });

  it('de-duplicates entities shared across triggers', () => {
    const vault = vaultForTriggers([
      { kind: 'data', entities: ['core.event'] },
      { kind: 'condition', entity: 'core.event' },
    ]);
    expect(vault?.scopes).toEqual([{ schema: 'core', table: 'event', verbs: 'read' }]);
  });
});
