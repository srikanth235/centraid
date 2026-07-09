import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../gateway-client.js', () => ({}));

import { attentionCount, buildHomeAppItems, buildHomeAutoItems } from './homeData.js';
import type { AutomationFeedEntry } from './automationsData.js';

beforeEach(() => {
  (globalThis as unknown as { CentraidTokens: unknown }).CentraidTokens = {
    tileFinish: () => ({ background: '#111', boxShadow: 'none', glyphColor: '#fff' }),
  };
});

const userApp = (id: string): UserAppMeta =>
  ({ id, name: id, iconKey: 'Todo', color: '#123', updatedAt: '2020-01-01T00:00:00Z' }) as unknown as UserAppMeta;
const draft = (id: string): DraftAppMeta =>
  ({ id, name: id, iconKey: 'Sparkle', color: '#456', __draft: true, hasIndex: true, desc: 'd' }) as unknown as DraftAppMeta;

const row = (over: Partial<CentraidAutomationRow> = {}): CentraidAutomationRow =>
  ({
    id: 'digest',
    ref: 'digest/main',
    name: 'Digest',
    enabled: true,
    triggers: [{ kind: 'cron', expr: '0 9 * * *' }],
    manifest: { requires: { mcps: [] }, description: 'runs daily' },
    ...over,
  }) as unknown as CentraidAutomationRow;

const entry = (ok: boolean): AutomationFeedEntry => ({
  automationId: 'digest/main',
  automationName: 'Digest',
  run: { runId: 'r', automationId: 'digest/main', startedAt: Date.now(), ok } as unknown as CentraidAutomationRunRecord,
});

describe('homeData', () => {
  it('builds app items, flagging drafts and starred', () => {
    const items = buildHomeAppItems([userApp('todos'), draft('wip')], {
      userApps: [userApp('todos')],
      isStarred: (id) => id === 'todos',
      tileVariant: 'gradient',
    });
    expect(items[0]).toMatchObject({ id: 'todos', draft: false, starred: true });
    expect(items[1]).toMatchObject({ id: 'wip', draft: true, stamp: 'saved', tone: 'draft' });
  });

  it('builds automation items with status + trigger labels', () => {
    const items = buildHomeAutoItems([row()], [entry(true)], () => false);
    expect(items[0]).toMatchObject({ ref: 'digest/main', name: 'Digest', triggerIcon: 'Clock' });
    expect(items[0]?.footOk).toBe(true);
  });

  it('counts automations whose last run failed as needing attention', () => {
    expect(attentionCount([row()], [entry(false)])).toBe(1);
    expect(attentionCount([row()], [entry(true)])).toBe(0);
  });
});
