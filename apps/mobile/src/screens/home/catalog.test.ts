import type { AppMetaResolved } from '@centraid/design-tokens';
/* oxlint-disable import/first -- vi.mock is hoisted; subject imports intentionally follow */
/**
 * Home / Spaces launcher owner (issue #545 C5/C7 surface) — pure catalog merge.
 * resolveAppMeta is mocked so vitest never loads react-native via gateway.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock(import('../../lib/gateway'), () => ({
  resolveAppMeta: (row: {
    id: string;
    name?: string;
    description?: string;
    iconKey?: string;
    colorKey?: string;
  }): AppMetaResolved =>
    ({
      id: row.id,
      name: row.name ?? row.id,
      desc: row.description ?? '',
      iconKey: row.iconKey ?? 'Sparkle',
      color: '#888',
      colorKey: row.colorKey ?? 'slate',
    }) as unknown as AppMetaResolved,
}));

import { buildLauncherItems, filterLauncherItems, NATIVE_APP_IDS } from './catalog';

function meta(id: string, name: string, description = ''): AppMetaResolved {
  return {
    id,
    name,
    desc: description,
    iconKey: 'Sparkle',
    color: '#888',
    colorKey: 'slate',
  } as unknown as AppMetaResolved;
}

describe(buildLauncherItems, () => {
  it('always includes native covers as installed', () => {
    const items = buildLauncherItems([]);
    const natives = items.filter((it) => NATIVE_APP_IDS.has(it.meta.id));
    expect(natives).toHaveLength(3);
    expect(natives.every((it) => it.installed)).toBe(true);
    expect(natives.map((it) => it.route.kind).sort()).toStrictEqual(['agenda', 'docs', 'photos']);
  });

  it('dims uninstalled gateway catalog apps and routes them to pair', () => {
    const items = buildLauncherItems([]);
    const tasks = items.find((it) => it.meta.id === 'tasks');
    expect(tasks).toMatchObject({ installed: false, route: { kind: 'pair' } });
  });

  it('promotes installed catalog apps and keeps custom remote apps', () => {
    const remote = [meta('tasks', 'My Tasks', 'live'), meta('custom-app', 'Custom', 'user built')];
    const items = buildLauncherItems(remote);
    const tasks = items.find((it) => it.meta.id === 'tasks');
    expect(tasks).toMatchObject({
      installed: true,
      meta: expect.objectContaining({ name: 'My Tasks' }),
      route: { kind: 'app', appId: 'tasks' },
    });
    const custom = items.find((it) => it.meta.id === 'custom-app');
    expect(custom).toMatchObject({
      installed: true,
      route: { kind: 'app', appId: 'custom-app' },
    });
  });
});

describe(filterLauncherItems, () => {
  it('filters by name case-insensitively and returns a copy for empty query', () => {
    const items = buildLauncherItems([]);
    const copy = filterLauncherItems(items, '  ');
    expect(copy).toStrictEqual(items);
    expect(copy).not.toBe(items);
    const photos = filterLauncherItems(items, 'PHOTO');
    expect(photos.every((it) => it.meta.name.toLowerCase().includes('photo'))).toBe(true);
    expect(photos.length).toBeGreaterThan(0);
  });
});
