// Full-screen slideshow (issue #352 phase 3): auto-advances through the
// PHOTO subset of the list it opened with (videos are skipped, both during
// auto-advance and manual stepping — there is no reliable "finished playing"
// signal to hang a 4s-default timer off without wiring per-asset <video>
// event listeners, and a silently-autoplaying video would need its own
// mute/sound decision this app doesn't otherwise make anywhere; open a video
// from the grid/lightbox directly to play it). Space pauses/resumes, arrow
// keys step manually (and reset the auto-advance clock), Escape exits.
import { useEffect, useRef, useState } from '../react-core.min.js';
import { isRenderableUri, isVideoAsset } from '../format.js';
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon, PauseIcon, PlayIcon } from '../icons.jsx';

const ADVANCE_MS = 4000;

export function SlideshowView({ list, startAssetId, onClose }) {
  const photos = list.filter((a) => isRenderableUri(a.content_uri) && !isVideoAsset(a));
  const startIdx = startAssetId ? photos.findIndex((a) => a.asset_id === startAssetId) : 0;
  const [idx, setIdx] = useState(Math.max(0, startIdx));
  const [paused, setPaused] = useState(false);
  const timerRef = useRef(0);

  function step(delta) {
    setIdx((i) => {
      const n = photos.length;
      if (n === 0) return i;
      return (i + delta + n) % n;
    });
  }

  // Re-arms the 4s clock on every idx/paused change — a manual step (arrow
  // key or nav button) resets the wait, which is the behavior a slideshow
  // remote would give you too.
  useEffect(() => {
    if (paused || photos.length <= 1) return undefined;
    timerRef.current = setTimeout(() => step(1), ADVANCE_MS);
    return () => clearTimeout(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (#360) `step`/`photos.length` are stable for the component's lifetime (the list is a snapshot passed in at open time)
  }, [idx, paused]);

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === ' ') {
        e.preventDefault();
        setPaused((p) => !p);
      } else if (e.key === 'ArrowLeft') {
        step(-1);
      } else if (e.key === 'ArrowRight') {
        step(1);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (#360) `onClose`/`step` are stable for this mount (the whole tree remounts fresh on every openSlideshow() call)
  }, []);

  if (photos.length === 0) {
    return (
      <>
        <p className="slideshow-empty">
          No photos to show here — videos aren’t included in the slideshow.
        </p>
        <button
          type="button"
          className="kit-btn slideshow-exit"
          onClick={onClose}
          aria-label="Close slideshow"
        >
          <CloseIcon size={14} /> Close
        </button>
      </>
    );
  }

  const asset = photos[idx];
  return (
    <>
      <img
        key={asset.asset_id}
        className="slideshow-img"
        src={asset.content_uri}
        alt={asset.title ?? 'Photo'}
        onClick={(e) => e.stopPropagation()}
      />
      {[
        ['prev', -1, ChevronLeftIcon, 'Previous photo'],
        ['next', 1, ChevronRightIcon, 'Next photo'],
      ].map(([variant, delta, Glyph, name]) => (
        <button
          key={variant}
          type="button"
          className={`kit-viewer-nav ${variant}`}
          aria-label={name}
          onClick={(e) => {
            e.stopPropagation();
            step(delta);
          }}
        >
          <Glyph size={22} />
        </button>
      ))}
      <div className="slideshow-bar" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="kit-btn"
          aria-pressed={paused ? 'true' : 'false'}
          onClick={() => setPaused((p) => !p)}
        >
          {paused ? <PlayIcon size={14} /> : <PauseIcon size={14} />}
          {paused ? 'Play' : 'Pause'}
        </button>
        <span className="slideshow-count">
          {idx + 1} / {photos.length}
        </span>
        <button type="button" className="kit-btn slideshow-exit" onClick={onClose}>
          Exit
        </button>
      </div>
    </>
  );
}
