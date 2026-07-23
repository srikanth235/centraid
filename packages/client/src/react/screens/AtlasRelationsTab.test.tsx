import { afterEach, describe, expect, it } from 'vitest';
import { ZOOM_MIN } from './atlasOrreryGeometry.js';
import {
  cleanupTab,
  dialLevel,
  edge,
  fire,
  flush,
  makeGraph,
  mountTab,
  node,
  nodeEl,
  orreryCenter,
  scaleOf,
  setLevel,
  viewportTransform,
} from './atlasRelationsTestKit.js';
import { SEALED_SENTINEL } from './atlasBrowseData.js';

// Component behaviour for the Relations "Map" tab (issue #519). Pure geometry
// and the detail-dial predicates live in atlasOrreryGeometry.test; the shared
// fixture, mount harness, and DOM helpers live in atlasRelationsTestKit.

afterEach(cleanupTab);

describe('AtlasRelationsTab', () => {
  it('renders a quiet empty state when the graph is null', async () => {
    const el = await mountTab(null);
    expect(el.querySelector('[data-testid="atlas-relations-empty"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="atlas-orrery"]')).toBeNull();
  });

  it('renders nodes and FK edges from the payload', async () => {
    const el = await mountTab(makeGraph());
    // this asserts standard-visibility facts (reachable machinery shows, ghost
    // edges draw, the hidden-endpoint edge is dropped) — the default is simple
    await setLevel(el, 'standard');
    const nodes = el.querySelectorAll('[data-testid="atlas-node"]');
    expect(nodes.length).toBeGreaterThan(0);
    // core_party is the centre — drawn as the plate, not a node
    expect(nodeEl(el, 'core_party')).toBeNull();
    // ontology kinds render, including the unreached island members
    expect(nodeEl(el, 'knowledge_note')).toBeTruthy();
    expect(nodeEl(el, 'locker_item')).toBeTruthy();
    // reachable machinery renders; unreachable machinery (sync_connection,
    // an island member) is hidden to keep the chart about the ontology
    expect(nodeEl(el, 'consent_device')).toBeTruthy();
    expect(nodeEl(el, 'sync_connection')).toBeNull();
    // FK edges present; the self-reference is excluded from the edge layer,
    // and so is any edge touching a hidden kind — sync_connection is hidden
    // (unreachable machinery), so locker_item's edge to it must not streak
    // into empty space (9 fkEdges − 1 self-ref − 1 hidden endpoint = 7)
    const edges = el.querySelectorAll('[data-testid="atlas-edge"]');
    expect(edges.length).toBe(7);
    expect(el.querySelector('[data-testid="atlas-edge"][data-to="sync_connection"]')).toBeNull();
  });

  it('states the measured centre fact from centerEdgeCount / edgeCount', async () => {
    const el = await mountTab(makeGraph());
    const cap = el.querySelector('[data-testid="atlas-center-caption"]');
    // 3 of 9 edges point at core_party
    expect(cap?.textContent).toContain('3 of 9');
    expect(cap?.textContent).toContain('structural references point here');
  });

  it('draws the ghost edge with the dotted ghost class', async () => {
    const el = await mountTab(makeGraph());
    // ghost edges are a standard-lens fact — simple hides them by design
    await setLevel(el, 'standard');
    const ghost = el.querySelector<HTMLElement>('[data-testid="atlas-edge"][data-ghost="true"]');
    expect(ghost).toBeTruthy();
    expect(ghost?.getAttribute('class')).toContain('edgeGhost');
  });

  it('weights live edges by fill — a 41k-row spine outweighs a 742-row column', async () => {
    const el = await mountTab(makeGraph());
    const spine = el.querySelector<SVGPathElement>(
      '[data-testid="atlas-edge"][data-from="health_vital"][data-to="core_observation"]',
    );
    const note = el.querySelector<SVGPathElement>(
      '[data-testid="atlas-edge"][data-from="knowledge_note"][data-to="core_party"][data-ghost="false"]',
    );
    const w = (p: SVGPathElement | null): number =>
      parseFloat((p?.style.strokeWidth || '0').toString());
    expect(w(spine)).toBeGreaterThan(w(note));
  });

  it('marks self-referencing kinds with a curl glyph, not a loop edge', async () => {
    const el = await mountTab(makeGraph());
    const concept = nodeEl(el, 'core_concept');
    expect(concept?.dataset.selfref).toBe('true');
    expect(concept?.querySelector('[data-testid="atlas-selfref-glyph"]')).toBeTruthy();
  });

  it('puts unreached ontology kinds on the unreached ring, agreeing with island', async () => {
    const el = await mountTab(makeGraph());
    const locker = nodeEl(el, 'locker_item');
    expect(locker?.dataset.hop).toBe('unreached');
    // every rendered unreached node is an island member
    const unreachedRendered = [...el.querySelectorAll<HTMLElement>('[data-testid="atlas-node"]')]
      .filter((n) => n.dataset.hop === 'unreached')
      .map((n) => n.dataset.physical);
    for (const p of unreachedRendered) expect(makeGraph().island).toContain(p);
  });

  it('re-centres on click: hop rings change but bearings never move', async () => {
    const el = await mountTab(makeGraph());
    const vitalBefore = nodeEl(el, 'health_vital');
    const noteBearing = nodeEl(el, 'knowledge_note')?.dataset.bearing;
    expect(vitalBefore?.dataset.hop).toBe('2'); // 2 hops from core_party

    await fire(nodeEl(el, 'core_observation'), 'click');

    expect(orreryCenter(el)).toBe('core_observation');
    // health_vital is now one hop from the new centre
    expect(nodeEl(el, 'health_vital')?.dataset.hop).toBe('1');
    // …but knowledge_note's bearing is unchanged — the compass never spins
    expect(nodeEl(el, 'knowledge_note')?.dataset.bearing).toBe(noteBearing);
  });

  it('toggles the authored-link overlay from a relation chip', async () => {
    const el = await mountTab(makeGraph());
    expect(el.querySelector('[data-testid="atlas-authored-arc"]')).toBeNull();
    const chip = el.querySelector('[data-testid="atlas-relation-chip"][data-relation="mentions"]');
    expect(chip?.getAttribute('aria-pressed')).toBe('false');

    await fire(chip, 'click');
    expect(el.querySelector('[data-testid="atlas-authored-arc"]')).toBeTruthy();
    expect(
      el
        .querySelector('[data-testid="atlas-relation-chip"][data-relation="mentions"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');

    await fire(
      el.querySelector('[data-testid="atlas-relation-chip"][data-relation="mentions"]'),
      'click',
    );
    expect(el.querySelector('[data-testid="atlas-authored-arc"]')).toBeNull();
  });

  it('shows the edge readout in the fixed side panel on hover', async () => {
    const el = await mountTab(makeGraph());
    const hit = el.querySelector(
      '[data-testid="atlas-edge-hit"][data-from="health_vital"][data-to="core_observation"]',
    );
    await fire(hit, 'mouseover');
    const readout = el.querySelector('[data-testid="atlas-readout"]');
    expect(readout?.textContent).toContain('core_observation');
    expect(readout?.textContent).toContain('41,230');
  });

  // ── Human-language layer ───────────────────────────────────────────────────
  it('node readout leads with the friendly name + blurb, keeping the SQL name', async () => {
    const el = await mountTab(makeGraph());
    // core_observation carries a curated friendly name + blurb in the fixture
    await fire(nodeEl(el, 'core_observation'), 'mouseover');
    const readout = el.querySelector('[data-testid="atlas-readout"]');
    // friendly title leads; physical name stays present (demoted to the mono sig)
    expect(readout?.textContent).toContain('Observations');
    expect(readout?.textContent).toContain('core_observation');
    // the curated blurb renders as the lead sentence
    expect(el.querySelector('[data-testid="atlas-node-blurb"]')?.textContent).toContain(
      'Point-in-time readings',
    );
  });

  it('a machinery kind with no blurb omits the blurb line cleanly', async () => {
    const el = await mountTab(makeGraph());
    // consent_device is machinery — only visible at standard (simple hides
    // plumbing), and it has neither a friendly override nor a blurb in the fixture
    await setLevel(el, 'standard');
    await fire(nodeEl(el, 'consent_device'), 'mouseover');
    expect(el.querySelector('[data-testid="atlas-node-blurb"]')).toBeNull();
    // it still reads its humanized label + physical name, never blank
    const readout = el.querySelector('[data-testid="atlas-readout"]');
    expect(readout?.textContent).toContain('consent_device');
  });

  it('edge readout speaks a plain sentence with friendly names, keeping physical names', async () => {
    const el = await mountTab(makeGraph());
    const hit = el.querySelector(
      '[data-testid="atlas-edge-hit"][data-from="health_vital"][data-to="core_observation"]',
    );
    await fire(hit, 'mouseover');
    const lede = el.querySelector('[data-testid="atlas-edge-lede"]');
    // the sentence uses friendly names on both ends…
    expect(lede?.textContent).toContain('Vitals');
    expect(lede?.textContent).toContain('Observations');
    expect(lede?.textContent).toContain('point to');
    // …and the mechanical detail keeps both physical table names + the count
    const readout = el.querySelector('[data-testid="atlas-readout"]');
    expect(readout?.textContent).toContain('health_vital');
    expect(readout?.textContent).toContain('core_observation');
    expect(readout?.textContent).toContain('41,230');
  });

  it('breadcrumb shows friendly names, not the SQL keys the trail holds', async () => {
    const el = await mountTab(makeGraph());
    await fire(nodeEl(el, 'core_observation'), 'click');
    const crumb = (physical: string): HTMLElement | null =>
      el.querySelector<HTMLElement>(`button[data-physical="${physical}"]`);
    expect(crumb('core_party')?.textContent).toBe('People');
    expect(crumb('core_observation')?.textContent).toBe('Observations');
    // the "Back to …" button also reads the friendly root name
    expect(el.querySelector('[data-testid="atlas-recenter"]')?.textContent).toContain('People');
  });

  // ── Sample rows ("A few of yours") ─────────────────────────────────────────
  it('renders up to three sample rows from an injected fetcher, honestly reduced', async () => {
    const rows = [
      { party_id: 'p1', display_name: 'Ada Lovelace' }, // preferred-named content
      { party_id: SEALED_SENTINEL, secret: SEALED_SENTINEL }, // fully sealed → sentinel
      { party_id: 'p3' }, // no content → primary key fallback
    ];
    const fetchSampleRows = (): Promise<Record<string, unknown>[]> => Promise.resolve(rows);
    const el = await mountTab(makeGraph(), { fetchSampleRows });
    await flush();
    const list = el.querySelector('[data-testid="atlas-samples"]');
    expect(list).toBeTruthy();
    expect(list?.textContent).toContain('Ada Lovelace');
    expect(list?.textContent).toContain(SEALED_SENTINEL);
    expect(list?.textContent).toContain('p3');
  });

  it('shows "Nothing here yet." when the centre table has no rows', async () => {
    const fetchSampleRows = (): Promise<Record<string, unknown>[]> => Promise.resolve([]);
    const el = await mountTab(makeGraph(), { fetchSampleRows });
    await flush();
    expect(el.querySelector('[data-testid="atlas-samples-empty"]')?.textContent).toContain(
      'Nothing here yet',
    );
  });

  it('omits the samples section entirely when the fetch fails (never invents)', async () => {
    const fetchSampleRows = (): Promise<Record<string, unknown>[]> =>
      Promise.reject(new Error('sealed vault'));
    const el = await mountTab(makeGraph(), { fetchSampleRows });
    await flush();
    expect(el.querySelector('[data-testid="atlas-samples"]')).toBeNull();
    expect(el.querySelector('[data-testid="atlas-samples-empty"]')).toBeNull();
  });

  it('renders no samples section at all when no fetcher is provided', async () => {
    const el = await mountTab(makeGraph());
    await flush();
    expect(el.querySelector('[data-testid="atlas-samples"]')).toBeNull();
    expect(el.querySelector('[data-testid="atlas-samples-empty"]')).toBeNull();
  });

  // ── Question chips ─────────────────────────────────────────────────────────
  it('question chips light a lens on the chart and clear on a second click', async () => {
    const el = await mountTab(makeGraph());
    // the "unused" lens lights consent_device (a target-only machinery kind);
    // machinery only shows at standard, so switch off the default simple lens
    await setLevel(el, 'standard');
    const cls = (p: string): string => nodeEl(el, p)?.getAttribute('class') ?? '';
    const chip = (q: string): HTMLElement | null =>
      el.querySelector<HTMLElement>(`[data-testid="atlas-question-chip"][data-q="${q}"]`);

    // connected — the centre's hop-1 neighbours lit, farther kinds dimmed
    await fire(chip('connected'), 'click');
    expect(chip('connected')?.getAttribute('aria-pressed')).toBe('true');
    expect(cls('core_observation')).toContain('nodeHot'); // 1 hop from core_party
    expect(cls('health_vital')).toContain('nodeDim'); // 2 hops
    // second click clears the lens
    await fire(chip('connected'), 'click');
    expect(chip('connected')?.getAttribute('aria-pressed')).toBe('false');
    expect(cls('health_vital')).not.toContain('nodeDim');

    // heaviest — the busiest kinds lit, a small one dimmed
    await fire(chip('heaviest'), 'click');
    expect(cls('core_observation')).toContain('nodeHot');
    expect(cls('knowledge_note')).toContain('nodeDim');
    await fire(chip('heaviest'), 'click'); // clear

    // unused — a target-only kind (unknown row count) lit, a populated kind dimmed
    await fire(chip('unused'), 'click');
    expect(cls('consent_device')).toContain('nodeHot');
    expect(cls('health_vital')).toContain('nodeDim');
  });

  // ── Pan/zoom camera ───────────────────────────────────────────────────────
  it('wraps every layer in one viewport group at identity by default', async () => {
    const el = await mountTab(makeGraph());
    // identity camera: no pan, unit scale
    expect(viewportTransform(el)).toBe('translate(0.000 0.000) scale(1.0000)');
    // the viewport carries the whole chart — nodes/edges live inside it
    const viewport = el.querySelector('[data-testid="atlas-viewport"]');
    expect(viewport?.querySelector('[data-testid="atlas-node"]')).toBeTruthy();
    expect(viewport?.querySelector('[data-testid="atlas-edge"]')).toBeTruthy();
  });

  it('zoom-in button scales the viewport up; reset restores identity', async () => {
    const el = await mountTab(makeGraph());
    expect(scaleOf(el)).toBe(1);

    await fire(el.querySelector('[data-testid="atlas-zoom-in"]'), 'click');
    expect(scaleOf(el)).toBeGreaterThan(1);

    await fire(el.querySelector('[data-testid="atlas-zoom-in"]'), 'click');
    const zoomed = scaleOf(el);
    expect(zoomed).toBeGreaterThan(1);

    await fire(el.querySelector('[data-testid="atlas-zoom-reset"]'), 'click');
    expect(viewportTransform(el)).toBe('translate(0.000 0.000) scale(1.0000)');
  });

  it('zoom-out button scales the viewport down', async () => {
    const el = await mountTab(makeGraph());
    await fire(el.querySelector('[data-testid="atlas-zoom-out"]'), 'click');
    expect(scaleOf(el)).toBeLessThan(1);
    expect(scaleOf(el)).toBeGreaterThanOrEqual(ZOOM_MIN);
  });

  it('re-centring on a node resets the camera to identity so travel lands framed', async () => {
    const el = await mountTab(makeGraph());
    await fire(el.querySelector('[data-testid="atlas-zoom-in"]'), 'click');
    expect(scaleOf(el)).toBeGreaterThan(1);

    await fire(nodeEl(el, 'core_observation'), 'click');
    // the centre travelled…
    expect(orreryCenter(el)).toBe('core_observation');
    // …and the camera snapped back to identity
    expect(viewportTransform(el)).toBe('translate(0.000 0.000) scale(1.0000)');
  });

  // ── Detail dial ─────────────────────────────────────────────────────────
  it('defaults to Simple, showing only kinds that provably carry data', async () => {
    // a bespoke slice: two populated ontology kinds, one empty ontology kind,
    // and one plumbing kind — Simple keeps only the two with data
    const g = makeGraph({
      nodes: [
        node('core_party', 'core', 'ontology', { friendly: 'People' }),
        node('core_observation', 'core', 'ontology', { friendly: 'Observations' }),
        node('knowledge_note', 'knowledge', 'ontology'),
        node('knowledge_tag', 'knowledge', 'ontology'), // empty: no rows, no live edge
        node('consent_device', 'consent', 'machinery'), // plumbing
      ],
      fkEdges: [
        edge('core_observation', 'subject_party_id', 'core_party', { childRows: 100, fill: 100 }),
        edge('knowledge_note', 'author_party_id', 'core_party', { childRows: 50, fill: 50 }),
      ],
      authoredLinks: [],
      island: [],
      edgeCount: 2,
      centerEdgeCount: 2,
      selfRefCount: 0,
    });
    const el = await mountTab(g);
    // the dial lands on simple by default
    expect(dialLevel(el)).toBe('simple');
    // kinds carrying data show…
    expect(nodeEl(el, 'core_observation')).toBeTruthy();
    expect(nodeEl(el, 'knowledge_note')).toBeTruthy();
    // …the provably-empty ontology kind and the machinery kind are hidden
    expect(nodeEl(el, 'knowledge_tag')).toBeNull();
    expect(nodeEl(el, 'consent_device')).toBeNull();
  });

  it('Everything reveals unreachable machinery and surfaces the physical SQL sublabels', async () => {
    const el = await mountTab(makeGraph());
    // at simple the island's plumbing is hidden and no SQL sublabels show
    expect(nodeEl(el, 'sync_connection')).toBeNull();
    expect(el.querySelector('[data-testid="atlas-node-physical"]')).toBeNull();

    await setLevel(el, 'everything');
    // the unreachable machinery (an island member) now renders…
    expect(nodeEl(el, 'sync_connection')).toBeTruthy();
    // …and every node carries its physical name as a demoted second label line
    const sub = nodeEl(el, 'knowledge_note')?.querySelector('[data-testid="atlas-node-physical"]');
    expect(sub?.textContent).toBe('knowledge_note');
  });

  it('turning the dial preserves the centre and the camera (no reframe)', async () => {
    const el = await mountTab(makeGraph());
    // travel to a new centre, then zoom in
    await fire(nodeEl(el, 'core_observation'), 'click');
    await fire(el.querySelector('[data-testid="atlas-zoom-in"]'), 'click');
    const cameraBefore = viewportTransform(el);
    expect(orreryCenter(el)).toBe('core_observation');
    expect(scaleOf(el)).toBeGreaterThan(1);

    await setLevel(el, 'everything');
    // the lens change moved neither the centre nor the camera
    expect(orreryCenter(el)).toBe('core_observation');
    expect(viewportTransform(el)).toBe(cameraBefore);
  });

  it('the caption tally reflects what each lens hides and updates with the dial', async () => {
    const el = await mountTab(makeGraph());
    const lens = (): string =>
      [...el.querySelectorAll('[data-testid="atlas-caption-lens"]')]
        .map((n) => n.textContent ?? '')
        .join(' | ');
    // simple hides the two plumbing kinds (consent_device, sync_connection) and
    // the three connections that touch them or are ghosts
    expect(lens()).toContain('2');
    expect(lens()).toContain('kinds hidden');
    expect(lens()).toContain('3');
    expect(lens()).toContain('connections hidden');

    // standard hides only the one unreachable plumbing kind and its one edge
    await setLevel(el, 'standard');
    expect(lens()).toContain('beyond reach');
    expect(lens()).not.toContain('empty or plumbing');

    // everything hides nothing, but names the plumbing it revealed
    await setLevel(el, 'everything');
    expect(lens()).toContain('now shown');
    expect(lens()).not.toContain('hidden');
  });
});
