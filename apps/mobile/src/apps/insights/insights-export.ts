// Export CSV — the one verb the Analytics bar carries (#765, spec §5 `a2`).
//
// The verb is OFFERED on this surface because the surface can honour it: the
// phone writes the rollup to its own cache directory and hands the file to the
// system share sheet, which is the platform's export. That is the same pair
// (`expo-file-system` + `expo-sharing`) the Docs viewer already uses to hand a
// document out; nothing else on a phone is "export".
//
// It exports the window that is on screen — never the default, never the whole
// ledger — because the file has to match the chart the member is looking at.

import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";

import type { InsightsSummary } from "../../lib/insights";
import { csvFilename, insightsCsv } from "./insights-model";

/** What a device with no share sheet at all is told. */
const NO_SHARE_SHEET =
  "This device has no way to share a file, so the rollup cannot leave the app.";

/**
 * Write the window's rollup to the cache and hand it to the share sheet.
 *
 * Throws on failure so the caller can say so: an export that silently does
 * nothing is indistinguishable from one the member cancelled, and only one of
 * those is worth reporting.
 */
export async function shareCsv(
  summary: InsightsSummary,
  windowDays: number
): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error(NO_SHARE_SHEET);
  const file = new File(Paths.cache, csvFilename(windowDays));
  // The cache keeps the last export until the OS reclaims it, so the write
  // overwrites rather than failing on a second export of the same window.
  file.create({ overwrite: true });
  file.write(insightsCsv(summary));
  await Sharing.shareAsync(file.uri, {
    mimeType: "text/csv",
    UTI: "public.comma-separated-values-text",
  });
}
