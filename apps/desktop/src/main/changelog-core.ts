// "What's new" changelog — pure normalization. Fetch + cache live in changelog.ts.

export interface ChangelogRelease {
  version: string;
  title: string;
  notes: string;
  publishedAt: string | null;
  url: string;
  prerelease: boolean;
}

export interface ChangelogResult {
  currentVersion: string;
  releases: ChangelogRelease[];
  error?: string;
}

interface RawRelease {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  published_at?: unknown;
  html_url?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Drop no-tag and drafts; non-array → `[]`. */
export function normalizeReleases(raw: unknown): ChangelogRelease[] {
  if (!Array.isArray(raw)) return [];
  const out: ChangelogRelease[] = [];
  for (const entry of raw as RawRelease[]) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.draft === true) continue;
    const tag = str(entry.tag_name).trim();
    const name = str(entry.name).trim();
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
