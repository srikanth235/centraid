import { afterEach, describe, expect, it, vi } from 'vitest';
// The inline kit is imported FIRST so its `./suppress-served-ask` side effect
// runs before the real kit module below (it suppresses kit.ts's auto-mounting
// Ask IIFE).
import {
  fmtMoney as inlineFmtMoney,
  onDataChange,
  relTime as inlineRelTime,
  wireThemeToggle,
} from './kit-inline.js';
import { fmtMoney as kitFmtMoney, relTime as kitRelTime } from '@centraid/blueprints/kit/kit.js';
import type { ReplicaInvalidation } from '../../replica/types.js';
import { installInlineCentraid } from './centraid-inline.js';

// gateway-client-core touches window.CentraidApi at module load; stub the whole
// module (this suite exercises no gateway I/O — only the theme/onChange
// surface). vitest hoists this above the imports at run time.
vi.mock('../../gateway-client-core.js', () => ({
  auth: vi.fn(async () => ({ baseUrl: 'https://gw.test', token: 'tok' })),
  authHeaders: () => ({}),
  doFetch: vi.fn(),
  readJson: vi.fn(),
}));

function fakeSession(subscribers: Array<(inv: readonly ReplicaInvalidation[]) => void>) {
  return {
    read: vi.fn(),
    search: vi.fn(),
    write: vi.fn(),
    subscribe: vi.fn(
      (_appId: string, _deps: unknown, listener: (inv: readonly ReplicaInvalidation[]) => void) => {
        subscribers.push(listener);
        return () => undefined;
      },
    ),
  } as never;
}

describe('kit-inline', () => {
  afterEach(() => {
    delete (window as { centraid?: unknown }).centraid;
    delete document.documentElement.dataset.theme;
  });

  it('re-exports the pure kit formatters verbatim', () => {
    expect(inlineFmtMoney).toBe(kitFmtMoney);
    expect(inlineRelTime).toBe(kitRelTime);
    expect(inlineFmtMoney(1299, 'USD')).toBe(kitFmtMoney(1299, 'USD'));
  });

  it('onDataChange subscribes through the inline replica session and fires on invalidation', async () => {
    const subscribers: Array<(inv: readonly ReplicaInvalidation[]) => void> = [];
    installInlineCentraid({ appId: 'tasks', session: fakeSession(subscribers), queries: {} });
    const seen: Array<{ tables?: string[] }> = [];
    const stop = onDataChange(
      ['schedule.task'],
      (detail: { tables?: string[] }) => seen.push(detail),
      { debounceMs: 0 },
    );
    expect(subscribers).toHaveLength(1);

    subscribers[0]?.([
      { shapeId: 's', entity: 'schedule.task', source: 'canonical' } as ReplicaInvalidation,
    ]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.tables).toEqual(['schedule.task']);
    stop();
  });

  it('wireThemeToggle flips the shell document theme', () => {
    document.documentElement.dataset.theme = 'light';
    const btn = document.createElement('button');
    wireThemeToggle(btn);
    expect(btn.innerHTML).toContain('svg');
    btn.click();
    expect(document.documentElement.dataset.theme).toBe('dark');
    btn.click();
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
