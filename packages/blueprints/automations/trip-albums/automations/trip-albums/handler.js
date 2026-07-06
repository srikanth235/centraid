/**
 * Trip albums (issue #299 phase 3) — the deterministic clusterer.
 *
 * No model turns at all (issue #290 doctrine: agents write code, not
 * data — and clustering is code): photos captured within GAP_HOURS of
 * each other belong to one run; a run spanning at least MIN_DAYS days
 * with at least MIN_PHOTOS photos is a trip. Each trip stages a
 * core.collection proposal named by its dates — publishing is the
 * owner's review click, and the collection publisher tops up without
 * ever removing what the owner curated.
 *
 * Deterministic: names and external ids derive from capture dates, the
 * clustering is a pure function of captured_at, and re-runs re-stage the
 * same proposals (the spine's content hash skips unchanged ones).
 */

const GAP_HOURS = 36;
const MIN_PHOTOS = 5;
const MIN_DAYS = 2;
const WINDOW = 2000;
const PURPOSE = 'dpv:ServiceProvision';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function tripName(startIso, endIso) {
  const s = new Date(startIso);
  const e = new Date(endIso);
  const sm = MONTHS[s.getUTCMonth()];
  const em = MONTHS[e.getUTCMonth()];
  const year = e.getUTCFullYear();
  if (sm === em && s.getUTCFullYear() === year) {
    return `Trip · ${sm} ${s.getUTCDate()}–${e.getUTCDate()}, ${year}`;
  }
  return `Trip · ${sm} ${s.getUTCDate()} – ${em} ${e.getUTCDate()}, ${year}`;
}

export default async ({ ctx, log }) => {
  const read = await ctx.vault.read({
    entity: 'media.media_asset',
    where: [
      { column: 'deleted_at', op: 'is-null' },
      { column: 'captured_at', op: 'not-null' },
    ],
    orderBy: { column: 'captured_at', dir: 'asc' },
    limit: WINDOW,
    purpose: PURPOSE,
  });
  const photos = (read.rows ?? []).filter((a) => a.kind === 'photo');
  if (photos.length < MIN_PHOTOS) return { summary: 'not enough dated photos to cluster' };

  // Single pass: a gap over GAP_HOURS closes the current run.
  const runs = [];
  let run = [photos[0]];
  for (let i = 1; i < photos.length; i += 1) {
    const prev = new Date(photos[i - 1].captured_at).getTime();
    const curr = new Date(photos[i].captured_at).getTime();
    if (curr - prev > GAP_HOURS * 3600 * 1000) {
      runs.push(run);
      run = [];
    }
    run.push(photos[i]);
  }
  runs.push(run);

  const rows = [];
  for (const cluster of runs) {
    if (cluster.length < MIN_PHOTOS) continue;
    const start = cluster[0].captured_at;
    const end = cluster[cluster.length - 1].captured_at;
    const spanDays = (new Date(end).getTime() - new Date(start).getTime()) / 86400000;
    if (spanDays < MIN_DAYS) continue;
    rows.push({
      entity_type: 'core.collection',
      external_id: `trip:${String(start).slice(0, 10)}`,
      payload: {
        name: tripName(start, end),
        members: cluster.map((a) => ({ target_type: 'media.media_asset', target_id: a.asset_id })),
      },
    });
  }

  if (rows.length === 0) return { summary: 'no trip-shaped clusters found' };
  // Album proposals ALWAYS stage — the review click publishes.
  const staged = await ctx.vault.invoke({
    command: 'sync.stage_rows',
    input: { kind: 'enrichment.cluster', label: 'trips', rows },
    purpose: PURPOSE,
  });
  const counts = staged?.output?.staged;
  log.info(`proposed ${rows.length} trip album(s)${counts ? ` (${counts.skip} unchanged)` : ''}`);
  return {
    summary: `proposed ${rows.length} trip album(s) — awaiting your review`,
    output: { trips: rows.length },
  };
};
