// The duplicates shelf's render orchestrator (issue #352 phase 3) — same
// shape as toolbar.jsx: owns its own private state (the loaded clusters,
// which asset ids are checked) and renders into the SAME `gridRoot` the
// library/trash views use, since selecting the Duplicates chip swaps what
// `#grid` shows exactly the way selecting Trash already does (app.jsx's
// renderGrid()). Loaded lazily — the query walks up to 4000 live assets, so
// it only runs once the owner actually opens this shelf, not on every
// refresh() the way the (bounded, cheap) library window does.
import { DuplicatesView } from './components/Duplicates.jsx';
import { trashDuplicateAssets } from './duplicates-actions.js';

export function createDuplicates({ gridRoot, refresh }) {
  let clusters = null; // null = not yet loaded
  let loading = false;
  let limitation = null;
  const selected = new Set();

  function renderDuplicates() {
    gridRoot.render(
      <DuplicatesView
        clusters={clusters}
        loading={loading}
        limitation={limitation}
        selected={selected}
        onToggle={(assetId) => {
          if (selected.has(assetId)) selected.delete(assetId);
          else selected.add(assetId);
          renderDuplicates();
        }}
        onTrashSelected={async () => {
          const ids = [...selected];
          await trashDuplicateAssets(ids, { refresh });
          const trashedIds = new Set(ids);
          clusters = (clusters ?? [])
            .map((c) => ({ ...c, assets: c.assets.filter((a) => !trashedIds.has(a.asset_id)) }))
            .filter((c) => c.assets.length >= 2);
          selected.clear();
          renderDuplicates();
        }}
      />,
    );
  }

  // Called from renderGrid() every time the Duplicates chip is showing —
  // a no-op once loaded (or while a load is already in flight).
  async function ensureLoaded() {
    if (clusters != null || loading) return;
    loading = true;
    renderDuplicates();
    let data;
    try {
      data = await window.centraid.read({ query: 'duplicates', input: {} });
    } catch {
      data = null;
    }
    clusters = data?.clusters ?? [];
    limitation = data?.limitation ?? null;
    loading = false;
    renderDuplicates();
  }

  // Forces the next visit to re-fetch — called when leaving the shelf, so a
  // trash/upload done elsewhere doesn't leave a stale cluster list behind.
  function invalidate() {
    clusters = null;
    selected.clear();
  }

  return { ensureLoaded, renderDuplicates, invalidate };
}
