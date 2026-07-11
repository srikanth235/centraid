/*
 * "What's new" changelog — pure normalization core.
 *
 * The desktop pulls its release notes from the project's GitHub Releases
 * (there is no bundled CHANGELOG.md; every release's notes ARE the changelog,
 * exactly like Claude Code's "What's new"). This module turns the raw GitHub
 * Releases API payload into the compact, JSON-cloneable shape the renderer
 * modal renders. It's electron-free and network-free so it unit-tests as
 * plain logic; the fetch + cache wiring lives in changelog.ts.
 *
 * GitHub Releases API (unauthenticated):
 *   GET https://api.github.com/repos/<owner>/<repo>/releases
 * returns a newest-first array of release objects. We keep only the fields the
 * modal shows, drop drafts (unpublished), and keep the API's newest-first order.
 */

/** A single published release, trimmed to what the "What's new" modal renders. */
export interface ChangelogRelease {
  /** Release tag (e.g. `v0.2.0`) — the stable identity + the version chip. */
  version: string;
  /** Human title (GitHub's release `name`), falling back to the tag. */
  title: string;
  /** Raw release notes (GitHub-flavored markdown); rendered md-lite client-side. */
  notes: string;
  /** ISO 8601 publish timestamp, or `null` if GitHub omitted it. */
  publishedAt: string | null;
  /** Canonical GitHub URL for the release (for a "View on GitHub" link). */
  url: string;
  /** Pre-release flag — the modal tags these so they read as not-yet-stable. */
  prerelease: boolean;
}

/** The shape the renderer bridge returns: current build + the release list. */
export interface ChangelogResult {
  /** Version of the running build (`app.getVersion()`), for the auto-open gate. */
  currentVersion: string;
  /** Published releases, newest-first. Empty when there are none (or on error). */
  releases: ChangelogRelease[];
  /** Present only when the fetch failed AND no cached list was available. */
  error?: string;
}

/** One raw GitHub release object — only the fields we read, all optional. */
interface RawRelease {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  published_at?: unknown;
  html_url?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Normalize a raw GitHub Releases payload into `ChangelogRelease[]`. Defensive
 * against malformed entries (missing/typed-wrong fields) since it parses an
 * external API: a release with no usable tag is dropped, drafts are dropped,
 * and the API's newest-first order is preserved. Non-array input → `[]`.
 */
export function normalizeReleases(raw: unknown): ChangelogRelease[] {
  if (!Array.isArray(raw)) return [];
  const out: ChangelogRelease[] = [];
  for (const entry of raw as RawRelease[]) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.draft === true) continue; // unpublished drafts aren't "new" yet
    const tag = str(entry.tag_name).trim();
    const name = str(entry.name).trim();
    // A release needs *some* label; the tag is canonical, the name is a fallback.
    const version = tag || name;
    if (!version) continue;
    const publishedRaw = str(entry.published_at).trim();
    out.push({
      version,
      title: name || tag,
      notes: str(entry.body),
      publishedAt: publishedRaw || null,
      url: str(entry.html_url),
      prerelease: entry.prerelease === true,
    });
  }
  return out;
}
