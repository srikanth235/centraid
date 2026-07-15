// Upload pipeline: perceptual hash + client thumb staging, then the typed
// `upload` command per file. `runUpload` takes `refresh` and `setUploading`
// from app.jsx (the only two things here that touch app-level state) — the
// button/input DOM nodes it mutates for progress text are looked up locally
// via `$`, exactly like the pre-split code did.
import { BLOB_ROUTE, stageFileBytes, toast } from './kit.js';
import { act, narrate } from './outcomes.js';
import { CLIENT_TINY_EDGE, CLIENT_MEDIUM_EDGE } from './media.js';
import { $ } from './dom.js';

// Client-side ceiling per file. Bytes stream to the blob staging route
// (issue #296) — no base64 through command JSON — so a phone video fits;
// the route itself caps at 512 MB.
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

// 64-bit dHash (issue #299 Tier 0): 9×8 grayscale, each bit = "left pixel
// brighter than its right neighbour". The canvas is the client's raster
// codec, so the phash rides the same decode the thumb already paid for.
function dHashFromImage(img) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 9;
    canvas.height = 8;
    const g = canvas.getContext('2d');
    g.drawImage(img, 0, 0, 9, 8);
    const data = g.getImageData(0, 0, 9, 8).data;
    const lum = [];
    for (let i = 0; i < 72; i += 1) {
      const o = i * 4;
      lum.push(0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]);
    }
    let hex = '';
    for (let row = 0; row < 8; row += 1) {
      let byte = 0;
      for (let col = 0; col < 8; col += 1) {
        byte = (byte << 1) | (lum[row * 9 + col] > lum[row * 9 + col + 1] ? 1 : 0);
      }
      hex += byte.toString(16).padStart(2, '0');
    }
    return hex;
  } catch {
    return null; // no phash is fewer duplicate hints, never a failed upload
  }
}

// Downscale a decoded bitmap to `edge` on its long side and POST it as one
// preview-ladder rung beside the original. No-op (and no upload) when the
// source is already within `edge` — the client never upscales, and the
// gateway backstop won't either; a source already small enough IS its own
// rung. JPEG q0.82 matches the gateway codec's ~0.8 output band (issue #405
// §2). One bad rung never fails the upload.
async function stageRung(bitmap, parentSha, edge, variant) {
  const long = Math.max(bitmap.width, bitmap.height);
  if (long <= edge) return; // already within this rung — nothing to downscale
  const scale = edge / long;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
  if (!blob) return;
  await fetch(`${BLOB_ROUTE}?variant=${variant}&variant_of=${parentSha}&media_type=image/jpeg`, {
    method: 'POST',
    headers: { 'content-type': 'image/jpeg' },
    body: blob,
  });
}

// Both preview-ladder rungs (issue #405 §2), produced at upload time on this
// device (the canvas is the one raster codec every client has) and staged as
// the `thumb` (~256 px, the grid) and `preview` (~2048 px, the lightbox)
// variants beside the original. Dimensions + perceptual hash ride for free
// off the same single decode. A client that produces these first always wins
// the hot path (upsert semantics keep the last writer) — the gateway backstop
// only fills what a client couldn't.
//
// Decodes via createImageBitmap(file) — NOT `img.src = URL.createObjectURL()`:
// the gateway serves apps under `img-src 'self' data:` (no `blob:`), so a
// blob-URL <img> is CSP-refused and the whole pipeline silently died (no
// thumb variant, no dims, no phash — and every grid load then 404s on
// `?variant=thumb` before falling back to the originals). createImageBitmap
// reads the File directly, no URL fetch for CSP to police.
async function stageClientPreviews(file, parentSha) {
  try {
    const bitmap = await createImageBitmap(file);
    const dims = bitmap.width > 0 ? { width: bitmap.width, height: bitmap.height } : null;
    const phash = dHashFromImage(bitmap);
    // Tiny first (the grid is what paints on return), then medium. Both skip
    // themselves when the original is already smaller than their edge.
    await stageRung(bitmap, parentSha, CLIENT_TINY_EDGE, 'thumb');
    await stageRung(bitmap, parentSha, CLIENT_MEDIUM_EDGE, 'preview');
    bitmap.close();
    return dims ? { ...dims, ...(phash ? { phash } : {}) } : phash ? { phash } : null;
  } catch {
    return null; // no previews is a slower grid, never a failed upload
  }
}

export async function runUpload(files, { refresh, setUploading }) {
  const oversized = files.filter((f) => f.size > MAX_UPLOAD_BYTES);
  const accepted = files.filter((f) => f.size <= MAX_UPLOAD_BYTES);
  if (accepted.length === 0) {
    toast(
      oversized.length === 1
        ? `Skipped “${oversized[0].name}” — each upload tops out at 512 MB.`
        : `Skipped ${oversized.length} files — each upload tops out at 512 MB.`,
    );
    return;
  }

  setUploading(true);
  const btn = $('uploadBtn');
  btn.disabled = true;
  $('emptyUpload').disabled = true;

  let added = 0;
  let deduped = 0;
  let parked = 0;
  let failed = 0;
  let unreadable = 0;
  let lastBad = null;
  for (let i = 0; i < accepted.length; i += 1) {
    btn.textContent = `Uploading ${i + 1} of ${accepted.length}…`;
    const file = accepted[i];
    // Stage the bytes (issue #296), grow a client thumb beside them, then
    // claim the sha through the typed command — which is where the receipt
    // mints and the library learns about the asset.
    let staged;
    try {
      staged = await stageFileBytes(file);
    } catch {
      unreadable += 1;
      continue;
    }
    const kind = file.type.startsWith('video/')
      ? 'video'
      : file.type.startsWith('audio/')
        ? 'audio'
        : 'photo';
    // Only rasters get client-side preview rungs. Video poster frames are
    // deliberately OUT of v0 (issue #405 §2): capturing one means loading the
    // decoded video, seeking to a frame and racing loadeddata/seeked events —
    // fiddly, flaky under the blueprint harness, and no cheaper than the
    // gateway (which itself skips video decode in v0). A thumbless video keeps
    // rendering the placeholder-with-play-badge the grid already draws.
    const dims = kind === 'photo' ? await stageClientPreviews(file, staged.sha256) : null;
    const outcome = await act('upload', {
      staged_sha: staged.sha256,
      kind,
      captured_at: new Date(file.lastModified || Date.now()).toISOString(),
      ...(file.name ? { title: file.name } : {}),
      ...(dims?.width ? { width: dims.width, height: dims.height } : {}),
      ...(dims?.phash ? { phash: dims.phash } : {}),
    });
    // One bad file never sinks the batch — count it and keep going.
    if (outcome?.status === 'executed') {
      added += 1;
      if (outcome.output?.deduped) deduped += 1;
    } else if (outcome?.status === 'parked') {
      parked += 1;
    } else {
      failed += 1;
      lastBad = outcome;
    }
  }

  setUploading(false);
  btn.disabled = false;
  btn.textContent = '＋ Add photos';
  $('emptyUpload').disabled = false;

  const parts = [];
  if (added > 0) {
    const dedupeNote = deduped > 0 ? ` (${deduped} already in the library)` : '';
    parts.push(`Added ${added} ${added === 1 ? 'item' : 'items'}${dedupeNote}`);
  }
  if (parked > 0) parts.push(`${parked} awaiting approval`);
  if (failed > 0) parts.push(`${failed} refused`);
  if (unreadable > 0) parts.push(`${unreadable} unreadable`);
  if (oversized.length > 0) parts.push(`${oversized.length} over the 512 MB cap`);
  toast(parts.join(' · ') || 'Nothing added');
  if (lastBad) narrate(lastBad);
  await refresh();
}

function dragHasFiles(e) {
  return [...(e.dataTransfer?.types ?? [])].includes('Files');
}

// Every DOM entry point that can hand this app files: the sidebar's "Add
// photos" button (React-owned since the v2 sidebar — wired via its own
// `onUpload` prop in app.jsx instead of a boot-time listener here, since
// this module runs before the sidebar's first render ever mounts that
// node), the empty-state's own button (which prefers the picker when an
// album is selected), the hidden file input, page-wide drag/drop, and
// paste. Wired once at boot from app.jsx; `dragDepth` is pure drop-overlay
// bookkeeping that no component or app.jsx orchestrator ever reads, so it
// lives here rather than among app.jsx's domain state.
export function wireUpload({ uploadFiles, isAlbumSelected, openPicker }) {
  $('emptyUpload').addEventListener('click', () => {
    // Inside a real album the natural "add" is from the library, not disk.
    if (isAlbumSelected()) openPicker();
    else $('fileInput').click();
  });

  $('fileInput').addEventListener('change', async () => {
    const files = [...$('fileInput').files];
    $('fileInput').value = '';
    await uploadFiles(files);
  });

  // Drag a file anywhere onto the page: a full-page "Drop to add" overlay.
  let dragDepth = 0;

  window.addEventListener('dragenter', (e) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth += 1;
    $('dropOverlay').hidden = false;
  });

  window.addEventListener('dragover', (e) => {
    if (dragHasFiles(e)) e.preventDefault();
  });

  window.addEventListener('dragleave', (e) => {
    if (!dragHasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) $('dropOverlay').hidden = true;
  });

  window.addEventListener('drop', (e) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('dropOverlay').hidden = true;
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length > 0) uploadFiles(files);
  });

  // Paste an image (screenshot, copied photo) straight into the library.
  window.addEventListener('paste', (e) => {
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return; // never hijack a text field
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length > 0) uploadFiles(files);
  });
}
