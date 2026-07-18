// The duplicates shelf (issue #352 / #299's deferred duplicates shelf): one
// card per cluster, its assets laid out side by side so the owner can eyeball
// which copy to keep, checkbox-select the redundant ones, and trash them in
// one batch. Pure view — `duplicates.tsx` (the app-root orchestrator) owns
// the load/selection state and passes it down, same split as toolbar.jsx/
// Chips.jsx.
import { fmtBytes } from '../kit.js';
import { mountMedia } from '../media.ts';
import { armConfirm } from '../kit.js';
import type { FC } from '../react-core.min.js';
import type { Asset, DuplicateCluster } from '../types.ts';
import styles from './Duplicates.module.css';

// The genuine <kit-skeleton> custom element, rendered as ordinary JSX — the
// runtime value stays the string 'kit-skeleton', so the emitted DOM is
// identical (pilot custom-element pattern).
const KitSkeleton = 'kit-skeleton' as unknown as FC<{ rows?: number }>;

function ClusterTile({
  asset,
  checked,
  onToggle,
}: {
  asset: Asset;
  checked: boolean;
  onToggle: (assetId: string) => void;
}) {
  return (
    <label className={styles.tile}>
      <div className={styles.tileMedia} ref={(el) => mountMedia(el, asset)}></div>
      <input
        type="checkbox"
        checked={checked}
        onChange={() => onToggle(asset.asset_id)}
        aria-label={`Select ${asset.title ?? 'photo'} to trash`}
      />
      <span className={styles.tileMeta}>
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

function ClusterCard({
  cluster,
  selected,
  onToggle,
}: {
  cluster: DuplicateCluster;
  selected: Set<string>;
  onToggle: (assetId: string) => void;
}) {
  return (
    <div className={styles.cluster}>
      <p className={`${styles.clusterLabel} kit-muted kit-small`}>
        Look like the same shot · {cluster.assets.length} copies
      </p>
      <div className={styles.clusterRow}>
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

export function DuplicatesView({
  clusters,
  loading,
  selected,
  onToggle,
  onTrashSelected,
}: {
  clusters: DuplicateCluster[] | null;
  loading: boolean;
  selected: Set<string>;
  onToggle: (assetId: string) => void;
  onTrashSelected: () => void;
}) {
  if (clusters == null || loading) {
    return <KitSkeleton rows={4} />;
  }
  return (
    <div className={styles.shelf}>
      <div className={styles.shelfHead}>
        <p className="kit-muted">
          {clusters.length === 0
            ? 'No duplicates found — nice and tidy.'
            : 'Photos that look like the same shot, grouped by visual similarity (issue #352). Nothing is trashed until you say so.'}
        </p>
      </div>
      {clusters.length > 0 ? (
        <>
          <div className={styles.actions}>
            <span className={styles.count}>
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
            <ClusterCard
              key={cluster.key}
              cluster={cluster}
              selected={selected}
              onToggle={onToggle}
            />
          ))}
        </>
      ) : null}
    </div>
  );
}
