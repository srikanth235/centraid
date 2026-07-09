import { describe, expect, it } from 'vitest';
import { toSidebarApps } from './sidebarApps.js';

const app = (id: string, name: string): UserAppMeta =>
  ({ id, name, iconKey: 'Todo', color: '#123', colorKey: 'blue' }) as unknown as UserAppMeta;
const draft = (id: string, name: string): DraftAppMeta =>
  ({ id, name, iconKey: 'Sparkle', color: '#456', __draft: true, hasIndex: true }) as unknown as DraftAppMeta;

describe('toSidebarApps', () => {
  it('maps installed apps with the `new` status and drafts with `draft`', () => {
    const { apps, drafts } = toSidebarApps([app('todos', 'Todos')], [draft('d1', 'WIP')]);
    expect(apps).toEqual([
      { id: 'todos', name: 'Todos', iconKey: 'Todo', color: '#123', status: 'new' },
    ]);
    expect(drafts).toEqual([
      { id: 'd1', name: 'WIP', iconKey: 'Sparkle', color: '#456', status: 'draft' },
    ]);
  });

  it('preserves order within each list', () => {
    const { apps } = toSidebarApps([app('a', 'A'), app('b', 'B')], []);
    expect(apps.map((a) => a.id)).toEqual(['a', 'b']);
  });

  it('handles empty inputs', () => {
    expect(toSidebarApps([], [])).toEqual({ apps: [], drafts: [] });
  });
});
