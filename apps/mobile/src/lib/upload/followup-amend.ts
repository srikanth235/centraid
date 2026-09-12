// A CAPTION TYPED BEFORE THE ROW EXISTS (#1014, R17).
//
// A device-only photograph is one this phone has queued and the vault has not
// got yet, so there is no row to write a caption onto — but there IS a write
// on its way. The caption is merged into that unreplayed follow-up's input and
// travels with it.
//
// Only an UNTRIED follow-up is amended. A follow-up's intent id is derived
// from its input, and once a replay has been attempted that id is inside the
// gateway's idempotency window: moving it would let the same write execute a
// second time under a new name.

import type { UploadSqliteDriver } from "../replica/expo-sqlite-driver";
import { stableFollowupIntentId, toUploadFollowup } from "./followup-record";
import type {
  PersistedUploadFollowupRow,
  UploadFollowup,
} from "./followup-record";

export function amendUploadFollowupInput(
  driver: UploadSqliteDriver,
  itemId: string,
  patch: Record<string, unknown>
): UploadFollowup[] {
  const rows = driver.all<PersistedUploadFollowupRow>(
    `SELECT * FROM upload_followup
      WHERE item_id = ? AND attempts = 0 AND poisoned_at IS NULL`,
    [itemId]
  );
  return rows.map((row) => {
    const input = {
      ...(JSON.parse(row.input_json) as Record<string, unknown>),
      ...patch,
    };
    const inputJson = JSON.stringify(input);
    const intentId = stableFollowupIntentId(
      itemId,
      row.shape,
      row.action,
      inputJson
    );
    driver.run(
      "UPDATE upload_followup SET input_json = ?, intent_id = ? WHERE followup_id = ?",
      [inputJson, intentId, row.followup_id]
    );
    return toUploadFollowup({
      ...row,
      input_json: inputJson,
      intent_id: intentId,
    });
  });
}
