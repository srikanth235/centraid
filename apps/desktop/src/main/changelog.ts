/*
 * "What's new" changelog — electron wiring around changelog-core.ts: TTL-
 * cached GitHub Releases (unauth limit 60 req/hr/IP); failure serves the
 * last good list, `error` only when nothing cached.
 */

import { app } from "electron";

import { normalizeReleases } from "./changelog-core.js";
import type { ChangelogRelease, ChangelogResult } from "./changelog-core.js";

const REPO = "srikanth235/centraid";
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases?per_page=50`;

const CACHE_TTL_MS = 15 * 60 * 1000;
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
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": `Centraid-Desktop/${app.getVersion()}`,
      },
    });
    if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
    return normalizeReleases(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

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
  } catch (error) {
    if (cache) return { currentVersion, releases: cache.releases };
    return {
      currentVersion,
      releases: [],
      error:
        error instanceof Error ? error.message : "Failed to load changelog",
    };
  }
}
