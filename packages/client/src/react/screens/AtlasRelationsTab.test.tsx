import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bezelPacks,
  captionText,
  cleanupTab,
  detailLogical,
  fire,
  flush,
  focusOf,
  indexIds,
  indexRow,
  makeStats,
  mountTab,
  wedge,
  wedgeIds,
} from './atlasRelationsTestKit.js';

// The Map tab (issue #519 follow-on). The suite is organised around the defect
// the redesign exists to fix: under the old Simple/Standard/Everything dial a
// domain whose kinds held no rows kept its name on the bezel while every
// clickable node inside it disappeared — you could read `Locker` and never
// reach it. The first describe block is that contract, stated directly.

afterEach(cleanupTab);

describe('every domain is present and selectable', () => {
  it('draws a wedge for every ontology domain, including the empty ones', async () => {
    const el = await mountTab(makeStats());
    expect(wedgeIds(el)).toEqual(['core', 'health', 'knowledge', 'locker', 'business']);
  });

  it('marks an empty domain empty without removing it', async () => {
    const el = await mountTab(makeStats());
    expect(wedge(el, 'locker')?.dataset['empty']).toBe('true');
    expect(wedge(el, 'business')?.dataset['empty']).toBe('true');
  });

  it('opens a single-kind domain that holds nothing — the old dead case', async () => {
    const el = await mountTab(makeStats());
    await fire(wedge(el, 'locker'), 'click');
    expect(focusOf(el)).toBe('locker');
    expect(wedgeIds(el)).toEqual(['locker.item']);
  });

  it('opens the empty kind inside it and states the emptiness honestly', async () => {
    const el = await mountTab(makeStats());
    await fire(wedge(el, 'locker'), 'click');
    await fire(wedge(el, 'locker.item'), 'click');
    expect(detailLogical(el)).toBe('locker.item');
    const count = el.querySelector('[data-testid="atlas-detail-count"]')?.textContent ?? '';
    expect(count).toContain('0');
    expect(count).toContain('nothing has been added yet');
  });

  it('offers to create the first row rather than a dead end', async () => {
    const el = await mountTab(makeStats());
    await fire(wedge(el, 'locker'), 'click');
    await fire(wedge(el, 'locker.item'), 'click');
    expect(el.querySelector('[data-testid="atlas-open-browse"]')?.textContent).toContain(
      'Add the first',
    );
  });

  it('opens an empty domain the graph payload never mentions', async () => {
    const el = await mountTab(makeStats());
    await fire(wedge(el, 'business'), 'click');
    expect(wedgeIds(el)).toEqual(['business.client', 'business.invoice']);
  });
});

describe('the ring and the index are one selection', () => {
  it('lists exactly the same ids in both halves', async () => {
    const el = await mountTab(makeStats());
    expect(indexIds(el)).toEqual(wedgeIds(el));
  });

  it('drills from the index as well as the ring', async () => {
    const el = await mountTab(makeStats());
    await fire(indexRow(el, 'locker'), 'click');
    expect(focusOf(el)).toBe('locker');
  });

  it('selects a kind from the index', async () => {
    const el = await mountTab(makeStats());
    await fire(indexRow(el, 'core'), 'click');
    await fire(indexRow(el, 'core.party'), 'click');
    expect(detailLogical(el)).toBe('core.party');
  });
});

describe('walking up and sideways', () => {
  it('returns to the root from the centre plate', async () => {
    const el = await mountTab(makeStats());
    await fire(wedge(el, 'core'), 'click');
    await fire(el.querySelector('[data-testid="atlas-core"]'), 'click');
    expect(focusOf(el)).toBe('root');
  });

  it('returns to the root from the breadcrumb', async () => {
    const el = await mountTab(makeStats());
    await fire(wedge(el, 'core'), 'click');
    await fire(el.querySelector('[data-testid="atlas-crumb-root"]'), 'click');
    expect(focusOf(el)).toBe('root');
  });

  it('hides the bezel at the root, where it would only repeat the ring', async () => {
    const el = await mountTab(makeStats());
    expect(bezelPacks(el)).toEqual([]);
  });

  it('shows every domain on the bezel once drilled in', async () => {
    const el = await mountTab(makeStats());
    await fire(wedge(el, 'core'), 'click');
    expect(bezelPacks(el)).toEqual(['core', 'health', 'knowledge', 'locker', 'business']);
  });

  it('moves sideways between domains without a trip through the root', async () => {
    const el = await mountTab(makeStats());
    await fire(wedge(el, 'core'), 'click');
    await fire(el.querySelector('[data-testid="atlas-bezel"][data-pack="knowledge"]'), 'click');
    expect(focusOf(el)).toBe('knowledge');
  });
});

describe('the plumbing switch only ever adds', () => {
  it('leaves machinery domains off the ring by default', async () => {
    const el = await mountTab(makeStats());
    expect(wedgeIds(el)).not.toContain('consent');
    expect(wedgeIds(el)).not.toContain('sync');
  });

  it('adds machinery without removing any ontology domain', async () => {
    const el = await mountTab(makeStats());
    const before = wedgeIds(el);
    await fire(el.querySelector('[data-testid="atlas-plumbing"]'), 'click');
    const after = wedgeIds(el);
    expect(after).toEqual(expect.arrayContaining(before));
    expect(after).toContain('consent');
    expect(after).toContain('sync');
  });

  it('says how many domains the switch is holding back', async () => {
    const el = await mountTab(makeStats());
    expect(captionText(el)).toContain('plumbing domains behind the switch');
  });
});

describe('connections are walked, not drawn', () => {
  it('lists an empty kind’s real FK neighbours', async () => {
    const el = await mountTab(makeStats());
    await fire(wedge(el, 'locker'), 'click');
    await fire(wedge(el, 'locker.item'), 'click');
    const hops = [...el.querySelectorAll<HTMLElement>('[data-testid="atlas-hop"]')].map(
      (h) => h.dataset['logical'],
    );
    expect(hops).toEqual(expect.arrayContaining(['core.party', 'sync.connection']));
  });

  it('walks a hop into another domain and re-seats the rung', async () => {
    const el = await mountTab(makeStats());
    await fire(wedge(el, 'locker'), 'click');
    await fire(wedge(el, 'locker.item'), 'click');
    await fire(el.querySelector('[data-testid="atlas-hop"][data-logical="core.party"]'), 'click');
    expect(focusOf(el)).toBe('core');
    expect(detailLogical(el)).toBe('core.party');
  });

  it('turns plumbing ON when a hop lands in machinery, never stranding you', async () => {
    const el = await mountTab(makeStats());
    await fire(wedge(el, 'locker'), 'click');
    await fire(wedge(el, 'locker.item'), 'click');
    await fire(
      el.querySelector('[data-testid="atlas-hop"][data-logical="sync.connection"]'),
      'click',
    );
    expect(focusOf(el)).toBe('sync');
    expect(el.querySelector('[data-testid="atlas-plumbing"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(bezelPacks(el)).toContain('sync');
  });

  it('walks back to the root when plumbing is switched off from inside it', async () => {
    const el = await mountTab(makeStats());
    await fire(el.querySelector('[data-testid="atlas-plumbing"]'), 'click');
    await fire(wedge(el, 'sync'), 'click');
    expect(focusOf(el)).toBe('sync');
    await fire(el.querySelector('[data-testid="atlas-plumbing"]'), 'click');
    expect(focusOf(el)).toBe('root');
  });

  it('omits the connections section entirely when the graph never landed', async () => {
    const el = await mountTab(makeStats(), { graph: null });
    await fire(wedge(el, 'locker'), 'click');
    await fire(wedge(el, 'locker.item'), 'click');
    expect(el.querySelector('[data-testid="atlas-hop"]')).toBeNull();
    expect(el.querySelector('[data-testid="atlas-no-neighbours"]')).toBeNull();
  });
});

describe('honest readouts', () => {
  it('shows the census total on the centre plate, then the domain’s own', async () => {
    const el = await mountTab(makeStats());
    const core = el.querySelector('[data-testid="atlas-core"]')?.textContent ?? '';
    expect(core).toContain('Vault');
    expect(core).toContain((214 + 44902 + 342 + 41230 + 742).toLocaleString('en-US'));
    await fire(wedge(el, 'health'), 'click');
    expect(el.querySelector('[data-testid="atlas-core"]')?.textContent).toContain(
      (41230).toLocaleString('en-US'),
    );
  });

  it('counts domains and populated kinds from the census, never hardcoded', async () => {
    const el = await mountTab(makeStats());
    expect(captionText(el)).toContain('domains, every one on the ring');
    expect(captionText(el)).toContain('kinds, 5 with something in them');
  });

  it('falls back to mechanical labels when the graph is absent', async () => {
    const el = await mountTab(makeStats(), { graph: null });
    await fire(wedge(el, 'core'), 'click');
    expect(indexRow(el, 'core.party')?.textContent).toContain('party');
  });

  it('renders an empty state when the census itself is missing', async () => {
    const el = await mountTab(null);
    expect(el.querySelector('[data-testid="atlas-relations-empty"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="atlas-sunburst"]')).toBeNull();
  });

  it('shows real sample rows for the selected kind and how many remain', async () => {
    const fetchSampleRows = vi.fn(async () => [{ display_name: 'Anita Raghavan' }]);
    const el = await mountTab(makeStats(), { fetchSampleRows });
    await fire(wedge(el, 'core'), 'click');
    await fire(wedge(el, 'core.party'), 'click');
    await flush();
    expect(el.querySelector('[data-testid="atlas-samples"]')?.textContent).toContain(
      'Anita Raghavan',
    );
    expect(el.querySelector('[data-testid="atlas-samples-more"]')?.textContent).toContain('213');
  });

  it('hands Browse the kind you were looking at', async () => {
    const onOpenBrowse = vi.fn();
    const el = await mountTab(makeStats(), { onOpenBrowse });
    await fire(wedge(el, 'core'), 'click');
    await fire(wedge(el, 'core.party'), 'click');
    await fire(el.querySelector('[data-testid="atlas-open-browse"]'), 'click');
    expect(onOpenBrowse).toHaveBeenCalledWith('core.party');
  });
});
