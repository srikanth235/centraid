import type { JSX } from "react";

import type { LocalUsageReportDTO } from "../../gateway-client-local-storage.js";
import MeterRows from "../ui/MeterRows.js";
import type { MeterRowDef } from "../ui/MeterRows.js";
import { formatBytes } from "./localUsageView.js";

/**
 * One row per vault, each drawing its share.
 *
 * NOT A COLLAPSED `<details>` LABELLED "By vault" (#814). Whose bytes these
 * are is the second question anyone asks of a disk figure, and on a gateway
 * hosting someone else's vault it is the first — "2.1 GB · held here for Tom,
 * who can revoke this machine at any time" is a custody fact, and a custody
 * fact may not be folded shut behind a summary nobody opens. They are meter
 * rows so the ordering reads before the numbers do.
 *
 * The bar is a share of the LARGEST vault, matching every other meter list in
 * the app: on a gateway holding one big vault and three small ones, shares of
 * the total would be one full bar and three invisible slivers.
 */
export default function VaultFootprintRows({
  report,
  ownerLabels,
}: {
  report: LocalUsageReportDTO;
  /** vaultId → owning person's label — what hosting this vault costs THEM
   *  (#726). Absent entries render the vault name alone. */
  ownerLabels: ReadonlyMap<string, string>;
}): JSX.Element | null {
  // ONE VAULT NEEDS NO BREAKDOWN. A single row here is the headline figure
  // said a second time, with a bar that is necessarily full because the only
  // vault is also the largest one — a picture of nothing, under a caption
  // explaining what the picture would have meant. The block exists for the
  // case the handoff draws: several vaults, one of them somebody else's, where
  // "2.1 GB · held here for Tom" is a custody fact and the ordering is the
  // finding. Below two, the rail and its legend have already answered.
  if (report.vaults.length < 2) return null;
  const largest = report.vaults.reduce(
    (best, vault) => Math.max(best, vault.bytes),
    0
  );
  const rows: MeterRowDef[] = report.vaults
    .toSorted((a, b) => b.bytes - a.bytes)
    .map((vault) => {
      const owner = ownerLabels.get(vault.vaultId);
      // NEVER A RAW ID AS THE LABEL. An unnamed vault rendered as `01a00fed`
      // is not a name — it is the absence of one, printed.
      // The person it belongs to is the next best answer, and the id moves to
      // the second line where it is still available to quote at support.
      const named =
        vault.name === undefined || vault.name === "" ? null : vault.name;
      // The trailing cell is one short reading, not a sentence. A per-vault
      // COMPONENT split wraps into four lines in a cell built for the word
      // "Quiet" — and the legend directly above already breaks the machine
      // down by component, so it would be a second answer to a question
      // already answered. What is NOT above it is how much
      // of this machine each vault is responsible for, which is the whole point
      // of listing them separately.
      const shareOfMachine =
        report.totalBytes > 0 ? (vault.bytes / report.totalBytes) * 100 : 0;
      return {
        count: formatBytes(vault.bytes),
        id: vault.vaultId,
        name: named ?? (owner ? `${owner}’s vault` : "This vault"),
        // Whose it is, said on the row rather than in a parenthesis.
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
