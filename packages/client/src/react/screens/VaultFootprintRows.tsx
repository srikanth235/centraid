import type { JSX } from "react";

import type { LocalUsageReportDTO } from "../../gateway-client-local-storage.js";
import MeterRows from "../ui/MeterRows.js";
import type { MeterRowDef } from "../ui/MeterRows.js";
import { formatBytes } from "./localUsageView.js";

export default function VaultFootprintRows({
  report,
  ownerLabels,
}: {
  report: LocalUsageReportDTO;
  ownerLabels: ReadonlyMap<string, string>;
}): JSX.Element | null {
  if (report.vaults.length < 2) return null;
  const largest = report.vaults.reduce(
    (best, vault) => Math.max(best, vault.bytes),
    0
  );
  const rows: MeterRowDef[] = report.vaults
    .toSorted((a, b) => b.bytes - a.bytes)
    .map((vault) => {
      const owner = ownerLabels.get(vault.vaultId);
      const named =
        vault.name === undefined || vault.name === "" ? null : vault.name;
      const shareOfMachine =
        report.totalBytes > 0 ? (vault.bytes / report.totalBytes) * 100 : 0;
      return {
        count: formatBytes(vault.bytes),
        id: vault.vaultId,
        name: named ?? (owner ? `${owner}’s vault` : "This vault"),
        pack: named === null ? vault.vaultId.slice(0, 8) : (owner ?? "yours"),
        share: largest > 0 ? (vault.bytes / largest) * 100 : 0,
        when: `${shareOfMachine.toFixed(shareOfMachine >= 10 ? 0 : 1)}% of this machine`,
      };
    });
  return (
    <div data-testid="footprint-by-vault">
      <MeterRows
        ariaLabel="By vault"
        caption="the bar is a share of the largest vault on this machine"
        inertLabel=""
        rows={rows}
      />
    </div>
  );
}
