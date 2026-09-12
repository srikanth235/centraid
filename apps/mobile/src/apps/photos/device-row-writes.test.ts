// A photograph this phone holds and the vault has not got yet (#1014, R17).
// The viewer used to refuse a caption on one with "Read-only vault — ask its
// owner for write access": an owner who is the member themselves, about a
// vault that would take the write the moment the row arrived.

import { describe, expect, test } from "vitest";

import { READ_ONLY_SOURCE_REASON } from "../../kit/replica/row-provenance";
import {
  isReadOnlyRefusal,
  NOT_IN_A_VAULT_YET_REASON,
  viewerWriteRefusal,
} from "./viewer-model";

describe("writing on a device-only row", () => {
  test("a row with no vault copy is never refused as read-only", () => {
    expect(viewerWriteRefusal({ writable: false, hasVaultAsset: false })).toBe(
      NOT_IN_A_VAULT_YET_REASON
    );
    expect(
      isReadOnlyRefusal(
        viewerWriteRefusal({ writable: false, hasVaultAsset: false })
      )
    ).toBe(false);
  });

  test("a vault row the member may not write still says read-only", () => {
    expect(viewerWriteRefusal({ writable: false, hasVaultAsset: true })).toBe(
      READ_ONLY_SOURCE_REASON
    );
    expect(
      isReadOnlyRefusal(
        viewerWriteRefusal({ writable: false, hasVaultAsset: true })
      )
    ).toBe(true);
  });

  test("a writable vault row refuses nothing", () => {
    expect(
      viewerWriteRefusal({ writable: true, hasVaultAsset: true })
    ).toBeUndefined();
  });
});
