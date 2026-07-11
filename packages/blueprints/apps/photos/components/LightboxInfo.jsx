// The lightbox's right-side info panel (bottom sheet on phone): editable
// caption, an EXIF-extended Details grid, the real editable place picker,
// custody/backup status, People chips (faces), Album chips, free-form Tag
// chips, and an honest Activity list. All the issue #352 write flows
// (caption/capture-time/place/tags/albums/faces) that used to live in
// components/Lightbox.jsx's PanelBody now live here — split out purely for
// file-size budget as the v2 redesign grew this region (governance's
// 500-line cap), not a behavior change.
import { armConfirm, toast } from '../kit.js';
import { restoreAsset } from '../assets-actions.js';
import { buildActivity } from '../activity.js';
import { renderFaces } from '../faces.js';
import { custodyMeta, exifRows, toLocalInputValue } from '../format.js';
import { act, narrate } from '../outcomes.js';
import { useEffect, useRef, useState } from '../react-core.min.js';

function DetailsGrid({ asset }) {
  const rows = exifRows(asset);
  const custody = custodyMeta(asset.custody_state);
  if (rows.length === 0 && !custody) return null;
  return (
    <div className="ph-details-grid">
      {rows.map((row) => (
        <div className="ph-details-row" key={row.label}>
          <span className="ph-details-k">{row.label}</span>
          <span className="ph-details-v">
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
          <span className="ph-details-k">Backup</span>
          <span className={`ph-details-v ph-custody-${custody.tone}`}>{custody.label}</span>
        </div>
      ) : null}
    </div>
  );
}

export function LightboxInfo({ asset, albums: albumList, places, refresh, onClose }) {
  const noteRef = useRef(null);
  const facesHostRef = useRef(null);
  const [placeEditorOpen, setPlaceEditorOpen] = useState(false);
  const [addingTag, setAddingTag] = useState(false);
  const [tagText, setTagText] = useState('');

  useEffect(() => {
    renderFaces(facesHostRef.current, asset.asset_id, noteRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- this component remounts fresh per asset/refresh (keyed by renderSeq in the shell)
  }, []);

  return (
    <>
      <input
        type="text"
        className="ph-caption-input"
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

      <div className="ph-info-section-label">Details</div>
      <div className="ph-details-taken">
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

      <div className="ph-info-section-label">Place</div>
      {placeEditorOpen ? (
        <div className="ph-place-editor">
          <select
            className="kit-input"
            aria-label="Set place"
            defaultValue={asset.place?.place_id ?? ''}
            onChange={async (e) => {
              const placeId = e.currentTarget.value;
              const outcome = await act(
                'set-place',
                placeId ? { asset_id: asset.asset_id, place_id: placeId } : { asset_id: asset.asset_id },
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
          <button type="button" className="kit-icon-btn" aria-label="Cancel" onClick={() => setPlaceEditorOpen(false)}>
            ×
          </button>
          {places.length === 0 ? (
            <p className="kit-muted kit-small ph-place-empty">
              No known places yet — places are linked automatically from a photo's GPS data.
            </p>
          ) : null}
        </div>
      ) : (
        <button type="button" className="ph-place-chip" onClick={() => setPlaceEditorOpen(true)}>
          {asset.place?.name ?? 'Add place'}
        </button>
      )}

      {/* faces.js owns its own "People" heading, imperatively, only when
          face regions actually exist — no static label here, matching the
          old PanelBody's contract exactly. */}
      <div className="ph-faces" ref={facesHostRef}></div>

      {albumList.length > 0 ? (
        <>
          <div className="ph-info-section-label">Albums</div>
          <div className="ph-chip-row">
            {albumList.map((album) => {
              const member = asset.album_ids?.includes(album.album_id) ?? false;
              return (
                <button
                  key={album.album_id}
                  type="button"
                  className="ph-album-chip"
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

      <div className="ph-info-section-label">Tags</div>
      <div className="ph-chip-row">
        {(asset.tags ?? []).map((tag) => (
          <button
            key={tag.tag_id}
            type="button"
            className="ph-tag-chip-x"
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
            className="kit-input bare ph-tag-input"
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
          <button type="button" className="ph-tag-chip-new" onClick={() => setAddingTag(true)}>
            ＋ Tag
          </button>
        )}
      </div>

      <div className="ph-info-section-label">Activity</div>
      <div className="ph-activity">
        {buildActivity(asset).map((ev, i) => (
          <div className="ph-activity-row" key={i}>
            <span className="ph-activity-dot" aria-hidden="true" />
            <div className="ph-activity-body">
              <div className="ph-activity-text">{ev.text}</div>
              <div className="ph-activity-meta">
                <span>{ev.date}</span>
                <span className="ph-receipt-chip">receipted</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      <button
        type="button"
        className="ph-delete-link"
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
      <p className="ph-note" ref={noteRef}></p>
    </>
  );
}
