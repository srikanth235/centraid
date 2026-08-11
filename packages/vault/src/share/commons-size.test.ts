import { afterEach, describe, expect, test } from "vitest";

import { registerTallyCommands } from "../commands/tally.js";
import { createGateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import { nowIso } from "../ids.js";
import { listCommonsGrants } from "./commons-lifecycle.js";
import {
  commonsClosure,
  commonsClosureSizeBytes,
  commonsCurrentSize,
  compileCommons,
  createCommonsGrant,
} from "./commons.js";
import { closeOpenVaults, household, seedPhoto } from "./placement-fixture.js";

describe("Commons full-copy size", () => {
  afterEach(closeOpenVaults);

  test("counts row-only wire bytes and enforces the exact maximum", () => {
    const { origin, originBoot } = household();
    const gateway = createGateway(origin);
    registerTallyCommands(gateway);
    const credential: Credential = {
      kind: "device",
      deviceId: originBoot.deviceId,
      deviceKey: originBoot.deviceKey,
    };
    const created = gateway.invoke(credential, {
      command: "tally.create_group",
      input: { name: "Row only", icon: "🧾", member_ids: [] },
    });
    if (created.status !== "executed")
      throw new Error(`group creation failed: ${JSON.stringify(created)}`);
    const groupId = (created.output as { group_id: string }).group_id;
    const grant = createCommonsGrant({
      origin: origin.vault,
      ownerPartyId: originBoot.ownerPartyId,
      ownerVaultId: "vault-priya",
      ownerVault: origin,
      containerType: "tally.group",
      containerId: groupId,
      members: [],
      now: nowIso(),
    });
    const closure = commonsClosure(origin.vault, "vault-priya", grant);
    const size = commonsClosureSizeBytes(closure);
    expect(closure.blobs).toStrictEqual([]);
    expect(size).toBe(Buffer.byteLength(JSON.stringify(closure), "utf8"));
    expect(size).toBeGreaterThan(0);
    expect(commonsCurrentSize(origin.vault, "vault-priya", grant.grantId)).toBe(
      size
    );

    origin.vault
      .prepare(
        "UPDATE share_circle_grant SET max_size_bytes = ? WHERE grant_id = ?"
      )
      .run(size, grant.grantId);
    compileCommons({
      steward: origin,
      stewardVaultId: "vault-priya",
      grantId: grant.grantId,
      seats: [],
      now: nowIso(),
    });
    expect(listCommonsGrants(origin.vault)[0]?.currentSizeBytes).toBe(size);
    origin.vault
      .prepare(
        "UPDATE share_circle_grant SET max_size_bytes = ? WHERE grant_id = ?"
      )
      .run(size - 1, grant.grantId);
    expect(() =>
      compileCommons({
        steward: origin,
        stewardVaultId: "vault-priya",
        grantId: grant.grantId,
        seats: [],
        now: nowIso(),
      })
    ).toThrow(
      `commons closure is ${size} bytes, above its ${size - 1} byte maximum`
    );
  });

  test("adds each deduplicated content payload exactly once", () => {
    const { origin, originBoot } = household();
    const photo = seedPhoto(origin, originBoot, "sized-photo");
    const grant = createCommonsGrant({
      origin: origin.vault,
      ownerPartyId: originBoot.ownerPartyId,
      ownerVaultId: "vault-priya",
      ownerVault: origin,
      containerType: "media.asset",
      containerId: photo.assetId,
      members: [],
      now: nowIso(),
    });
    const closure = commonsClosure(origin.vault, "vault-priya", grant);
    expect(closure.blobs).toStrictEqual([
      expect.objectContaining({
        sha256: photo.sha256,
        size: photo.bytes.length,
      }),
    ]);
    expect(commonsClosureSizeBytes(closure)).toBe(
      Buffer.byteLength(JSON.stringify(closure), "utf8") + photo.bytes.length
    );
  });
});
