import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  LocalComponentId,
  LocalUsageReportDTO,
} from "../../gateway-client-local-storage.js";
import LocalFootprintCard from "./LocalFootprintCard.js";

// Issue #726 finding 4: the gateway ships `"borrowed"` (#726 P4 D4, the
// "held for others" line) and, over time, will ship component ids this
// client build has never heard of. Neither may throw a TypeError on the
// footprint card — `footprintSlices`' legend and `VaultBreakdown`'s
// per-vault rows both index component presentation by an id that arrives
// over the wire unchecked, so both paths are exercised here.
const GB = 1024 ** 3;

/** A component id the wire sent that this build's `LocalComponentId` union
 *  does not name — exactly what a newer gateway can do, since the union is
 *  a compile-time-only guarantee over what is really just a JSON string. */
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
      onRescan: () => undefined,
      rescanning: false,
    })
  );
}

describe("LocalFootprintCard — an unrecognized component never crashes the card", () => {
  it("renders `borrowed` with its held-for-others label, in the legend and by vault", () => {
    const html = render(
      report({
        components: [{ component: "borrowed", bytes: GB, files: 4 }],
        vaults: [
          {
            vaultId: "v1",
            bytes: 2 * GB,
            components: [{ component: "borrowed", bytes: 2 * GB, files: 8 }],
          },
        ],
      })
    );
    expect(html).toContain("Held for others");
  });

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
