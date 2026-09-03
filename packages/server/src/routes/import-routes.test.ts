import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";

import { afterEach, describe, expect, test } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { seedYear3Vault } from "@centraid/test-kit/year3-vault";
import {
  readZipEntries,
  sealAad,
  sealValue,
  unsealValue,
  verifyPortableVault,
} from "@centraid/vault";

import { openVaultPlane } from "../serve/vault-plane.js";
import type { VaultPlane } from "../serve/vault-plane.js";
import { makeImportRouteHandler } from "./import-routes.js";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const cleanups: Array<() => Promise<void> | void> = [];
describe("import-routes", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });

  async function fixture(): Promise<{
    base: string;
    dir: string;
    plane: VaultPlane;
    replacePlane: (plane: VaultPlane) => void;
  }> {
    const dir = await tempDir(`import-routes-${crypto.randomUUID()}-`);
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const plane = openVaultPlane({
      bootstrap: true,
      dir,
      logger: silentLogger,
      ownerName: "Priya",
    });
    cleanups.push(() => plane.stop());
    let currentPlane = plane;
    const handler = makeImportRouteHandler({ current: () => currentPlane });
    const server = http.createServer((req, res) => {
      void handler(req, res).then((handled) => {
        if (!handled) {
          res.statusCode = 404;
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    );
    const address = server.address() as { port: number };
    return {
      base: `http://127.0.0.1:${address.port}/centraid/_vault/imports`,
      dir,
      plane,
      replacePlane: (replacement) => {
        currentPlane = replacement;
      },
    };
  }

  const PASSPHRASE = "correct horse battery staple";

  const ICS = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:evt-9@example.com",
    "SUMMARY:Housewarming",
    "DTSTART:20260710T160000Z",
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  test("stage over HTTP → review rows → publish → history", async () => {
    const { base, plane } = await fixture();

    const staged = (await (
      await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: "party.ics", text: ICS }),
      })
    ).json()) as { batchId: string; kind: string; staged: { create: number } };
    expect(staged.kind).toBe("file.ics");
    expect(staged.staged.create).toBe(1);

    const review = (await (
      await fetch(`${base}/${staged.batchId}`)
    ).json()) as {
      rows: { disposition: string; entityType: string }[];
    };
    expect(review.rows).toStrictEqual([
      expect.objectContaining({
        disposition: "create",
        entityType: "core.event",
      }),
    ]);

    const published = (await (
      await fetch(`${base}/${staged.batchId}/publish`, { method: "POST" })
    ).json()) as { created: number };
    expect(published.created).toBe(1);
    const event = plane.db.vault
      .prepare("SELECT summary FROM core_event WHERE ical_uid = ?")
      .get("evt-9@example.com") as { summary: string };
    expect(event.summary).toBe("Housewarming");

    const listed = (await (await fetch(base)).json()) as {
      batches: { status: string; label: string }[];
    };
    expect(listed.batches[0]).toMatchObject({
      status: "published",
      label: "party.ics",
    });
  });

  test("HTTP export → staged reimport → HTTP re-export preserves the seeded artifact", async () => {
    const source = await fixture();
    seedYear3Vault(
      {
        vault: source.plane.db.vault,
        sealCell: (entity, column, rowId, plaintext) =>
          sealValue(
            source.plane.db.sealKey,
            sealAad(entity.replace(".", "_"), column, rowId),
            plaintext
          ),
      },
      { parties: 7, photos: 31, conversations: 3, turnsPerConversation: 4 }
    );
    const sourceItem = source.plane.db.vault
      .prepare(
        `SELECT item_id, password FROM locker_item
          WHERE password IS NOT NULL ORDER BY item_id LIMIT 1`
      )
      .get() as { item_id: string; password: string };
    const sourceSealedPassword = unsealValue(
      source.plane.db.sealKey,
      sealAad("locker_item", "password", sourceItem.item_id),
      sourceItem.password
    );
    const staged = (await (
      await fetch(source.base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: "party.ics", text: ICS }),
      })
    ).json()) as { batchId: string };
    await fetch(`${source.base}/${staged.batchId}/publish`, { method: "POST" });

    const exportedResponse = await fetch(`${source.base}/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: PASSPHRASE }),
    });
    expect(exportedResponse.status).toBe(200);
    expect(exportedResponse.headers.get("cache-control")).toBe("no-store");
    expect(exportedResponse.headers.get("x-centraid-export-sealed")).toBe(
      "recovery-kit"
    );
    const exported = Buffer.from(await exportedResponse.arrayBuffer());
    expect(() => verifyPortableVault(exported)).not.toThrow();
    expect(verifyPortableVault(exported).sealed).toBe("recovery-kit");

    const target = await fixture();
    const importResponse = await fetch(target.base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "centraid-portable-v1.zip",
        base64: exported.toString("base64"),
        replaceFreshVault: true,
        passphrase: PASSPHRASE,
      }),
    });
    const importText = await importResponse.text();
    expect(importResponse.status, importText).toBe(200);
    const imported = JSON.parse(importText) as {
      portable: boolean;
      imported: number;
    };
    expect(imported.portable).toBe(true);
    expect(imported.imported).toBeGreaterThan(0);

    target.plane.stop();
    const reopened = openVaultPlane({
      bootstrap: false,
      dir: target.dir,
      logger: silentLogger,
      enableWalShipper: false,
    });
    cleanups.push(() => reopened.stop());
    target.replacePlane(reopened);

    const reexportResponse = await fetch(`${target.base}/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: PASSPHRASE }),
    });
    const reexported = Buffer.from(await reexportResponse.arrayBuffer());
    expect(reexportResponse.status, reexported.toString("utf8")).toBe(200);
    expect(() => verifyPortableVault(reexported)).not.toThrow();
    const canonicalTables = (bundle: Buffer): Record<string, unknown[]> =>
      (
        JSON.parse(
          readZipEntries(bundle)
            .find((entry) => entry.name === "canonical/vault.json")!
            .data.toString("utf8")
        ) as { tables: Record<string, unknown[]> }
      ).tables;
    const before = canonicalTables(exported);
    const after = canonicalTables(reexported);
    const RESEALED = [
      "core.vault",
      "locker.item",
      "locker.item_field",
      "locker.item_passkey",
      "sync.connection_credential",
    ];
    expect(Object.keys(after).sort()).toStrictEqual(Object.keys(before).sort());
    const differing = Object.keys(before).filter(
      (entity) =>
        JSON.stringify(before[entity]) !== JSON.stringify(after[entity])
    );
    expect(differing.sort()).toStrictEqual([...RESEALED].sort());
    for (const entity of RESEALED) {
      expect(after[entity], entity).toHaveLength(before[entity]!.length);
    }

    const item = reopened.db.vault
      .prepare(
        `SELECT item_id, password FROM locker_item
          WHERE password IS NOT NULL ORDER BY item_id LIMIT 1`
      )
      .get() as { item_id: string; password: string };
    expect(
      unsealValue(
        reopened.db.sealKey,
        sealAad("locker_item", "password", item.item_id),
        item.password
      )
    ).toBe(sourceSealedPassword);

    expect(
      reopened.db.vault
        .prepare("SELECT summary FROM core_event ORDER BY summary")
        .all()
        .map((row) => row.summary)
    ).toContain("Housewarming");
  });

  test("a sealed bundle exported without a passphrase is refused, writing nothing", async () => {
    const source = await fixture();
    const itemId = crypto.randomUUID();
    source.plane.db.vault
      .prepare(
        `INSERT INTO locker_item (item_id, type, title, username, password, created_at)
         VALUES (?, 'login', 'example.com', 'priya', ?, '2026-09-01T00:00:00.000Z')`
      )
      .run(
        itemId,
        sealValue(
          source.plane.db.sealKey,
          sealAad("locker_item", "password", itemId),
          "hunter2-zzyzxsecret"
        )
      );

    const exportedResponse = await fetch(`${source.base}/export`);
    expect(exportedResponse.headers.get("x-centraid-export-sealed")).toBe(
      "ciphertext-only"
    );
    const exported = Buffer.from(await exportedResponse.arrayBuffer());
    expect(exported.indexOf(Buffer.from("hunter2-zzyzxsecret", "utf8"))).toBe(
      -1
    );

    const target = await fixture();
    const before = target.plane.db.vault
      .prepare("SELECT count(*) AS n FROM core_party")
      .get() as { n: number };
    const response = await fetch(target.base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "centraid-portable-v1.zip",
        base64: exported.toString("base64"),
        replaceFreshVault: true,
      }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("sealed value"),
    });
    expect(
      target.plane.db.vault
        .prepare("SELECT count(*) AS n FROM core_party")
        .get()
    ).toMatchObject({ n: before.n });
    expect(
      target.plane.db.vault
        .prepare("SELECT count(*) AS n FROM locker_item")
        .get()
    ).toMatchObject({ n: 0 });
  });

  test("a passphrased bundle restores its sealed cell under the target's own key", async () => {
    const source = await fixture();
    const itemId = crypto.randomUUID();
    source.plane.db.vault
      .prepare(
        `INSERT INTO locker_item (item_id, type, title, username, password, created_at)
         VALUES (?, 'login', 'example.com', 'priya', ?, '2026-09-01T00:00:00.000Z')`
      )
      .run(
        itemId,
        sealValue(
          source.plane.db.sealKey,
          sealAad("locker_item", "password", itemId),
          "hunter2-zzyzxsecret"
        )
      );

    const exportedResponse = await fetch(`${source.base}/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passphrase: PASSPHRASE }),
    });
    expect(exportedResponse.headers.get("x-centraid-export-sealed")).toBe(
      "recovery-kit"
    );
    const exported = Buffer.from(await exportedResponse.arrayBuffer());

    const target = await fixture();
    const targetKey = Buffer.from(target.plane.db.sealKey);
    const response = await fetch(target.base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "centraid-portable-v1.zip",
        base64: exported.toString("base64"),
        replaceFreshVault: true,
        passphrase: PASSPHRASE,
      }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(target.plane.db.sealKey).toStrictEqual(targetKey);
    const stored = target.plane.db.vault
      .prepare("SELECT password FROM locker_item WHERE item_id = ?")
      .get(itemId) as { password: string };
    expect(
      unsealValue(
        targetKey,
        sealAad("locker_item", "password", itemId),
        stored.password
      )
    ).toBe("hunter2-zzyzxsecret");
  });

  test("portable replacement refuses a target that already contains user data", async () => {
    const source = await fixture();
    const exported = Buffer.from(
      await (await fetch(`${source.base}/export`)).arrayBuffer()
    );
    const target = await fixture();
    const staged = (await (
      await fetch(target.base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: "party.ics", text: ICS }),
      })
    ).json()) as { batchId: string };
    await fetch(`${target.base}/${staged.batchId}/publish`, { method: "POST" });
    const response = await fetch(target.base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "centraid-portable-v1.zip",
        base64: exported.toString("base64"),
        replaceFreshVault: true,
      }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("contains user data"),
    });
    expect(
      target.plane.db.vault
        .prepare("SELECT count(*) AS n FROM core_event")
        .get()
    ).toMatchObject({ n: 1 });
  });

  test("an unroutable file is a clean 400, not a hang", async () => {
    const { base } = await fixture();
    const res = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "photo.heic", text: "not really" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/no importer/u);
  });

  test("hostile importer corpus fails closed without creating a draft", async () => {
    const { base, plane } = await fixture();
    const corpus = [
      {
        name: "malformed base64",
        body: { filename: "bad.ics", base64: "not!base64" },
        error: /base64 is malformed/u,
      },
      {
        name: "mis-encoded text",
        body: {
          filename: "bad.vcf",
          base64: Buffer.from([0xff, 0xfe, 0x41, 0]).toString("base64"),
        },
        error: /UTF-16 encoding/u,
      },
      {
        name: "truncated ICS",
        body: {
          filename: "bad.ics",
          text: "BEGIN:VEVENT\nUID:x\nSUMMARY:x\nDTSTART:20260729",
        },
        error: /truncated ICS/u,
      },
      {
        name: "truncated vCard",
        body: { filename: "bad.vcf", text: "BEGIN:VCARD\nFN:Meera" },
        error: /truncated vCard/u,
      },
      {
        name: "formula CSV",
        body: {
          filename: "bad.csv",
          text: [
            "Date,Description,Amount",
            '2026-07-29,"=HYPERLINK(""https://evil"")",10',
          ].join("\n"),
        },
        error: /spreadsheet formula marker/u,
      },
      {
        name: "truncated archive",
        body: {
          filename: "bad.zip",
          base64: Buffer.from("PK\u0003\u0004truncated").toString("base64"),
        },
        error: /not a zip file/u,
      },
      {
        name: "empty valid calendar",
        body: {
          filename: "empty.ics",
          text: "BEGIN:VCALENDAR\nEND:VCALENDAR",
        },
        error: /no valid records/u,
      },
    ];

    await Promise.all(
      corpus.map(async (vector) => {
        const response = await fetch(base, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(vector.body),
        });
        expect(response.status, vector.name).toBe(400);
        const body = (await response.json()) as { error: string };
        expect(body.error, vector.name).toMatch(vector.error);
      })
    );

    const drafts = plane.db.vault
      .prepare("SELECT count(*) AS count FROM sync_import_batch")
      .get() as { count: number };
    expect(drafts.count).toBe(0);
  });
});
