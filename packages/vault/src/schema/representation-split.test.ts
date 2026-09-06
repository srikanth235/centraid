// THE REPRESENTATION SPLIT — scenarios (#996 wave 0b, ruling R20(b), drift
// ONT-28), each driven through real commands and read back the way a screen
// reads it, never by asserting on a column this change is about.
//
//   1. ONE BYTE ROW, TWO READINGS. The same bytes filed as two documents —
//      one HTML, one plain text — used to take the FIRST import's media type
//      forever, because it lived on the sha-deduped row. Each owner now reads
//      its own way, byte dedupe untouched.
//   2. A GENERATED CAPTION IS A DERIVED ROW. It hangs from the representation
//      (OQ-9); the owner's typed title survives a re-caption; and the one-tap
//      promote copies the caption into the asset's AUTHORED title while the
//      derived row stays what it was.
//   3. THE READ DOOR SERVES THE REPRESENTATION'S TYPE. Mint → read-door round
//      trip, with the type coming from the owner's reading of the bytes.

import { beforeEach, afterEach, describe, expect, test } from "vitest";

import { resolveServableBlob } from "../blob/read.js";
import { bootstrapVault, enrollAgent, enrollDevice } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { registerDocumentCommands } from "../commands/documents.js";
import { registerKnowledgeCommands } from "../commands/knowledge.js";
import { registerMediaCommands } from "../commands/media.js";
import { registerSyncCommands } from "../commands/sync.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { createGateway } from "../gateway/gateway.js";
import type { Gateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import { answerScopes } from "../grant/automation-principal.test-fixtures.js";
import { mediaTypeOfOwner, representationIdOf } from "./representation.js";

/** One transparent pixel — real bytes, so the staging door and CAS are real. */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

/** The SAME bytes, offered twice under two different declared types. */
const SHARED_BODY = "<p>Ship it.</p>";
const AS_HTML = `data:text/html;charset=utf-8,${encodeURIComponent(SHARED_BODY)}`;
const AS_TEXT = `data:text/plain;charset=utf-8,${encodeURIComponent(SHARED_BODY)}`;

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;
let agent: Credential;

describe("the representation split (#996, R20(b))", () => {
  beforeEach(() => {
    db = openVaultDb();
    boot = bootstrapVault(db, { ownerName: "Priya" });
    gw = createGateway(db);
    registerDocumentCommands(gw);
    registerKnowledgeCommands(gw);
    registerMediaCommands(gw);
    registerSyncCommands(gw);
    owner = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
    const enrolled = enrollAgent(db, {
      name: "vision",
      modelRef: "tier:fast",
    });
    const device = enrollDevice(db, boot.ownerPartyId, "agent-host");
    answerScopes(db, boot, "vision", [
      { schema: "sync", verbs: "act" },
      { schema: "core", verbs: "read+act" },
      { schema: "media", verbs: "read" },
      { schema: "knowledge", verbs: "read" },
    ]);
    agent = {
      kind: "agent",
      agentId: enrolled.agentId,
      deviceId: device.deviceId,
      deviceKey: device.deviceKey,
    };
  });

  afterEach(() => {
    db.close();
  });

  function output<T>(outcome: unknown): T {
    return (outcome as { output: T }).output;
  }

  function invoke(
    cred: Credential,
    command: string,
    input: Record<string, unknown>
  ): unknown {
    const outcome = gw.invoke(cred, { command, input });
    expect(
      (outcome as { status: string; reason?: string }).status,
      `${command}: ${(outcome as { reason?: string }).reason ?? ""}`
    ).toBe("executed");
    return outcome;
  }

  test("one byte row, two owners, two readings — and the dedupe survives", () => {
    const asHtml = output<{ document_id: string; content_id: string }>(
      invoke(owner, "core.add_document", {
        data_uri: AS_HTML,
        title: "Ship it (page)",
      })
    );
    const asText = output<{
      document_id: string;
      content_id: string;
      deduped: number;
    }>(
      invoke(owner, "core.add_document", {
        data_uri: AS_TEXT,
        title: "Ship it (notes)",
      })
    );

    // ONE row of bytes: the second filing deduped on the sha.
    expect(asText.content_id).toBe(asHtml.content_id);
    expect(asText.deduped).toBe(1);
    expect(
      (
        db.vault
          .prepare("SELECT count(*) AS n FROM core_content_item")
          .get() as { n: number }
      ).n
    ).toBe(1);

    // TWO readings, each its owner's own — the ONT-28 defect, refused.
    const readingOf = (documentId: string): string | null =>
      mediaTypeOfOwner(db.vault, {
        ownerType: "core.document",
        ownerId: documentId,
      });
    expect(readingOf(asHtml.document_id)).toBe("text/html");
    expect(readingOf(asText.document_id)).toBe("text/plain");

    // And the bytes themselves say nothing about how to read them.
    expect(
      db.vault
        .prepare("PRAGMA table_info(core_content_item)")
        .all()
        .map((column) => (column as { name: string }).name)
    ).not.toContain("media_type");
  });

  test("a note and a document over identical bytes each keep their own format", () => {
    const note = output<{ note_id: string; body_content_id: string }>(
      invoke(owner, "knowledge.create_note", {
        title: "Ship it",
        body_text: SHARED_BODY,
        format: "html",
      })
    );
    const doc = output<{ document_id: string; content_id: string }>(
      invoke(owner, "core.add_document", {
        data_uri: AS_TEXT,
        title: "Ship it",
      })
    );
    expect(doc.content_id).toBe(note.body_content_id);
    expect(
      mediaTypeOfOwner(db.vault, {
        ownerType: "knowledge.note",
        ownerId: note.note_id,
      })
    ).toBe("text/html");
    expect(
      mediaTypeOfOwner(db.vault, {
        ownerType: "core.document",
        ownerId: doc.document_id,
      })
    ).toBe("text/plain");
  });

  test("a generated caption is a derived row; the owner's title survives it; promote is an authored write", () => {
    const staged = gw.stageBlob(owner, {
      bytes: PNG_BYTES,
      filename: "pixel.png",
    });
    const asset = output<{ asset_id: string; content_id: string }>(
      invoke(owner, "media.add_asset", { staged_sha: staged.sha256 })
    );
    invoke(owner, "media.update_asset", {
      asset_id: asset.asset_id,
      title: "Kite day",
    });

    const titleOf = (): string | null =>
      (
        db.vault
          .prepare("SELECT title FROM media_asset WHERE asset_id = ?")
          .get(asset.asset_id) as { title: string | null }
      ).title;

    const caption = (body: string): void => {
      const staged2 = output<{ connection_id: string }>(
        invoke(agent, "sync.stage_rows", {
          kind: "enrichment.vision",
          label: "photos",
          rows: [
            {
              entity_type: "knowledge.annotation",
              external_id: `${asset.asset_id}:caption`,
              payload: {
                target_type: "media.asset",
                target_id: asset.asset_id,
                body,
              },
            },
          ],
        })
      );
      invoke(owner, "sync.publish_batch", {
        batch_id: output<{ batch_id: string }>(
          gw.invoke(agent, {
            command: "sync.stage_rows",
            input: {
              connection_id: staged2.connection_id,
              rows: [
                {
                  entity_type: "knowledge.annotation",
                  external_id: `${asset.asset_id}:caption`,
                  payload: {
                    target_type: "media.asset",
                    target_id: asset.asset_id,
                    body,
                  },
                },
              ],
            },
          })
        ).batch_id,
      });
    };

    caption("two kids flying a kite");
    const representationId = representationIdOf(db.vault, {
      ownerType: "media.asset",
      ownerId: asset.asset_id,
    });
    expect(representationId).not.toBeNull();

    // DERIVED ROWS NEVER PROJECT: the caption hangs from the representation,
    // and the owner's typed title is untouched by it.
    const captionRow = (): { body_text: string } | undefined =>
      db.vault
        .prepare(
          `SELECT body_text FROM knowledge_annotation
            WHERE target_type = 'core.content_representation' AND target_id = ?`
        )
        .get(representationId) as { body_text: string } | undefined;
    expect(captionRow()?.body_text).toBe("two kids flying a kite");
    expect(titleOf()).toBe("Kite day");

    // A RE-CAPTION replaces the derived row and still does not touch the title.
    caption("a red kite over the sea");
    expect(captionRow()?.body_text).toBe("a red kite over the sea");
    expect(titleOf()).toBe("Kite day");

    // OQ-9's ONE-TAP PROMOTE: an authored write, and the derived row stays.
    const promoted = output<{ title: string }>(
      invoke(owner, "media.promote_caption", { asset_id: asset.asset_id })
    );
    expect(promoted.title).toBe("a red kite over the sea");
    expect(titleOf()).toBe("a red kite over the sea");
    expect(captionRow()?.body_text).toBe("a red kite over the sea");
  });

  test("mint → read door: the door serves the representation's media type", () => {
    const staged = gw.stageBlob(owner, {
      bytes: PNG_BYTES,
      filename: "pixel.png",
    });
    const asset = output<{ asset_id: string; content_id: string }>(
      invoke(owner, "media.add_asset", { staged_sha: staged.sha256 })
    );
    invoke(owner, "media.update_asset", {
      asset_id: asset.asset_id,
      title: "Kite day",
    });

    const served = resolveServableBlob(db.vault, asset.content_id);
    expect(served.status).toBe("ok");
    if (served.status !== "ok") return;
    expect(served.blob.mediaType).toBe("image/png");
    expect(served.blob.sha256).toBe(staged.sha256);
    // The door's title is the WRAPPER's, since bytes have none.
    expect(served.blob.title).toBe("Kite day");

    // Re-typing the asset's reading changes what the door serves; the bytes
    // are untouched.
    db.vault
      .prepare(
        `UPDATE core_content_representation SET media_type = 'image/x-icon'
          WHERE owner_type = 'media.asset' AND owner_id = ?`
      )
      .run(asset.asset_id);
    const again = resolveServableBlob(db.vault, asset.content_id);
    expect(again.status === "ok" && again.blob.mediaType).toBe("image/x-icon");
    expect(again.status === "ok" && again.blob.sha256).toBe(staged.sha256);
  });
});
