// Face-proposer on-demand (issue #352 phase 3/4): a header toggle + popover
// that reads `enrichment-status` (enrich.policy for the photos domain) on
// mount and either offers "Detect faces now" (fires enrich.request_enrichment,
// reason 'manual') or says plainly that enrichment is off — never a button
// that would silently no-op. Fully self-contained (own open/status/busy
// state via hooks), so app.jsx mounts it once at boot and never re-renders
// it itself; no domain (asset/album) state is threaded in.
import { act, narrate } from '../outcomes.js';
import { useEffect, useRef, useState } from '../react-core.min.js';

export function EnrichmentPanel() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(null); // null while the first read is in flight
  const [busy, setBusy] = useState(false);
  const [requested, setRequested] = useState(false);
  const wrapRef = useRef(null);
  const noteRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    window.centraid
      .read({ query: 'enrichment-status' })
      .then((data) => {
        if (!cancelled) setStatus(data ?? {});
      })
      .catch(() => {
        if (!cancelled) setStatus({ tier: null, vaultDenied: { message: 'Could not check.' } });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Away-click close, same contract as the "Add to album" menu
  // (components/SelectionBar.jsx) — a plain document listener, torn down
  // whenever the popover isn't open.
  useEffect(() => {
    if (!open) return undefined;
    function onAway(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('click', onAway, true);
    return () => document.removeEventListener('click', onAway, true);
  }, [open]);

  const tier = status?.tier ?? null;
  const enabled = tier === 'local' || tier === 'model';

  return (
    <div className="enrichment-wrap" ref={wrapRef}>
      <button
        type="button"
        className="kit-btn head-btn"
        aria-haspopup="true"
        aria-expanded={open ? 'true' : 'false'}
        onClick={() => setOpen((v) => !v)}
      >
        ✨ Faces
      </button>
      {open ? (
        <div className="kit-popover enrichment-panel" role="dialog" aria-label="Face detection">
          {status == null ? (
            <p className="kit-muted kit-small">Checking…</p>
          ) : status.vaultDenied ? (
            <p className="kit-small">No access to check enrichment settings.</p>
          ) : enabled ? (
            <>
              <p className="kit-small">
                Face detection is on ({tier === 'model' ? 'cloud model' : 'on-device'}).
              </p>
              <button
                type="button"
                className="kit-btn"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  const outcome = await act('request-enrichment', {
                    entity_type: 'media.media_asset',
                  });
                  setBusy(false);
                  if (narrate(outcome, noteRef.current)) {
                    setRequested(true);
                    if (noteRef.current) {
                      noteRef.current.textContent =
                        'Requested — new face proposals will show up on your photos soon.';
                    }
                  }
                }}
              >
                {busy ? 'Requesting…' : requested ? 'Requested ✓' : 'Detect faces now'}
              </button>
            </>
          ) : (
            <p className="kit-small">
              Face detection is turned off for this vault. Turn it on in vault settings to use
              this.
            </p>
          )}
          <p className="lightbox-note enrichment-note" ref={noteRef}></p>
        </div>
      ) : null}
    </div>
  );
}
