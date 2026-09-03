import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  LocalComponentId,
  LocalUsageReportDTO,
} from "../../gateway-client-local-storage.js";
import LocalFootprintCard from "./LocalFootprintCard.js";

const GB = 1024 ** 3;

const unknown = (id: string): LocalComponentId =>
  id as unknown as LocalComponentId;

function report(over: Partial<LocalUsageReportDTO> = {}): LocalUsageReportDTO {
  return {
    scannedAt: 0,
    totalBytes: 3 * GB,
    components: [],
    vaults: [],
    disk: { freeBytes: 40 * GB, totalBytes: 500 * GB },
    limits: {
      totalLimitBytes: null,
      warnAtPercent: 80,
      journalLimitBytes: null,
    },
    limit: {
      status: "ok",
      fractionUsed: null,
      usedBytes: 3 * GB,
      limitBytes: null,
    },
    ...over,
  };
}

function render(r: LocalUsageReportDTO | null): string {
  return renderToStaticMarkup(
    createElement(LocalFootprintCard, {
      report: r,
      loadError: null,
      rescanning: false,
    })
  );
}

describe("LocalFootprintCard — an unrecognized component never crashes the card", () => {
  it("does not throw, and still shows the id and byte count, for a component this build has never heard of — in the legend AND the per-vault breakdown", () => {
    const withUnknown = report({
      components: [
        { component: unknown("not-yet-invented"), bytes: GB, files: 1 },
      ],
      vaults: [
        {
          vaultId: "v1",
          bytes: GB,
          components: [
            { component: unknown("also-unknown"), bytes: GB, files: 2 },
          ],
        },
      ],
    });
    expect(() => render(withUnknown)).not.toThrow();
    const html = render(withUnknown);
    expect(html).toContain("not-yet-invented");
    expect(html).toContain("also-unknown");
  });

  it("still renders the pre-existing empty state while the report is loading (`report: null`)", () => {
    expect(() => render(null)).not.toThrow();
    expect(render(null)).toContain("Measuring what");
  });
});
