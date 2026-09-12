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

import { insightCsvFilename, insightRollupCsv } from "@centraid/design/blocks";

import type { InsightsSummary } from "../../lib/insights";

/** What a device with no share sheet at all is told. */
const NO_SHARE_SHEET =
  "This device has no way to share a file, so the rollup cannot leave the app.";

/** Everything else: a cache the OS refused, a share sheet that threw. */
const EXPORT_FAILED = "The CSV could not be shared.";

/**
 * A failed export in both registers (#1015 R-NY-10). `member` is the sentence
 * the screen prints verbatim; `detail` is the raw text, which goes to the
 * `[centraid] insights:` log line (docs/logs.md) and nowhere a member looks.
 */
export class ExportFailureError extends Error {
  constructor(
    readonly member: string,
    readonly detail: string
  ) {
    super(member);
    this.name = "ExportFailureError";
  }
}

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
  if (!(await Sharing.isAvailableAsync()))
    throw new ExportFailureError(
      NO_SHARE_SHEET,
      "no share sheet on this device"
    );
  try {
    const file = new File(Paths.cache, insightCsvFilename(windowDays));
    // The cache keeps the last export until the OS reclaims it, so the write
    // overwrites rather than failing on a second export of the same window.
    file.create({ overwrite: true });
    file.write(insightRollupCsv(summary));
    await Sharing.shareAsync(file.uri, {
      mimeType: "text/csv",
      UTI: "public.comma-separated-values-text",
    });
  } catch (error) {
    throw new ExportFailureError(EXPORT_FAILED, logTextOf(error));
  }
}

/**
 * A thrown thing's own words, for the `[centraid] insights:` log line. It is
 * a named function rather than a ternary at the throw, so the one place this
 * app extracts an exception's text is the one place that says, in its name,
 * that the result is the log's and never a screen's.
 */
function logTextOf(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message;
  return String(thrown);
}
