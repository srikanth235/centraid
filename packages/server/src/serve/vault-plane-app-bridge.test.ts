// What an installed app can actually do through `bridgeFor(appId)`: reveal a
// sealed secret only behind a fresh user-presence permit, invoke a granted
// command without parking (risk is salience, not a gate), and reach the canon
// from a real handler file dispatched by the app engine.
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { Dispatcher, Registry } from "@centraid/server/engine";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { ensureAppEnrolled } from "@centraid/vault";

import { seedCalendar, usePlaneFixture } from "./vault-plane.test-fixtures.js";

describe("vault-plane app bridge", () => {
  const fixture = usePlaneFixture();

  test("a Locker reveal through the app bridge is refused, whatever it carries", async () => {
    // #996, rulings R13 and W6-D2. Three tests used to live here: a UI reveal
    // needed a one-time permit, an `authenticate` answer had to be a settled
    // value rather than a promise, and `authenticate` was Locker-only. All
    // three were rules about a plane that no longer exists — the gateway does
    // not unseal a Locker row for any client, so there is no permit to expire
    // and no authentication call to keep on the async lane.
    //
    // What replaces them is one property with no arguments to get wrong: the
    // bridge refuses the schema, and the ONLY caller that could have asked
    // (Locker, holding the reveal scope) is refused like everyone else.
    const plane = fixture.openPlane(await tempDir("locker-auth-plane-"));
    plane.installApp("locker", "Locker");
    plane.recordAppInstall("locker", {
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
    });
    expect(added.status).toBe("executed");
    const itemId = (added as { output: { item_id: string } }).output.item_id;

    const refused = await plane.bridgeFor("locker")({
      op: "reveal",
      payload: {
        entity: "locker.item",
        entityId: itemId,
        columns: ["password"],
      },
    });
    expect(refused).toMatchObject({
      ok: false,
      error: expect.stringMatching(/does not unseal locker rows/u),
    });
    // And the plaintext never travelled, not even inside the refusal.
    expect(JSON.stringify(refused)).not.toContain("permit-protected-secret");
  });

  test("the app bridge has no authenticate op left to call", async () => {
    // The op is gone from the bridge's union, so an app that still names it
    // gets the unsupported-op answer rather than a Locker auth plane. Asserted
    // through the bridge rather than by reading the type, because a runtime
    // arm left behind after the type was narrowed is exactly the shape a
    // deletion misses.
    const plane = fixture.openPlane(await tempDir("locker-scope-plane-"));
    plane.installApp("locker", "Locker");
    const answer = await plane.bridgeFor("locker")({
      op: "authenticate" as never,
      payload: { operation: "status" },
    });
    expect(answer.ok).toBe(false);
    expect(String(answer.error)).not.toMatch(/only to Locker/u);
  });

  test("a granted app invoke executes without parking; the risk marker rides the receipt (issue #306)", async () => {
    const plane = fixture.openPlane(await tempDir());
    const calendarId = seedCalendar(plane);
    plane.recordAppInstall("planner", {
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
      },
    });
    // propose_event is medium risk — installing granted the scope, so it
    // executes; risk is a salience marker in the journal, not a park trigger.
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
    // node:sqlite hands back null-prototype rows; spreading compares the column
    // data (which is the contract) without asserting the driver's prototype.
    expect(events.map((row) => ({ ...row }))).toStrictEqual([
      { summary: "Design review", status: "tentative" },
    ]);
  });

  test("full stack: a real handler file reaches the canon through ctx.vault", async () => {
    const plane = fixture.openPlane(await tempDir());
    const calendarId = seedCalendar(plane);
    ensureAppEnrolled(plane.db, "planner", { riskCeiling: "medium" });
    plane.recordAppInstall("planner", {
      scopes: [{ schema: "schedule", verbs: "read+act" }],
    });

    // App code on disk, dispatched exactly as the runtime would.
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
    // The write is receipted and attributed to the app, not the owner.
    const receipts = plane.db.audit
      .prepare(
        `SELECT decision FROM access_receipt WHERE action = 'act schedule.propose_event' AND decision = 'allow'`
      )
      .all();
    expect(receipts).toHaveLength(1);
  });
});
