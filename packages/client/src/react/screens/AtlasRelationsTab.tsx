import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import type { AtlasCensusPayload, AtlasGraphPayload } from '../../gateway-client.js';
import Icon from '../ui/Icon.js';
import AtlasKindDetail from './AtlasKindDetail.js';
import AtlasSunburstChart from './AtlasSunburstChart.js';
import AtlasSunburstList from './AtlasSunburstList.js';
import { useSampleRows, type SampleRowsFetcher } from './atlasSampleRows.js';
import {
  buildDomains,
  findKind,
  kindsByPhysical,
  neighboursOf,
  ringItems,
  visibleDomains,
} from './atlasSunburstGeometry.js';
import styles from './AtlasRelationsTab.module.css';

// The Map tab (issue #441 B2, rebuilt for #519's follow-on). A hierarchical
// sunburst over the vault's own shape: Vault → Domain → Kind.
//
// This replaces the flat orrery, which drew all ~86 kinds at once and then used
// a Simple/Standard/Everything dial to thin them out. That dial hid any kind
// that could not prove it held rows, and all machinery outright — so a domain
// like Locker (one kind) or Business (five empty ones) kept its name on the
// bezel while every clickable node inside it disappeared. You could read a
// domain and never reach it.
//
// The rule here is the opposite, and it is enforced in atlasSunburstGeometry:
// EVERY domain and EVERY kind is always drawn and always selectable. Emptiness
// changes how a wedge looks, never whether it exists. The only control that
// removes anything is the explicit Plumbing switch, and it only ever adds.
//
// Row counts come from the CENSUS (exact per-table counts, already fetched for
// the Kinds tab); the graph payload is an enhancement supplying curated names
// and the FK neighbours behind "Connects to". A missing graph degrades to
// mechanical labels and no neighbour list — it never blocks the map.

export interface AtlasRelationsTabProps {
  /** `/_vault/atlas/stats` — the hierarchy and every row count. Required: with
   *  no census there is nothing honest to draw. */
  stats: AtlasCensusPayload | null;
  /** `/_vault/atlas/graph` — friendly names + FK neighbours. Enhancement only. */
  graph: AtlasGraphPayload | null;
  /** Fetch a few real rows of a kind for the detail rail. Optional. */
  fetchSampleRows?: SampleRowsFetcher;
  /** Open the Browse tab preselected to a kind — the ladder's last rung. */
  onOpenBrowse: (logical: string) => void;
}

const fmt = (n: number): string => n.toLocaleString('en-US');

export default function AtlasRelationsTab({
  stats,
  graph,
  fetchSampleRows,
  onOpenBrowse,
}: AtlasRelationsTabProps): JSX.Element {
  // ── Rung state ──────────────────────────────────────────────────────────
  // `focus` is the domain you have drilled into (null at the root); `selected`
  // is the kind whose detail rail is open. Two rungs of state, no camera, no
  // lens stack — turning nothing on can ever make something unreachable.
  const [focus, setFocus] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [plumbing, setPlumbing] = useState(false);
  const [hot, setHot] = useState<string | null>(null);

  const domains = useMemo(() => (stats ? buildDomains(stats, graph) : []), [stats, graph]);
  const byPhysical = useMemo(() => kindsByPhysical(domains), [domains]);
  const shownDomains = useMemo(() => visibleDomains(domains, plumbing), [domains, plumbing]);

  // A fresh census re-seats the map at the root rather than stranding the view
  // on a domain the new payload may not carry.
  useEffect(() => {
    setFocus(null);
    setSelected(null);
    setHot(null);
  }, [stats]);

  const items = useMemo(() => ringItems(domains, plumbing, focus), [domains, plumbing, focus]);
  const focusDomain = useMemo(
    () => (focus === null ? null : (domains.find((d) => d.pack === focus) ?? null)),
    [domains, focus],
  );

  const selectedKind = useMemo(
    () => (selected === null ? null : findKind(domains, selected)),
    [domains, selected],
  );

  const neighbours = useMemo(() => {
    if (!selectedKind || !graph) return [];
    return neighboursOf(graph.fkEdges, selectedKind.kind.physical, byPhysical);
  }, [selectedKind, graph, byPhysical]);

  const sample = useSampleRows(selectedKind?.kind.logical, fetchSampleRows);

  // ── Navigation ──────────────────────────────────────────────────────────
  // A domain id has no dot; a kind id is a logical `schema.table`. One handler
  // serves the ring and the list, so both always agree about what a click does.
  const activate = useCallback(
    (id: string) => {
      if (!id.includes('.')) {
        setFocus(id);
        setSelected(null);
        return;
      }
      const found = findKind(domains, id);
      if (!found) return;
      // Following a connection into machinery turns the Plumbing switch ON
      // rather than dropping you inside a domain the rest of the page says is
      // not there. Navigation may widen what is shown; it never narrows it.
      if (found.domain.packKind === 'machinery') setPlumbing(true);
      setFocus(found.domain.pack);
      setSelected(id);
    },
    [domains],
  );

  const toRoot = useCallback(() => {
    setFocus(null);
    setSelected(null);
    setHot(null);
  }, []);

  const onBezel = useCallback((pack: string) => {
    setFocus((prev) => (prev === pack ? null : pack));
    setSelected(null);
  }, []);

  const togglePlumbing = useCallback(() => {
    setPlumbing((prev) => {
      const next = !prev;
      // Switching plumbing off while standing inside a machinery domain walks
      // back to the root instead of leaving you on a rung that no longer shows.
      if (!next && focusDomain?.packKind === 'machinery') {
        setFocus(null);
        setSelected(null);
      }
      return next;
    });
  }, [focusDomain]);

  // ── Empty state ─────────────────────────────────────────────────────────
  if (!stats) {
    return (
      <div className={styles.empty} data-testid="atlas-relations-empty">
        <span className={styles.emptyIcon}>
          <Icon name="Compass" size={22} />
        </span>
        <p className={styles.emptyText}>
          The map hasn’t loaded. It shows every domain your vault can hold and how much is in each.
        </p>
      </div>
    );
  }

  const totalRows = focusDomain
    ? focusDomain.rows
    : shownDomains.reduce((sum, d) => sum + d.rows, 0);
  const shownKinds = shownDomains.reduce((sum, d) => sum + d.kinds.length, 0);
  const filledKinds = shownDomains.reduce(
    (sum, d) => sum + d.kinds.filter((k) => k.rows > 0).length,
    0,
  );
  const hiddenDomains = domains.length - shownDomains.length;

  return (
    <div className={styles.tab}>
      <div className={styles.head}>
        <nav className={styles.crumbs} aria-label="Breadcrumb">
          <button
            type="button"
            className={styles.crumb}
            aria-current={focusDomain ? undefined : 'page'}
            data-testid="atlas-crumb-root"
            onClick={toRoot}
          >
            Vault
          </button>
          {focusDomain ? (
            <>
              <span className={styles.crumbSep}>/</span>
              <button
                type="button"
                className={styles.crumb}
                aria-current="page"
                data-testid="atlas-crumb-domain"
              >
                {focusDomain.label}
              </button>
            </>
          ) : null}
        </nav>

        {/* The one control on this page. It ADDS the machinery domains; there is
            deliberately no switch that can take an ontology domain away. */}
        <button
          type="button"
          className={styles.plumbing}
          aria-pressed={plumbing}
          data-testid="atlas-plumbing"
          onClick={togglePlumbing}
        >
          <span className={styles.plumbingSwitch} />
          Plumbing
        </button>
      </div>

      <div className={styles.stage} data-detail={selectedKind ? 'true' : 'false'}>
        <div className={styles.ringWrap}>
          <AtlasSunburstChart
            items={items}
            bezelDomains={shownDomains}
            focus={focus}
            focusLabel={focusDomain?.label ?? null}
            totalRows={totalRows}
            hot={hot}
            selected={selected}
            onActivate={activate}
            onHot={setHot}
            onUp={toRoot}
            onBezel={onBezel}
          />
        </div>

        <AtlasSunburstList
          heading={focusDomain ? `${focusDomain.label} · kinds` : 'Domains'}
          items={items}
          hot={hot}
          selected={selected}
          onActivate={activate}
          onHot={setHot}
        />

        {selectedKind ? (
          <AtlasKindDetail
            domain={selectedKind.domain}
            kind={selectedKind.kind}
            neighbours={neighbours}
            graphKnown={graph !== null}
            sample={sample}
            onClose={() => setSelected(null)}
            onGoto={activate}
            onOpenBrowse={onOpenBrowse}
          />
        ) : null}
      </div>

      {/* Measured-fact caption. Every number is derived from the census, and the
          first line is the claim this redesign has to keep making true. */}
      <div className={styles.caption} data-testid="atlas-caption">
        <span className={styles.captionItem}>
          <b className={styles.captionNum}>{fmt(shownDomains.length)}</b> domains, every one on the
          ring
        </span>
        <span className={styles.captionItem}>
          <b className={styles.captionNum}>{fmt(shownKinds)}</b> kinds, {fmt(filledKinds)} with
          something in them
        </span>
        <span className={styles.captionItem}>
          <b className={styles.captionNum}>{fmt(totalRows)}</b> records
          {focusDomain ? ` in ${focusDomain.label}` : ' in total'}
        </span>
        {hiddenDomains > 0 ? (
          <span className={styles.captionItem} data-testid="atlas-caption-plumbing">
            <b className={styles.captionNum}>{fmt(hiddenDomains)}</b> plumbing domains behind the
            switch
          </span>
        ) : null}
      </div>
    </div>
  );
}
