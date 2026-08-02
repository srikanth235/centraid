import crypto from "node:crypto";
import { promises as fs } from "node:fs";
// The import routes (issue #290 phase 2) over a real vault plane: stage a
// file over HTTP, review its rows, publish, and see the batch in history.
import http from "node:http";

import { afterEach, describe, expect, test } from "vitest";

import { ensureConversationLedger } from "@centraid/app-engine";
import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { seedYear3Vault } from "@centraid/test-kit/year3-vault";
import { sealAad, sealValue, verifyPortableVault } from "@centraid/vault";

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
    ensureConversationLedger(source.plane.db.journal);
    seedYear3Vault(
      {
        vault: source.plane.db.vault,
        journal: source.plane.db.journal,
        sealCell: (entity, column, rowId, plaintext) =>
          sealValue(
            source.plane.db.sealKey,
            sealAad(entity.replace(".", "_"), column, rowId),
            plaintext
          ),
      },
      { parties: 7, photos: 31, conversations: 3, turnsPerConversation: 4 }
    );
    const staged = (await (
      await fetch(source.base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: "party.ics", text: ICS }),
      })
    ).json()) as { batchId: string };
    await fetch(`${source.base}/${staged.batchId}/publish`, { method: "POST" });

    const exportedResponse = await fetch(`${source.base}/export`);
    expect(exportedResponse.status).toBe(200);
    expect(exportedResponse.headers.get("cache-control")).toBe("no-store");
    const exported = Buffer.from(await exportedResponse.arrayBuffer());
    expect(() => verifyPortableVault(exported)).not.toThrow();

    const target = await fixture();
    const importResponse = await fetch(target.base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "centraid-portable-v1.zip",
        base64: exported.toString("base64"),
        replaceFreshVault: true,
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

    const reexportResponse = await fetch(`${target.base}/export`);
    const reexported = Buffer.from(await reexportResponse.arrayBuffer());
    expect(reexportResponse.status, reexported.toString("utf8")).toBe(200);
    expect(() => verifyPortableVault(reexported)).not.toThrow();
    expect(verifyPortableVault(reexported).canonicalVerifyHash).toBe(
      verifyPortableVault(exported).canonicalVerifyHash
    );
    expect(
      reopened.db.vault
        .prepare("SELECT summary FROM core_event ORDER BY summary")
        .all()
        .map((row) => row.summary)
    ).toContain("Housewarming");
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
