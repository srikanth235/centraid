import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";

import { insightCsvFilename, insightRollupCsv } from "@centraid/design/blocks";

import type { InsightsSummary } from "../../lib/insights";

const NO_SHARE_SHEET =
  "This device has no way to share a file, so the rollup cannot leave the app.";

export async function shareCsv(
  summary: InsightsSummary,
  windowDays: number
): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error(NO_SHARE_SHEET);
  const file = new File(Paths.cache, insightCsvFilename(windowDays));
  file.create({ overwrite: true });
  file.write(insightRollupCsv(summary));
  await Sharing.shareAsync(file.uri, {
    mimeType: "text/csv",
    UTI: "public.comma-separated-values-text",
  });
}
