// The duplicates shelf (issue #352 / #299's deferred duplicates shelf): one
// card per cluster, its assets laid out side by side so the owner can eyeball
// which copy to keep, checkbox-select the redundant ones, and trash them in
// one batch. Pure view — `duplicates.jsx` (the app-root orchestrator) owns
// the load/selection state and passes it down, same split as toolbar.jsx/
// Chips.jsx.
import { fmtBytes } from '../kit.js';
import { mountMedia } from '../media.js';
import { armConfirm } from '../kit.js';

function ClusterTile({ asset, checked, onToggle }) {
  return (
    <label className="dup-tile">
      <div className="dup-tile-media" ref={(el) => mountMedia(el, asset)}></div>
      <input
        type="checkbox"
        checked={checked}
        onChange={() => onToggle(asset.asset_id)}
        aria-label={`Select ${asset.title ?? 'photo'} to trash`}
      />
      <span className="dup-tile-meta">
        {[
          asset.width && asset.height ? `${asset.width}×${asset.height}` : null,
          fmtBytes(asset.byte_size),
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>
    </label>
  );
}

function ClusterCard({ cluster, selected, onToggle }) {
  return (
    <div className="dup-cluster">
      <p className="dup-cluster-label kit-muted kit-small">
        {cluster.tier === 'exact' ? 'Identical bytes' : 'Same dimensions & size'} ·{' '}
        {cluster.assets.length} copies
      </p>
      <div className="dup-cluster-row">
        {cluster.assets.map((asset) => (
          <ClusterTile
            key={asset.asset_id}
            asset={asset}
            checked={selected.has(asset.asset_id)}
            onToggle={onToggle}
          />
        ))}
      </div>
    </div>
  );
}

export function DuplicatesView({ clusters, loading, limitation, selected, onToggle, onTrashSelected }) {
  if (clusters == null || loading) {
    return <kit-skeleton rows={4}></kit-skeleton>;
  }
  return (
    <div className="dup-shelf">
      <div className="dup-shelf-head">
        <p className="kit-muted">
          {clusters.length === 0
            ? 'No duplicates found — nice and tidy.'
            : 'Photos that look like the same shot, uploaded more than once. Nothing is trashed until you say so.'}
        </p>
        {limitation === 'phash-unreachable' && clusters.length > 0 ? (
          <p className="kit-muted kit-small dup-note">
            Grouped by matching dimensions and file size — the closest signal available here, not
            a true visual match.
          </p>
        ) : null}
      </div>
      {clusters.length > 0 ? (
        <>
          <div className="dup-actions">
            <span className="dup-count">
              {selected.size === 0 ? 'Select copies to trash' : `${selected.size} selected`}
            </span>
            <button
              type="button"
              className="kit-btn danger"
              disabled={selected.size === 0}
              onClick={(e) => {
                if (selected.size === 0) return;
                if (!armConfirm(e.currentTarget, { armedLabel: `Trash ${selected.size}?` })) return;
                onTrashSelected();
              }}
            >
              Trash selected
            </button>
          </div>
          {clusters.map((cluster) => (
            <ClusterCard key={cluster.key} cluster={cluster} selected={selected} onToggle={onToggle} />
          ))}
        </>
      ) : null}
    </div>
  );
}
