// The inline kit — the shell-side module blueprint apps' `./kit.js` specifier
// resolves to when a bundled app runs INLINE (see inline-vite-aliases.ts).
//
// It mirrors kit.js's named-export API exactly so app code is unchanged. The
// large pure surface (DOM helpers, formatters, skeletons, popovers, charts,
// mention UI, …) is re-exported verbatim from the real kit; only the handful of
// exports that reach the network or the served document are overridden to use
// the shell's authenticated gateway client and appearance plane:
//
//   - `wireThemeToggle`  → drives the shell theme (not the served data-theme flip)
//   - `renderAttachments`→ authorises `/_vault/blobs` bytes through the gateway
//   - `createReference` / `removeReference` / `reanchorReference`
//                        → owner-plane link writes through the authed gateway
//
// `onDataChange` is re-exported verbatim: it already routes through
// `window.centraid.onChange`, which the inline client (centraid-inline.ts) backs
// with a replica-invalidation subscription — so the kit's debounce + table
// filter semantics carry over with no override.
//
// The `./suppress-served-ask` import MUST stay first: kit.js auto-mounts its Ask
// panel at module-eval time, and the sentinel it sets suppresses that before the
// kit module below is evaluated (see suppress-served-ask.ts).
import './suppress-served-ask.js';
import { renderAttachments as baseRenderAttachments } from '@centraid/blueprints/kit/kit.js';
import { auth, authHeaders, doFetch } from '../../gateway-client-core.js';

export * from '@centraid/blueprints/kit/kit.js';

const BLOB_PREFIX = '/centraid/_vault/blobs';
const SUN_SVG =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON_SVG =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>';

function shellIsDark(): boolean {
  const theme = document.documentElement.dataset.theme;
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Inline theme toggle. Where the served kit flips `data-theme` directly, inline
 * apps live in the shell document, so the toggle drives the shell's appearance
 * pref: it flips `data-theme` for an instant, synchronous repaint AND persists
 * the choice through the host settings plane so it survives reload and matches
 * the shell's own theme control.
 */
export function wireThemeToggle(
  btn: HTMLElement,
  { onChange }: { onChange?: (dark: boolean) => void } = {},
): () => void {
  const setIcon = (): void => {
    btn.innerHTML = shellIsDark() ? SUN_SVG : MOON_SVG;
  };
  btn.addEventListener('click', () => {
    const dark = !shellIsDark();
    // Flip the shell document's theme for an instant, synchronous repaint of the
    // inline app + the rest of the shell. Durable theme persistence is owned by
    // the shell's own Settings appearance control (a single source of truth);
    // this in-app toggle is the app-local affordance the served chrome shipped.
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    setIcon();
    onChange?.(dark);
  });
  setIcon();
  return setIcon;
}

interface AttachmentLike {
  attachment_id?: string;
  media_type?: string;
  content_uri?: string;
  byte_size?: number;
  title?: string | null;
}

const stripObjectUrls = new WeakMap<HTMLElement, string[]>();

async function authorizeBlobUrl(pathname: string): Promise<string | null> {
  try {
    const { baseUrl, token } = await auth();
    const res = await doFetch(baseUrl, pathname, { headers: authHeaders(token) });
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  } catch {
    return null;
  }
}

/**
 * Render attachment tiles, then authorise any `/_vault/blobs/…` bytes. Inline,
 * those relative URLs do not resolve against the shell origin (and desktop runs
 * from `file://`), so each blob-backed `img`/`a` is refetched through the
 * authenticated gateway client and swapped to a `blob:` object URL.
 *
 * Consumed by blueprint apps through the `./kit.js` → kit-inline Vite alias
 * (invisible to knip's client-only export graph).
 * @public
 */
export function renderAttachments(
  stripEl: HTMLElement,
  list: AttachmentLike[] | undefined,
  onRemove: ((attachmentId: string) => Promise<unknown>) | null,
  options: { onZoom?: (attachment: unknown) => void } = {},
): void {
  for (const url of stripObjectUrls.get(stripEl) ?? []) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* already revoked */
    }
  }
  stripObjectUrls.delete(stripEl);
  baseRenderAttachments(stripEl, list, onRemove, options);
  const created: string[] = [];
  const targets = [
    ...stripEl.querySelectorAll<HTMLImageElement>('img'),
    ...stripEl.querySelectorAll<HTMLAnchorElement>('a'),
  ];
  for (const el of targets) {
    const attr = el instanceof HTMLImageElement ? 'src' : 'href';
    const raw = el.getAttribute(attr);
    if (!raw || !raw.startsWith(BLOB_PREFIX)) continue;
    void authorizeBlobUrl(raw).then((objectUrl) => {
      if (!objectUrl || !el.isConnected) return;
      el.setAttribute(attr, objectUrl);
      created.push(objectUrl);
      stripObjectUrls.set(stripEl, created);
    });
  }
}

// NOTE (issue #505 Phase 4): the owner-plane reference writes kit.js exports —
// createReference / removeReference / reanchorReference — flow through the
// `export *` above as their served (relative-`fetch`) implementations, which do
// NOT resolve inline. Tasks (the pilot) uses none of them; when an app that does
// (notes/docs) is converted, override them here to post through the authed
// gateway client (`doFetch` + `authHeaders`), mirroring renderAttachments.
