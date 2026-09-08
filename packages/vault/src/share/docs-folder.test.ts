import { afterEach, describe, expect, test } from "vitest";

import { registerDocumentCommands } from "../commands/documents.js";
import { createGateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import {
  closeOpenVaults,
  household,
  placementAuthority,
  unplaceProjection,
} from "./placement-fixture.js";
import { shareItemsToVault } from "./placement.js";

describe("Docs folder placement", () => {
  afterEach(closeOpenVaults);

  test("uses the folder concept as the container and newly filed documents follow", () => {
    const { origin, originBoot, audience } = household();
    const gateway = createGateway(origin);
    registerDocumentCommands(gateway);
    const owner: Credential = {
      kind: "device",
      deviceId: originBoot.deviceId,
      deviceKey: originBoot.deviceKey,
    };
    const invoke = (command: string, input: Record<string, unknown>) =>
      gateway.invoke(owner, {
        command,
        input,
      });
    const createFolder = (name: string, parent?: string): string => {
      const outcome = invoke("core.create_folder", {
        name,
        ...(parent ? { parent_folder_id: parent } : {}),
      });
      expect(outcome.status).toBe("executed");
      return (outcome as { output: { folder_id: string } }).output.folder_id;
    };
    const addDocument = (folderId: string, title: string): string => {
      const outcome = invoke("core.add_document", {
        folder_id: folderId,
        title,
        data_uri: `data:text/plain,${encodeURIComponent(title)}`,
      });
      expect(outcome.status).toBe("executed");
      return (outcome as { output: { document_id: string } }).output
        .document_id;
    };

    const trip = createFolder("Trip");
    const bookings = createFolder("Bookings", trip);
    const first = addDocument(bookings, "Train tickets");

    const shared = shareItemsToVault({
      origin,
      originVaultId: "vault-priya",
      audience,
      itemType: "docs.folder",
      itemIds: [trip],
      sharedBy: "member-priya",
      authority: placementAuthority(origin, "docs.folder", [trip]),
    });
    expect(shared.items[0]!.itemId).toBe(trip);
    expect(
      audience.vault
        .prepare(
          `SELECT COUNT(*) AS n FROM core_concept
            WHERE concept_id IN (?, ?)`
        )
        .get(trip, bookings)
    ).toMatchObject({ n: 2 });
    expect(
      audience.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM core_document WHERE document_id = ?"
        )
        .get(first)
    ).toMatchObject({ n: 1 });

    const later = addDocument(bookings, "Hotel receipt");
    shareItemsToVault({
      origin,
      originVaultId: "vault-priya",
      audience,
      itemType: "docs.folder",
      itemIds: [trip],
      sharedBy: "member-priya",
      authority: placementAuthority(origin, "docs.folder", [trip]),
    });
    expect(
      audience.vault
        .prepare(
          "SELECT COUNT(*) AS n FROM core_document WHERE document_id = ?"
        )
        .get(later)
    ).toMatchObject({ n: 1 });

    expect(unplaceProjection(audience, "docs.folder", trip).removed).toBe(true);
    expect(
      audience.vault.prepare("SELECT COUNT(*) AS n FROM core_document").get()
    ).toMatchObject({ n: 0 });
    expect(
      audience.vault
        .prepare(
          `SELECT COUNT(*) AS n FROM core_concept
            WHERE concept_id IN (?, ?)`
        )
        .get(trip, bookings)
    ).toMatchObject({ n: 0 });
  });
});
