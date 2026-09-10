import { assert, beforeEach, describe, expect, test } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import type { Gateway } from "../gateway/gateway.js";
import { createGateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import { registerAttachmentCommands } from "./attachments.js";
import { registerDocumentCommands } from "./documents.js";

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

describe("documents: purge", () => {
  beforeEach(() => {
    db = openVaultDb();
    boot = bootstrapVault(db, { ownerName: "Priya" });
    gw = createGateway(db);
    registerDocumentCommands(gw);
    registerAttachmentCommands(gw);
    owner = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
  });

  function invoke(command: string, input: Record<string, unknown>) {
    return gw.invoke(owner, {
      command,
      input,
    });
  }

  function addDocument(input: Record<string, unknown>) {
    const outcome = invoke("core.add_document", input);
    expect(outcome.status).toBe("executed");
    const output = (
      outcome as { output: { document_id: string; content_id: string } }
    ).output;
    return { documentId: output.document_id, contentId: output.content_id };
  }

  test("trash + purge of a document with a version chain releases every exclusively-owned revision", () => {
    const { documentId, contentId: v1 } = addDocument({
      data_uri: "data:text/plain;charset=utf-8,v1",
      title: "Doc.txt",
    });
    const v2 = (
      invoke("core.edit_document", {
        document_id: documentId,
        body_text: "v2",
      }) as {
        output: { content_id: string };
      }
    ).output.content_id;
    invoke("core.trash_document", { document_id: documentId });
    db.vault
      .prepare("UPDATE core_document SET purge_at = ? WHERE document_id = ?")
      .run("2000-01-01T00:00:00.000Z", documentId);
    expect(gw.sweep(owner).documentsPurged).toBe(1);
    expect(
      db.vault
        .prepare("SELECT 1 FROM core_document WHERE document_id = ?")
        .get(documentId)
    ).toBeUndefined();
    for (const id of [v1, v2])
      expect(
        db.vault
          .prepare("SELECT 1 FROM core_content_item WHERE content_id = ?")
          .get(id)
      ).toBeUndefined();
  });

  test("purge protects a superseded revision still shared with a live document", () => {
    const { documentId, contentId: shared } = addDocument({
      data_uri: "data:text/plain;charset=utf-8,shared%20text",
      title: "A.txt",
    });
    const other = addDocument({
      data_uri: "data:text/plain;charset=utf-8,shared%20text",
      title: "B.txt",
    });
    expect(other.contentId).toBe(shared);
    invoke("core.edit_document", {
      document_id: other.documentId,
      body_text: "B moved on",
    });
    invoke("core.trash_document", { document_id: other.documentId });
    db.vault
      .prepare("UPDATE core_document SET purge_at = ? WHERE document_id = ?")
      .run("2000-01-01T00:00:00.000Z", other.documentId);
    gw.sweep(owner);
    expect(
      db.vault
        .prepare("SELECT 1 FROM core_document WHERE document_id = ?")
        .get(other.documentId)
    ).toBeUndefined();
    expect(
      db.vault
        .prepare("SELECT 1 FROM core_content_item WHERE content_id = ?")
        .get(shared)
    ).toBeTruthy();
    const stillCurrent = db.vault
      .prepare(
        "SELECT current_content_id FROM core_document WHERE document_id = ?"
      )
      .get(documentId) as { current_content_id: string };
    expect(stillCurrent.current_content_id).toBe(shared);
  });

  test("trash_document refuses on an unknown or already-trashed document", () => {
    const { documentId } = addDocument({
      data_uri: "data:application/pdf;base64,JVBERi0xLjQKJcTl8uXrp/Og0MTGCg==",
      title: "Once.pdf",
    });
    expect(
      invoke("core.trash_document", { document_id: documentId }).status
    ).toBe("executed");
    const again = invoke("core.trash_document", { document_id: documentId });
    expect(again.status).toBe("failed");
    assert(again.status === "failed");
    expect(again.predicate).toContain("document_exists");
  });
  test("empty_document_trash is a no-op on an empty trash, and a live document is untouched", () => {
    const { documentId } = addDocument({
      data_uri: "data:text/plain;charset=utf-8,live",
      title: "Live.txt",
    });
    const outcome = invoke("core.empty_document_trash", {});
    expect(outcome.status).toBe("executed");
    expect(
      (outcome as { output: { documents_released: number } }).output
        .documents_released
    ).toBe(0);
    const row = db.vault
      .prepare(
        "SELECT deleted_at, purge_at FROM core_document WHERE document_id = ?"
      )
      .get(documentId) as {
      deleted_at: string | null;
      purge_at: string | null;
    };
    expect(row.deleted_at).toBeNull();
    expect(row.purge_at).toBeNull();
  });

  test("empty_document_trash collapses the window on every trashed document and the sweep destroys them", () => {
    const first = addDocument({
      data_uri: "data:text/plain;charset=utf-8,one",
      title: "One.txt",
    });
    const second = addDocument({
      data_uri: "data:text/plain;charset=utf-8,two",
      title: "Two.txt",
    });
    const kept = addDocument({
      data_uri: "data:text/plain;charset=utf-8,kept",
      title: "Kept.txt",
    });
    invoke("core.trash_document", { document_id: first.documentId });
    invoke("core.trash_document", { document_id: second.documentId });
    // Trashing alone leaves a 30-day window: nothing lapses yet.
    expect(gw.sweep(owner).documentsPurged).toBe(0);

    const outcome = invoke("core.empty_document_trash", {});
    expect(outcome.status).toBe("executed");
    expect(
      (outcome as { output: { documents_released: number } }).output
        .documents_released
    ).toBe(2);
    for (const id of [first.documentId, second.documentId]) {
      const row = db.vault
        .prepare(
          "SELECT deleted_at, purge_at FROM core_document WHERE document_id = ?"
        )
        .get(id) as { deleted_at: string; purge_at: string };
      expect(row.purge_at).toBe(row.deleted_at);
    }

    // Only the sweep destroys — with its rent checks and its receipts intact.
    expect(gw.sweep(owner).documentsPurged).toBe(2);
    for (const id of [first.documentId, second.documentId])
      expect(
        db.vault
          .prepare("SELECT 1 FROM core_document WHERE document_id = ?")
          .get(id)
      ).toBeUndefined();
    expect(
      db.vault
        .prepare("SELECT 1 FROM core_document WHERE document_id = ?")
        .get(kept.documentId)
    ).toBeTruthy();
    expect(
      db.vault
        .prepare("SELECT 1 FROM core_content_item WHERE content_id = ?")
        .get(kept.contentId)
    ).toBeTruthy();
  });

  test("empty_document_trash leaves a restored document alone and can be run twice", () => {
    const { documentId } = addDocument({
      data_uri: "data:text/plain;charset=utf-8,back",
      title: "Back.txt",
    });
    invoke("core.trash_document", { document_id: documentId });
    expect(
      invoke("core.restore_document", { document_id: documentId }).status
    ).toBe("executed");
    expect(invoke("core.empty_document_trash", {}).status).toBe("executed");
    expect(invoke("core.empty_document_trash", {}).status).toBe("executed");
    expect(gw.sweep(owner).documentsPurged).toBe(0);
    expect(
      db.vault
        .prepare("SELECT 1 FROM core_document WHERE document_id = ?")
        .get(documentId)
    ).toBeTruthy();
  });
});
