import { stageDerivative, stageFileBytes } from "@centraid/design/elements";
import type { StagedBlob } from "@centraid/design/elements";

import { extractPdfTextWithPdfJs } from "./pdf-text.ts";

export { extractPdfTextWithPdfJs } from "./pdf-text.ts";

export async function stageDocumentFile(file: File): Promise<StagedBlob> {
  const staged = await stageFileBytes(file, "", { hash: true });
  const mediaType = String(file.type || staged.mediaType || "").toLowerCase();
  if (
    mediaType === "application/pdf" ||
    String(file.name ?? "")
      .toLowerCase()
      .endsWith(".pdf")
  ) {
    const text = await extractPdfTextWithPdfJs(file);
    if (text) {
      try {
        await stageDerivative(
          staged.sha256,
          "text",
          new Blob([text], { type: "text/plain" }),
          "text/plain"
        );
      } catch {
        // Intentionally empty.
      }
    }
  }
  return staged;
}
