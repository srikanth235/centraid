import { beforeEach, describe, expect, test } from "vitest";

import { sweepBlobStaging } from "../blob/staging.js";
import { blobUriFor, sha256OfBytes } from "../blob/store.js";
import { bootstrapVault } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import type { Identity } from "../gateway/types.js";
import { parseMbox } from "./mbox.js";
import { PUBLISHERS } from "./publishers.js";
import { stageFile } from "./stage-file.js";
import { discardBatch, publishBatch } from "./staging.js";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

function mboxWithAttachment(): string {
  const b64 = PNG_BYTES.toString("base64");
  return [
    "From alice@example.com Mon Jun  3 10:00:00 2024",
    'From: "Alice Roy" <alice@example.com>',
    "Subject: Receipt for the lamp",
    "Date: Mon, 3 Jun 2024 10:00:00 +0000",
    "Message-ID: <lamp-1@example.com>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="XYZ"',
    "",
    "--XYZ",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Here is the receipt you asked for.",
    "--XYZ",
    'Content-Type: image/png; name="receipt.png"',
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="receipt.png"',
    "",
    b64,
    "--XYZ--",
    "",
  ].join("\n");
}

describe("mbox-attachments", () => {
  let db: VaultDb;
  let owner: Identity;

  beforeEach(() => {
    db = openVaultDb();
    const boot: BootstrapResult = bootstrapVault(db, { ownerName: "Priya" });
    owner = {
      kind: "owner-device",
      callerId: boot.deviceId,
      provAgentKind: "owner",
      partyId: boot.ownerPartyId,
      mayAct: true,
    };
  });

  test("parseMbox walks MIME: plain body extracted, attachment decoded", () => {
    const messages = parseMbox(mboxWithAttachment());
    expect(messages).toHaveLength(1);
    const msg = messages[0]!;
    expect(msg.body).toBe("Here is the receipt you asked for.");
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0]!.filename).toBe("receipt.png");
    expect(msg.attachments[0]!.mediaType).toBe("application/octet-stream");
    expect(msg.attachments[0]!.data.equals(PNG_BYTES)).toBe(true);
  });

  test("a lying email Content-Type cannot stage attacker-chosen media types (issue #865)", () => {
    const b64 = PNG_BYTES.toString("base64");
    const mbox = [
      "From mallory@example.com Mon Jun  3 10:00:00 2024",
      'From: "Mallory" <mallory@example.com>',
      "Subject: invoice",
      "Date: Mon, 3 Jun 2024 10:00:00 +0000",
      "Message-ID: <lie-1@example.com>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="XYZ"',
      "",
      "--XYZ",
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="invoice.png"',
      "",
      b64,
      "--XYZ--",
      "",
    ].join("\n");
    const staged = stageFile(db, owner, {
      filename: "mail.mbox",
      data: mbox,
    });
    void staged;
    const sha = sha256OfBytes(PNG_BYTES);
    const row = db.vault
      .prepare("SELECT media_type FROM blob_staging WHERE sha256 = ?")
      .get(sha) as { media_type: string };
    expect(row.media_type).toBe("image/png");
  });

  test("stage → publish: attachment bytes claim onto the message with an edge", () => {
    const staged = stageFile(db, owner, {
      filename: "mail.mbox",
      data: mboxWithAttachment(),
    });
    const sha = sha256OfBytes(PNG_BYTES);
    const hold = db.vault
      .prepare("SELECT held_by_batch FROM blob_staging WHERE sha256 = ?")
      .get(sha) as { held_by_batch: string | null };
    expect(hold.held_by_batch).toBe(staged.batchId);
    expect(sweepBlobStaging(db, { ttlHours: -1 }).expired).toStrictEqual([]); // held = immune

    const published = publishBatch(db, owner, staged.batchId, PUBLISHERS);
    expect(published.created).toBe(1);
    expect(published.failed).toStrictEqual([]);
    const message = db.vault
      .prepare(
        "SELECT message_id FROM social_message WHERE external_id = 'lamp-1@example.com'"
      )
      .get() as { message_id: string };
    const attachment = db.vault
      .prepare(
        `SELECT a.content_id, c.content_uri, c.media_type, c.title
         FROM core_attachment a JOIN core_content_item c ON c.content_id = a.content_id
        WHERE a.target_type = 'social.message' AND a.target_id = ?`
      )
      .get(message.message_id) as Record<string, string>;
    expect(attachment.content_uri).toBe(blobUriFor(sha));
    expect(attachment.media_type).toBe("image/png");
    expect(attachment.title).toBe("receipt.png");
    expect({
      ...db.vault.prepare("SELECT count(*) AS n FROM blob_staging").get(),
    }).toStrictEqual({
      n: 0,
    });
    expect(db.blobs.hasSync(sha)).toBe(true);
  });

  test("stage → discard: hold releases and the TTL sweep reclaims the bytes", () => {
    const staged = stageFile(db, owner, {
      filename: "mail.mbox",
      data: mboxWithAttachment(),
    });
    const sha = sha256OfBytes(PNG_BYTES);
    discardBatch(db, owner, staged.batchId);
    db.vault
      .prepare("UPDATE blob_staging SET staged_at = ?")
      .run("2000-01-01T00:00:00.000Z");
    const swept = sweepBlobStaging(db, {});
    expect(swept.expired).toContain(sha);
    expect(db.blobs.hasSync(sha)).toBe(false);
  });
});
