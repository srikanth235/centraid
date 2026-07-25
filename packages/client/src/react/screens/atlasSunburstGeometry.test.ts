import { describe, expect, it } from 'vitest';
import {
  LABEL_MAX_CHARS,
  SUNBURST,
  buildDomains,
  findKind,
  kindsByPhysical,
  labelMode,
  labelPlacement,
  labelRadius,
  neighboursOf,
  assignHues,
  toneMix,
  TONE_SWEEP,
  PALETTE_HUES,
  MACHINERY_HUE,
  reachRadius,
  ringBounds,
  ringItems,
  sectorPath,
  truncateLabel,
  visibleDomains,
  wedgeAngles,
} from './atlasSunburstGeometry.js';
import { edge, makeGraph, makeStats } from './atlasRelationsTestKit.js';

// Pure geometry + hierarchy rules for the Map (issue #519 follow-on). These
// pin the invariant the whole redesign rests on: presence is categorical,
// quantity is radial. Nothing here may ever return "fewer items because they
// are empty".

describe('wedgeAngles — equal spans', () => {
  it('gives every child an identical span whatever the count', () => {
    for (const count of [1, 2, 5, 12, 21]) {
      const spans = Array.from({ length: count }, (_, i) => {
        const a = wedgeAngles(i, count);
        return Number((a.end - a.start).toFixed(6));
      });
      expect(new Set(spans).size).toBe(1);
    }
  });

  it('gives a one-kind domain the whole circle, not a sliver', () => {
    const a = wedgeAngles(0, 1);
    expect(a.end - a.start).toBe(360);
  });

  it('starts at 12 o’clock and runs clockwise', () => {
    expect(wedgeAngles(0, 4).mid).toBeCloseTo(-45, 5);
    expect(wedgeAngles(1, 4).mid).toBeCloseTo(45, 5);
  });

  it('separates neighbours by a hairline only — no wedge overlaps another', () => {
    const count = 7;
    for (let i = 0; i < count - 1; i += 1) {
      const gap = wedgeAngles(i + 1, count).start - wedgeAngles(i, count).end;
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeLessThan(3.3); // 2 × the 1.6° pad ceiling, plus float slack
    }
  });
});

describe('reachRadius — quantity is radial, never presence', () => {
  it('puts an empty wedge at the floor, never at zero', () => {
    expect(reachRadius(0, 44902)).toBe(SUNBURST.ringFloor);
    expect(reachRadius(0, 0)).toBe(SUNBURST.ringFloor);
  });

  it('never returns less than the floor for any row count', () => {
    for (const rows of [0, 1, 10, 1000, 44902]) {
      expect(reachRadius(rows, 44902)).toBeGreaterThanOrEqual(SUNBURST.ringFloor);
    }
  });

  it('grows monotonically with rows and tops out at the outer ring', () => {
    const a = reachRadius(10, 44902);
    const b = reachRadius(1000, 44902);
    const c = reachRadius(44902, 44902);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    expect(c).toBeCloseTo(SUNBURST.ringOut, 1);
  });

  it('separates a one-row wedge from an empty one — "some" never reads as "none"', () => {
    expect(reachRadius(1, 44902)).toBeGreaterThan(reachRadius(0, 44902));
  });
});

describe('sectorPath', () => {
  it('draws a normal wedge as a single closed sector', () => {
    const d = sectorPath(-90, -30, 76, 190);
    expect(d.startsWith('M')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
    expect(d).toContain('A');
  });

  it('draws a full-circle child as a two-ring annulus, not a degenerate arc', () => {
    const d = sectorPath(-90, 270, 76, 190);
    // two subpaths, counter-wound, so the hole punches through
    expect(d.match(/M/g)?.length).toBe(2);
    expect(d).toContain('0 1 1');
    expect(d).toContain('0 1 0');
  });
});

describe('labelPlacement', () => {
  it('anchors text away from the ring on both sides', () => {
    expect(labelPlacement(0, 206, 'upright').anchor).toBe('start');
    expect(labelPlacement(180, 206, 'upright').anchor).toBe('end');
  });

  it('never rotates an upright label — that is the whole point of the mode', () => {
    for (const deg of [-90, 0, 90, 180]) {
      expect(labelPlacement(deg, 206, 'upright').rotate).toBe(0);
    }
  });

  it('flips a radial label on the left half so it still reads left-to-right', () => {
    expect(labelPlacement(0, 206, 'radial').rotate).toBe(0);
    expect(labelPlacement(180, 206, 'radial').rotate).toBe(360);
  });
});

describe('labelRadius', () => {
  it('sits a label just outside its OWN wedge, not at a fixed rim', () => {
    const empty = labelRadius(reachRadius(0, 44902));
    const full = labelRadius(reachRadius(44902, 44902));
    expect(empty).toBeLessThan(full);
    expect(empty - SUNBURST.ringFloor).toBe(SUNBURST.labelGap);
  });
});

describe('ringBounds — the ring yields when labels radiate', () => {
  it('shrinks the ring in radial mode so outward labels have room', () => {
    expect(ringBounds('radial').out).toBeLessThan(ringBounds('upright').out);
    expect(ringBounds('radial').floor).toBeLessThan(ringBounds('upright').floor);
  });

  it('keeps the floor clear of the centre plate in both modes', () => {
    for (const mode of ['upright', 'radial'] as const) {
      expect(ringBounds(mode).floor).toBeGreaterThan(SUNBURST.ringIn);
      expect(ringBounds(mode).out).toBeGreaterThan(ringBounds(mode).floor);
    }
  });

  it('leaves a longest label inside the canvas in radial mode', () => {
    // The label starts here and runs outward; it must not overrun the edge.
    const start = labelRadius(ringBounds('radial').out);
    const widestChars = LABEL_MAX_CHARS * 6.2; // ~6.2 viewBox units per char at 10.5px
    expect(start + widestChars).toBeLessThan(SUNBURST.view / 2);
  });

  it('still floors an empty wedge in radial mode', () => {
    expect(reachRadius(0, 88317, 'radial')).toBe(ringBounds('radial').floor);
  });
});

describe('truncateLabel', () => {
  it('leaves a name that fits completely alone', () => {
    expect(truncateLabel('Observations')).toBe('Observations');
  });

  it('ellipsises only what would overrun, never mid-word padding', () => {
    const out = truncateLabel('observation component');
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(LABEL_MAX_CHARS);
  });
});

describe('labelMode', () => {
  it('sets labels flat while there is room to keep them flat', () => {
    expect(labelMode(5)).toBe('upright');
    expect(labelMode(12)).toBe('upright');
  });

  it('rotates labels only once flat ones would collide', () => {
    expect(labelMode(13)).toBe('radial');
    expect(labelMode(21)).toBe('radial');
  });
});

describe('assignHues', () => {
  const onto = (...names: string[]) =>
    names.map((pack) => ({ pack, packKind: 'ontology' as const }));

  it('assigns tokens, never hexes, and repeats deterministically', () => {
    const a = assignHues(onto('core', 'health', 'knowledge'));
    const b = assignHues(onto('core', 'health', 'knowledge'));
    for (const p of ['core', 'health', 'knowledge']) {
      expect(a.get(p)?.hue).toMatch(/^var\(--c-[a-z]+\)$/);
      expect(a.get(p)).toEqual(b.get(p));
    }
  });

  it('never gives two adjacent domains the same hue', () => {
    const packs = onto(...Array.from({ length: 12 }, (_, i) => `p${i}`));
    const hues = assignHues(packs);
    for (let i = 1; i < packs.length; i++) {
      const prev = hues.get(`p${i - 1}`)?.hue;
      expect(hues.get(`p${i}`)?.hue).not.toBe(prev);
    }
  });

  // The whole point of reordering PALETTE_HUES: the declaration order put the
  // two browns three slots apart and spent a slot on grey.
  it('keeps the two browns apart and keeps grey out of the chromatic ramp', () => {
    expect(PALETTE_HUES).not.toContain(MACHINERY_HUE);
    const amber = PALETTE_HUES.indexOf('amber');
    const ochre = PALETTE_HUES.indexOf('ochre');
    expect(Math.abs(amber - ochre)).toBeGreaterThan(1);
  });

  it('paints every machinery band grey and does not spend a chromatic slot', () => {
    const hues = assignHues([
      { pack: 'core', packKind: 'ontology' },
      { pack: 'consent', packKind: 'machinery' },
      { pack: 'health', packKind: 'ontology' },
    ]);
    expect(hues.get('consent')).toEqual({
      hue: `var(--c-${MACHINERY_HUE})`,
      hue2: `var(--c-${MACHINERY_HUE})`,
    });
    // health takes chromatic slot 1, exactly as if consent were not there
    expect(hues.get('health')?.hue).toBe(assignHues(onto('core', 'health')).get('health')?.hue);
  });

  it('gives each domain a second hue to sweep toward', () => {
    const hues = assignHues(onto('core'));
    expect(hues.get('core')?.hue2).not.toBe(hues.get('core')?.hue);
  });
});

describe('toneMix — the sweep inside one domain', () => {
  it('leaves the first sibling on the domain hue and never fully reaches the next', () => {
    expect(toneMix(0, 21)).toBe('100%');
    expect(Number.parseFloat(toneMix(20, 21))).toBeCloseTo(100 - TONE_SWEEP, 5);
  });

  it('moves monotonically along the ramp', () => {
    const vals = Array.from({ length: 8 }, (_, i) => Number.parseFloat(toneMix(i, 8)));
    for (let i = 1; i < vals.length; i++)
      expect(vals[i] as number).toBeLessThan(vals[i - 1] as number);
  });

  it('keeps a lone sibling on the pure domain hue', () => {
    expect(toneMix(0, 1)).toBe('100%');
  });
});

describe('buildDomains — census joined with graph', () => {
  it('takes row counts from the census, which is the only exact source', () => {
    const domains = buildDomains(makeStats(), makeGraph());
    const core = domains.find((d) => d.pack === 'core');
    expect(core?.rows).toBe(214 + 44902 + 342);
    expect(core?.kinds.find((k) => k.logical === 'core.party')?.rows).toBe(214);
  });

  it('prefers the curated friendly name when the graph supplies one', () => {
    const domains = buildDomains(makeStats(), makeGraph());
    const party = findKind(domains, 'core.party');
    expect(party?.kind.name).toBe('People');
    expect(party?.kind.blurb).toBe('Everyone your vault knows about.');
  });

  it('falls back to the census label and NO blurb when the graph is absent', () => {
    const domains = buildDomains(makeStats(), null);
    const party = findKind(domains, 'core.party');
    expect(party?.kind.name).toBe('party');
    expect(party?.kind.blurb).toBe('');
  });

  it('keeps kinds the graph never mentions — the census is the hierarchy', () => {
    const domains = buildDomains(makeStats(), makeGraph());
    expect(findKind(domains, 'business.client')?.kind.rows).toBe(0);
  });

  it('renders every domain, including the ones holding nothing at all', () => {
    const domains = buildDomains(makeStats(), makeGraph());
    const empty = domains.filter((d) => d.rows === 0).map((d) => d.pack);
    expect(empty).toContain('locker');
    expect(empty).toContain('business');
  });
});

describe('visibleDomains — the switch only ever adds', () => {
  it('shows ontology alone when plumbing is off', () => {
    const domains = buildDomains(makeStats(), makeGraph());
    const packs = visibleDomains(domains, false).map((d) => d.pack);
    expect(packs).toEqual(['core', 'health', 'knowledge', 'locker', 'business']);
  });

  it('adds machinery without removing anything when plumbing is on', () => {
    const domains = buildDomains(makeStats(), makeGraph());
    const off = visibleDomains(domains, false).map((d) => d.pack);
    const on = visibleDomains(domains, true).map((d) => d.pack);
    expect(on).toEqual(expect.arrayContaining(off));
    expect(on.length).toBeGreaterThan(off.length);
  });

  it('never drops a domain for being empty', () => {
    const domains = buildDomains(makeStats(), makeGraph());
    expect(visibleDomains(domains, false).map((d) => d.pack)).toContain('locker');
  });
});

describe('ringItems — the rung’s children', () => {
  it('lists every visible domain at the root, empties included', () => {
    const domains = buildDomains(makeStats(), makeGraph());
    const ids = ringItems(domains, false, null).map((i) => i.id);
    expect(ids).toContain('locker');
    expect(ids).toContain('business');
  });

  it('marks an empty domain as empty rather than omitting it', () => {
    const domains = buildDomains(makeStats(), makeGraph());
    const locker = ringItems(domains, false, null).find((i) => i.id === 'locker');
    expect(locker?.empty).toBe(true);
    expect(locker?.rows).toBe(0);
  });

  it('lists every kind of a focused domain, empties included', () => {
    const domains = buildDomains(makeStats(), makeGraph());
    const ids = ringItems(domains, false, 'business').map((i) => i.id);
    expect(ids).toEqual(['business.client', 'business.invoice']);
  });

  it('lists a focused machinery domain’s kinds even with plumbing off', () => {
    const domains = buildDomains(makeStats(), makeGraph());
    expect(ringItems(domains, false, 'consent').map((i) => i.id)).toEqual(['consent.device']);
  });

  it('counts kinds in the domain detail line', () => {
    const domains = buildDomains(makeStats(), makeGraph());
    const items = ringItems(domains, false, null);
    expect(items.find((i) => i.id === 'locker')?.detail).toBe('1 kind');
    expect(items.find((i) => i.id === 'business')?.detail).toBe('2 kinds');
  });
});

describe('neighboursOf — the FK graph as a walkable list', () => {
  const domains = buildDomains(makeStats(), makeGraph());
  const byPhysical = kindsByPhysical(domains);
  const edges = makeGraph().fkEdges;

  it('finds neighbours in both directions', () => {
    const names = neighboursOf(edges, 'core_party', byPhysical).map((k) => k.logical);
    expect(names).toContain('core.observation');
    expect(names).toContain('knowledge.note');
    expect(names).toContain('locker.item');
  });

  it('never lists a kind as its own neighbour, self-reference or not', () => {
    const names = neighboursOf(edges, 'core_concept', byPhysical).map((k) => k.logical);
    expect(names).not.toContain('core.concept');
  });

  it('lists an empty kind’s real joins — emptiness is not disconnection', () => {
    const names = neighboursOf(edges, 'locker_item', byPhysical).map((k) => k.logical);
    expect(names).toEqual(expect.arrayContaining(['core.party', 'sync.connection']));
  });

  it('de-duplicates a pair joined by more than one column', () => {
    const doubled = [
      ...edges,
      edge('knowledge_note', 'second_party_id', 'core_party', { childRows: 742, fill: 12 }),
    ];
    const names = neighboursOf(doubled, 'knowledge_note', byPhysical).map((k) => k.logical);
    expect(names.filter((n) => n === 'core.party')).toHaveLength(1);
  });

  it('sorts fullest first, so the useful hop leads', () => {
    const rows = neighboursOf(edges, 'core_party', byPhysical).map((k) => k.rows);
    expect(rows).toEqual([...rows].sort((a, b) => b - a));
  });

  it('skips an edge into a table the census does not carry, never guesses', () => {
    const stray = [edge('core_party', 'ghost_id', 'not_a_table', {})];
    expect(neighboursOf(stray, 'core_party', byPhysical)).toEqual([]);
  });
});
