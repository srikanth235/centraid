/*
 * WHAT WAKES THE DELIVERY LOOP (#1014, S1 + V12) — the two halves of the
 * doorbell contract, kept beside the loop's own tests rather than inside them
 * so neither file outgrows its budget.
 */

import { describe, expect, test, afterEach } from "vitest";

import { uuidv7, blobUriFor } from "@centraid/vault";

import {
  createGrantRefreshDoorbell,
  refreshGrantsAfterCommit,
} from "./grant-fulfillment.js";
import {
  audienceTitles,
  closeOpenVaults,
  inCommit,
  ORIGIN_VAULT,
  sharedWorld,
} from "./grant-fulfillment.test-fixtures.js";

describe("serve/grant-fulfillment — what wakes the loop", () => {
  afterEach(closeOpenVaults);

  test("a row entering an existing grant's closure relays on the cached index (#1014 S1)", () => {
    // Rules the `indexFor` cache OUT as a second cause of S1: after a pass
    // that cached the index, an ordinary content commit — no grant-plane
    // write, so no rebuild — must still follow the subject.
    const world = sharedWorld();
    refreshGrantsAfterCommit({
      host: world.host,
      originVaultId: ORIGIN_VAULT,
      now: world.now,
      touched: ["share.authority"],
    });
    expect(audienceTitles(world.ravi)).toStrictEqual(["Trip plan"]);

    const freshContentId = uuidv7();
    inCommit(world.priya.vault, () => {
      const blob = world.priya.vault.blobs.ingestSync(Buffer.from("day two"));
      world.priya.vault.vault
        .prepare(
          `INSERT INTO core_content_item
             (content_id, content_uri, sha256, byte_size, language,
              creator_party_id, origin_device_id, deleted_at, purge_at, created_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?)`
        )
        .run(
          freshContentId,
          blobUriFor(blob.sha256),
          blob.sha256,
          blob.byteSize,
          world.priya.boot.ownerPartyId,
          world.priya.boot.deviceId,
          world.now
        );
      world.priya.vault.vault
        .prepare(
          "UPDATE core_document SET current_content_id = ? WHERE document_id = ?"
        )
        .run(freshContentId, world.documentId);
    });

    const pass = refreshGrantsAfterCommit({
      host: world.host,
      originVaultId: ORIGIN_VAULT,
      now: world.now,
      // Exactly what the post-commit doorbell carries for this write.
      touched: ["core.content_item", "core.document"],
    });
    expect(pass.origin).toBe("mounted");
    expect(
      (
        world.ravi.vault.vault
          .prepare(
            "SELECT current_content_id AS id FROM core_document WHERE document_id = ?"
          )
          .get(world.documentId) as { id: string } | undefined
      )?.id
    ).toBe(freshContentId);
  });

  test("a ring that names NO entity types walks everything (#1014 V12)", () => {
    // A sweep, an import or a purge rings provenance without saying what it
    // touched. `undefined` is the doorbell's word for "walk everything"; `[]`
    // is "this commit moved nothing a grant could care about", and the two
    // must not be collapsed — `build-gateway.ts` used to send `[]` for both.
    const world = sharedWorld();
    const doorbell = createGrantRefreshDoorbell({ host: world.host });
    doorbell.ring(ORIGIN_VAULT, undefined);
    expect(audienceTitles(world.ravi)).toStrictEqual(["Trip plan"]);

    inCommit(world.priya.vault, () =>
      world.priya.vault.vault
        .prepare("UPDATE core_document SET title = ? WHERE document_id = ?")
        .run("Trip plan (final)", world.documentId)
    );
    // An empty hint is a real answer: nothing moved, so nothing is walked.
    expect(
      refreshGrantsAfterCommit({
        host: world.host,
        originVaultId: ORIGIN_VAULT,
        now: world.now,
        touched: [],
      })
    ).toStrictEqual({ origin: "mounted", reports: [] });
    expect(audienceTitles(world.ravi)).toStrictEqual(["Trip plan"]);

    // No hint at all is not: the loop walks every live grant subject.
    const pass = refreshGrantsAfterCommit({
      host: world.host,
      originVaultId: ORIGIN_VAULT,
      now: world.now,
    });
    expect(pass.origin).toBe("mounted");
    expect(audienceTitles(world.ravi)).toStrictEqual(["Trip plan (final)"]);
    doorbell.stop();
  });
});
