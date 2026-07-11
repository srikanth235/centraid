/*
 * "What's new" changelog — electron wiring around the pure core in
 * changelog-core.ts. Fetches the project's GitHub Releases, normalizes them,
 * and hands the renderer modal a `ChangelogResult` (current build version +
 * the release list). Results are cached in-memory with a short TTL so the
 * modal reopening — or the once-per-launch auto-open probe — doesn't hammer
 * GitHub's unauthenticated rate limit (60 req/hr/IP).
 *
 * There is no bundled CHANGELOG.md: each GitHub release's notes ARE the
 * changelog entry, exactly like Claude Code's "What's new". When the fetch
 * fails we serve the last good list if we have one; only a cold failure
 * (offline first launch) surfaces an `error` — the modal shows an empty/retry
 * state and the auto-open gate stays closed.
 */

import { app } from 'electron';
import { normalizeReleases, type ChangelogRelease, type ChangelogResult } from './changelog-core.js';

/**
 * The repo the release notes come from. Hardcoded (no `repository` field in
 * package.json) — this is the app's own upstream, matched to the git remote
 * `git@github.com:srikanth235/centraid`. Change here if the repo moves.
 */
const REPO = 'srikanth235/centraid';
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases?per_page=50`;

/** Cache TTL — a fresh fetch at most this often. Release cadence is slow. */
const CACHE_TTL_MS = 15 * 60 * 1000;
/** Network timeout — the modal must not hang on a stalled request. */
const FETCH_TIMEOUT_MS = 8_000;

interface CacheEntry {
  releases: ChangelogRelease[];
  fetchedAt: number;
}
let cache: CacheEntry | null = null;

async function fetchReleases(): Promise<ChangelogRelease[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(RELEASES_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        // GitHub asks unauthenticated clients to identify themselves.
        'User-Agent': `Centraid-Desktop/${app.getVersion()}`,
      },
    });
    if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
    return normalizeReleases(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Renderer-facing changelog read. Serves a cached list within the TTL; on a
 * cache miss it refetches. A failed refetch falls back to the last good list
 * (stale-but-usable) and only reports `error` when there's nothing cached to
 * show. `currentVersion` is always the running build, independent of the fetch,
 * so the renderer's auto-open version gate works even offline.
 */
export async function getChangelog(): Promise<ChangelogResult> {
  const currentVersion = app.getVersion();
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return { currentVersion, releases: cache.releases };
  }
  try {
    const releases = await fetchReleases();
    cache = { releases, fetchedAt: now };
    return { currentVersion, releases };
  } catch (err) {
    if (cache) return { currentVersion, releases: cache.releases };
    return {
      currentVersion,
      releases: [],
      error: err instanceof Error ? err.message : 'Failed to load changelog',
    };
  }
}

/** Drop the cache — test hook so a stubbed `fetch` is observed on next call. */
export function _resetChangelogCache(): void {
  cache = null;
}
