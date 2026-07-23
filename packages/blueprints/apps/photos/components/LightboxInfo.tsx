// The lightbox's right-side info panel (bottom sheet on phone): editable
// caption, an EXIF-extended Details grid, the real editable place picker,
// custody/backup status, People chips (faces), Album chips, free-form Tag
// chips, and an honest Activity list. All the issue #352 write flows
// (caption/capture-time/place/tags/albums/faces) that used to live in
// components/Lightbox.jsx's PanelBody now live here — split out purely for
// file-size budget as the v2 redesign grew this region (governance's
// 500-line cap), not a behavior change.
// CSS split: own bits in LightboxInfo.module.css; `.ph-faces` (faces.ts's
// imperative host) + `lightbox-note`/`kit-*` stay global strings.
import { armConfirm, toast } from '../kit.ts';
import { restoreAsset } from '../assets-actions.ts';
import { buildActivity } from '../activity.ts';
import { renderFaces } from '../faces.ts';
import { custodyMeta, exifRows, toLocalInputValue } from '../format.ts';
import { act, narrate } from '../outcomes.ts';
import { useEffect, useRef, useState } from 'react';
import type { Album, Asset, CustodyMeta, Place } from '../types.ts';
import styles from './LightboxInfo.module.css';

// Explicit tone → module-class map (never a computed `styles['custody-' + tone]`).
const custodyCls: Record<CustodyMeta['tone'], string | undefined> = {
  ok: styles.custodyOk,
  warn: styles.custodyWarn,
  danger: styles.custodyDanger,
};

function DetailsGrid({ asset }: { asset: Asset }) {
  const rows = exifRows(asset);
  const custody = custodyMeta(asset.custody_state);
  if (rows.length === 0 && !custody) return null;
  return (
    <div className={styles.detailsGrid}>
      {rows.map((row) => (
        <div className="ph-details-row" key={row.label}>
          <span className={styles.detailsK}>{row.label}</span>
          <span className={styles.detailsV}>
            {row.href ? (
              <a href={row.href} target="_blank" rel="noreferrer">
                {row.value}
              </a>
            ) : (
              row.value
            )}
          </span>
        </div>
      ))}
      {custody ? (
        <div className="ph-details-row">
          <span className={styles.detailsK}>Backup</span>
          <span className={`${styles.detailsV} ${custodyCls[custody.tone] ?? ''}`}>
            {custody.label}
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function LightboxInfo({
  asset,
  albums: albumList,
  places,
  refresh,
  onClose,
}: {
  asset: Asset;
  albums: Album[];
  places: Place[];
  refresh: () => Promise<void>;
  onClose: () => void;
}) {
  const noteRef = useRef<HTMLParagraphElement | null>(null);
  const facesHostRef = useRef<HTMLDivElement | null>(null);
  const [placeEditorOpen, setPlaceEditorOpen] = useState(false);
  const [addingTag, setAddingTag] = useState(false);
  const [tagText, setTagText] = useState('');

  useEffect(() => {
    renderFaces(facesHostRef.current!, asset.asset_id, noteRef.current!);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (#360) this component remounts fresh per asset/refresh (keyed by renderSeq in the shell)
  }, []);

  return (
    <>
      <input
        type="text"
        className={styles.captionInput}
        defaultValue={asset.title ?? ''}
        placeholder="Add a caption…"
        aria-label="Caption"
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        onChange={async (e) => {
          const title = e.currentTarget.value.trim();
          if (title === (asset.title ?? '')) return;
          const outcome = await act('update-asset', { asset_id: asset.asset_id, title });
          if (narrate(outcome, noteRef.current)) await refresh();
        }}
      />

      <div className={styles.infoSectionLabel}>Details</div>
      <div className={styles.detailsTaken}>
        <input
          type="datetime-local"
          className="kit-input"
          defaultValue={toLocalInputValue(asset.captured_at ?? asset.taken_at)}
          aria-label="Capture time"
          onChange={async (e) => {
            if (!e.currentTarget.value) return;
            const d = new Date(e.currentTarget.value);
            if (Number.isNaN(d.getTime())) return;
            const outcome = await act('update-asset', {
              asset_id: asset.asset_id,
              captured_at: d.toISOString(),
            });
            if (narrate(outcome, noteRef.current)) await refresh();
          }}
        />
      </div>
      <DetailsGrid asset={asset} />

      <div className={styles.infoSectionLabel}>Place</div>
      {placeEditorOpen ? (
        <div className={styles.placeEditor}>
          <select
            className="kit-input"
            aria-label="Set place"
            defaultValue={asset.place?.place_id ?? ''}
            onChange={async (e) => {
              const placeId = e.currentTarget.value;
              const outcome = await act(
                'set-place',
                placeId
                  ? { asset_id: asset.asset_id, place_id: placeId }
                  : { asset_id: asset.asset_id },
              );
              setPlaceEditorOpen(false);
              if (narrate(outcome, noteRef.current)) await refresh();
            }}
          >
            <option value="">No place</option>
            {places.map((p) => (
              <option key={p.place_id} value={p.place_id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="kit-icon-btn"
            aria-label="Cancel"
            onClick={() => setPlaceEditorOpen(false)}
          >
            ×
          </button>
          {places.length === 0 ? (
            <p className={`kit-muted kit-small ${styles.placeEmpty}`}>
              No known places yet — places are linked automatically from a photo's GPS data.
            </p>
          ) : null}
        </div>
      ) : (
        <button type="button" className={styles.placeChip} onClick={() => setPlaceEditorOpen(true)}>
          {asset.place?.name ?? 'Add place'}
        </button>
      )}

      {/* faces.ts owns its own "People" heading, imperatively, only when
          face regions actually exist — no static label here, matching the
          old PanelBody's contract exactly. */}
      <div className="ph-faces" ref={facesHostRef}></div>

      {albumList.length > 0 ? (
        <>
          <div className={styles.infoSectionLabel}>Albums</div>
          <div className={styles.chipRow}>
            {albumList.map((album) => {
              const member = asset.album_ids?.includes(album.album_id) ?? false;
              return (
                <button
                  key={album.album_id}
                  type="button"
                  className={styles.albumChip}
                  data-active={member ? 'true' : 'false'}
                  onClick={async () => {
                    const outcome = await act(member ? 'remove-from-album' : 'add-to-album', {
                      album_id: album.album_id,
                      asset_id: asset.asset_id,
                    });
                    if (narrate(outcome, noteRef.current)) await refresh();
                  }}
                >
                  {member ? `✓ ${album.title ?? 'Album'}` : (album.title ?? 'Album')}
                </button>
              );
            })}
          </div>
        </>
      ) : null}

      <div className={styles.infoSectionLabel}>Tags</div>
      <div className={styles.chipRow}>
        {(asset.tags ?? []).map((tag) => (
          <button
            key={tag.tag_id}
            type="button"
            className={styles.tagChipX}
            aria-label={`Remove tag ${tag.label}`}
            onClick={async () => {
              const outcome = await act('untag-asset', { tag_id: tag.tag_id });
              if (narrate(outcome, noteRef.current)) await refresh();
            }}
          >
            {tag.label} ×
          </button>
        ))}
        {addingTag ? (
          <input
            type="text"
            className={`kit-input bare ${styles.tagInput}`}
            placeholder="Tag name"
            aria-label="Add tag"
            value={tagText}
            autoFocus
            onChange={(e) => setTagText(e.currentTarget.value)}
            onKeyDown={async (e) => {
              if (e.key === 'Escape') {
                setAddingTag(false);
                setTagText('');
                return;
              }
              if (e.key !== 'Enter') return;
              const label = e.currentTarget.value.trim();
              if (!label) {
                setAddingTag(false);
                return;
              }
              const outcome = await act('tag-asset', { asset_id: asset.asset_id, label });
              setAddingTag(false);
              setTagText('');
              if (narrate(outcome, noteRef.current)) await refresh();
            }}
            onBlur={() => {
              setAddingTag(false);
              setTagText('');
            }}
          />
        ) : (
          <button type="button" className={styles.tagChipNew} onClick={() => setAddingTag(true)}>
            ＋ Tag
          </button>
        )}
      </div>

      <div className={styles.infoSectionLabel}>Activity</div>
      <div className={styles.activity}>
        {buildActivity(asset).map((ev, i) => (
          <div className={styles.activityRow} key={i}>
            <span className={styles.activityDot} aria-hidden="true" />
            <div className={styles.activityBody}>
              <div className={styles.activityText}>{ev.text}</div>
              <div className={styles.activityMeta}>
                <span>{ev.date}</span>
                <span className={styles.receiptChip}>receipted</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      <button
        type="button"
        className={styles.deleteLink}
        onClick={async (e) => {
          if (!armConfirm(e.currentTarget, { armedLabel: 'Delete photo?' })) return;
          const outcome = await act('delete-asset', { asset_id: asset.asset_id });
          if (narrate(outcome, noteRef.current)) {
            onClose();
            toast('Moved to trash — it leaves every album it was in.', {
              undoLabel: 'Undo',
              onUndo: () => restoreAsset(asset.asset_id, refresh),
            });
            await refresh();
          }
        }}
      >
        Delete photo
      </button>
      <p className={styles.note} ref={noteRef}></p>
    </>
  );
}
