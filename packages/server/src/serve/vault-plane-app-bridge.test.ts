import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { Dispatcher, Registry } from "@centraid/server/engine";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { ensureAppEnrolled } from "@centraid/vault";

import { seedCalendar, usePlaneFixture } from "./vault-plane.test-fixtures.js";

describe("vault-plane app bridge", () => {
  const fixture = usePlaneFixture();

  test("Locker app reveals require an expiring one-time user-presence permit", async () => {
    const plane = fixture.openPlane(await tempDir("locker-auth-plane-"));
    plane.installApp("locker", "Locker");
    plane.approveGrant("locker", {
      purpose: "dpv:ServiceProvision",
      scopes: [{ schema: "locker", table: "item", verbs: "reveal" }],
    });
    const added = plane.gateway.invoke(plane.ownerCredential, {
      command: "locker.add_item",
      input: {
        type: "login",
        title: "example.com",
        password: "permit-protected-secret",
        url: "https://example.com",
      },
      purpose: "dpv:ServiceProvision",
    });
    expect(added.status).toBe("executed");
    const itemId = (added as { output: { item_id: string } }).output.item_id;
    const bridge = plane.bridgeFor("locker");
    const reveal = (authentication?: {
      sessionToken?: string;
      itemToken?: string;
    }) =>
      bridge({
        op: "reveal",
        payload: {
          entity: "locker.item",
          entityId: itemId,
          columns: ["password"],
          authentication,
          purpose: "dpv:ServiceProvision",
        },
      });

    const configured = await bridge({
      op: "authenticate",
      payload: {
        operation: "configure",
        secret: "correct horse battery staple",
      },
    });
    expect(configured.ok).toBe(true);
    const sessionToken = (configured.result as { sessionToken: string })
      .sessionToken;
    await expect(reveal()).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/locked/u),
    });
    const authorized = await bridge({
      op: "authenticate",
      payload: {
        operation: "authorize-item",
        sessionToken,
        secret: "correct horse battery staple",
        itemId,
      },
    });
    const itemToken = (authorized.result as { itemToken: string }).itemToken;
    await expect(reveal({ sessionToken, itemToken })).resolves.toMatchObject({
      ok: true,
      result: {
        values: { password: "permit-protected-secret" },
      },
    });
    await expect(reveal({ sessionToken, itemToken })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/authorization expired/u),
    });
  });

  test("an authenticate result is a settled value, never a promise (#659 G11)", async () => {
    const plane = fixture.openPlane(await tempDir("locker-async-plane-"));
    plane.installApp("locker", "Locker");
    const bridge = plane.bridgeFor("locker");

    const status = await bridge({
      op: "authenticate",
      payload: { operation: "status" },
    });
    expect(status.ok).toBe(true);
    expect(status.result).not.toBeInstanceOf(Promise);
    expect(
      (status.result as { then?: unknown } | undefined)?.then
    ).toBeUndefined();
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- see above
    expect(JSON.parse(JSON.stringify(status.result))).toMatchObject({
      configured: false,
      authenticated: false,
    });

    const configured = await bridge({
      op: "authenticate",
      payload: {
        operation: "configure",
        secret: "correct horse battery staple",
      },
    });
    expect(configured.ok).toBe(true);
    expect(
      (configured.result as { sessionToken?: unknown }).sessionToken
    ).toBeTypeOf("string");
  });

  test("authenticate stays Locker-only on the async lane (#659 G11)", async () => {
    const plane = fixture.openPlane(await tempDir("locker-scope-plane-"));
    plane.enrollApp("planner");
    const denied = await plane.bridgeFor("planner")({
      op: "authenticate",
      payload: { operation: "status" },
    });
    expect(denied).toMatchObject({
      ok: false,
      error: expect.stringMatching(/only to Locker/u),
    });
  });

  test("a granted app invoke executes without parking; the risk marker rides the receipt (issue #306)", async () => {
    const plane = fixture.openPlane(await tempDir());
    const calendarId = seedCalendar(plane);
    plane.enrollApp("planner");
    plane.approveGrant("planner", {
      purpose: "dpv:ServiceProvision",
      scopes: [{ schema: "schedule", verbs: "read+act" }],
    });

    const bridge = plane.bridgeFor("planner");
    const outcome = await bridge({
      op: "invoke",
      payload: {
        command: "schedule.propose_event",
        input: {
          summary: "Design review",
          dtstart: "2026-07-04T09:00:00Z",
          dtend: "2026-07-04T09:30:00Z",
          calendar_id: calendarId,
        },
        purpose: "dpv:ServiceProvision",
      },
    });
    expect(outcome.ok).toBe(true);
    const executed = outcome.result as { status: string; receiptId: string };
    expect(executed.status).toBe("executed");
    expect(plane.listParked()).toHaveLength(0);
    const receipt = plane.db.audit
      .prepare("SELECT detail_json FROM access_receipt WHERE receipt_id = ?")
      .get(executed.receiptId) as { detail_json: string };
    expect(JSON.parse(receipt.detail_json).risk).toBe("medium");
    const events = plane.db.vault
      .prepare("SELECT summary, status FROM core_event")
      .all();
    expect(events.map((row) => ({ ...row }))).toStrictEqual([
      { summary: "Design review", status: "tentative" },
    ]);
  });

  test("full stack: a real handler file reaches the canon through ctx.vault", async () => {
    const plane = fixture.openPlane(await tempDir());
    const calendarId = seedCalendar(plane);
    ensureAppEnrolled(plane.db, "planner", { riskCeiling: "medium" });
    plane.approveGrant("planner", {
      purpose: "dpv:ServiceProvision",
      scopes: [{ schema: "schedule", verbs: "read+act" }],
    });

    const codeRoot = await tempDir();
    const dataRoot = await tempDir();
    const appDir = path.join(codeRoot, "planner");
    await fs.mkdir(path.join(appDir, "actions"), { recursive: true });
    await fs.writeFile(
      path.join(appDir, "app.json"),
      JSON.stringify({
        manifestVersion: 1,
        id: "planner",
        name: "Planner",
        version: "0.1.0",
        actions: [
          {
            name: "propose",
            confirmation: "none",
            input: {
              type: "object",
              properties: { summary: { type: "string" } },
            },
          },
        ],
        queries: [],
        vault: {
          purpose: "dpv:ServiceProvision",
          scopes: [{ schema: "schedule", verbs: "read+act" }],
        },
      }),
      "utf8"
    );
    await fs.writeFile(
      path.join(appDir, "actions", "propose.js"),
      `export default async ({ body, ctx }) => {
       const outcome = await ctx.vault.invoke({
         command: 'schedule.propose_event',
         input: {
           summary: body?.summary,
           dtstart: '2026-07-07T09:00:00Z',
           dtend: '2026-07-07T09:30:00Z',
           calendar_id: ${JSON.stringify(calendarId)},
         },
         purpose: 'dpv:ServiceProvision',
       });
       return { status: 200, body: outcome };
     };\n`,
      "utf8"
    );
    const registry = new Registry(dataRoot);
    await registry.load();
    await registry.ensureUploaded("planner");
    const dispatcher = new Dispatcher({
      registry,
      codeDirOverride: async (appId) => path.join(codeRoot, appId),
      vaultFor: (appId) => plane.bridgeFor(appId),
    });

    const out = await dispatcher.write({
      app: "planner",
      action: "propose",
      input: { summary: "Cross-plane standup" },
    });
    expect(out.isError).toBe(false);
    expect(out.structuredContent).toMatchObject({ status: "executed" });
    const events = plane.db.vault
      .prepare("SELECT summary FROM core_event")
      .all();
    expect(events.map((row) => ({ ...row }))).toStrictEqual([
      { summary: "Cross-plane standup" },
    ]);
    const receipts = plane.db.audit
      .prepare(
        `SELECT decision FROM access_receipt WHERE action = 'act schedule.propose_event' AND decision = 'allow'`
      )
      .all();
    expect(receipts).toHaveLength(1);
  });
});
