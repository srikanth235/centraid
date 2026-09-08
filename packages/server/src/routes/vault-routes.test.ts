// governance: allow-repo-hygiene file-size-limit one suite per route module (#647 added the notifications route cases); mirrors the vault-routes.ts waiver — pending split alongside the routes it exercises
import http from "node:http";

import { afterEach, describe, expect, test } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
// The outbox edit-before-send route slice (#308 A5 UI slice):
// approve-with-edit rebuilds the gmail.send wire request server-side from
// the edited artifact, an unsupported verb 4xx's instead of silently
// dropping the edit, shape-drifted artifacts are refused, and a
// client-supplied raw "request" is refused outright (the owner surface
// never handles the wire request — see `outbox-edit.ts`).
import { tempDir } from "@centraid/test-kit/temp-dir";

import { GatewayDatabase } from "../serve/gateway-db.js";
import { NotificationsEventBus } from "../serve/notifications-events.js";
import { runWithVaultContext } from "../serve/vault-context.js";
import type { VaultPlane } from "../serve/vault-plane.js";
import { openVaultRegistry } from "../serve/vault-registry.js";
import { makeVaultRouteHandler } from "./vault-routes.js";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const cleanups: Array<() => Promise<void> | void> = [];
describe("vault-routes", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });
  async function startHandlerServer(
    handler: (
      req: http.IncomingMessage,
      res: http.ServerResponse
    ) => Promise<boolean>
  ): Promise<string> {
    const server = http.createServer((req, res) => {
      void handler(req, res).then((owned) => {
        if (!owned) {
          res.statusCode = 404;
          res.end("{}");
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
    const addr = server.address() as { port: number };
    return `http://127.0.0.1:${addr.port}`;
  }

  function configureConnection(plane: VaultPlane): void {
    const outcome = plane.gateway.invoke(plane.ownerCredential, {
      command: "sync.configure_credential",
      input: {
        kind: "pull.gmail",
        label: "personal",
        cred_kind: "api_key",
        api_key: "sk-route-test-key",
        allowed_hosts: ["gmail.googleapis.com"],
      },
    });
    if (outcome.status !== "executed") {
      throw new Error(`configure failed: ${JSON.stringify(outcome)}`);
    }
  }

  function stageGmailSend(
    plane: VaultPlane,
    over: Record<string, unknown> = {}
  ): string {
    const outcome = plane.gateway.invoke(plane.ownerCredential, {
      command: "outbox.stage",
      input: {
        kind: "pull.gmail",
        label: "personal",
        verb: "gmail.send",
        target: "ravi@example.com",
        artifact: {
          to: ["ravi@example.com"],
          subject: "Original subject",
          body: "Original body.",
          message_id: "msg-1",
        },
        request: {
          method: "POST",
          url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
          headers: {
            authorization: "Bearer {{connection:access_token}}",
            "content-type": "application/json",
          },
          body: JSON.stringify({ raw: "original-raw-placeholder" }),
        },
        ...over,
      },
    });
    if (outcome.status !== "executed")
      throw new Error(`stage failed: ${JSON.stringify(outcome)}`);
    return (outcome as { output: { item_id: string } }).output.item_id;
  }

  function stageUnknownVerb(plane: VaultPlane): string {
    return stageGmailSend(plane, {
      verb: "gcal.create_event",
      target: "cal-1",
      artifact: { title: "Standup", when: "2026-07-11T10:00:00Z" },
      request: {
        method: "POST",
        url: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
        headers: { authorization: "Bearer {{connection:access_token}}" },
        body: JSON.stringify({ title: "Standup" }),
      },
    });
  }

  function rawOf(
    plane: VaultPlane,
    itemId: string
  ): { requestBody: string; status: string } {
    const row = plane.db.vault
      .prepare("SELECT request_json, status FROM outbox_item WHERE item_id = ?")
      .get(itemId) as { request_json: string; status: string };
    return { requestBody: row.request_json, status: row.status };
  }

  async function setup(): Promise<{ base: string; plane: VaultPlane }> {
    const dir = await tempDir();
    const registry = openVaultRegistry({
      rootDir: dir,
      logger: silentLogger,
      ownerName: "Priya",
    });
    registry.create("Personal");
    cleanups.push(() => registry.stop());
    const plane = registry.current();
    configureConnection(plane);
    const base = await startHandlerServer(makeVaultRouteHandler(registry));
    return { base, plane };
  }

  test("remote CAS configuration refuses encryption opt-out for BYO S3 too", async () => {
    const { base, plane } = await setup();
    const response = await fetch(`${base}/centraid/_vault/blob-store`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        blob_store: {
          kind: "s3",
          endpoint: "https://s3.example.test",
          bucket: "private-bucket",
          encrypt: false,
        },
      }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "bad_request",
      message: "remote CAS encryption cannot be disabled",
    });
    const settings = JSON.parse(
      (
        plane.db.vault
          .prepare("SELECT settings_json FROM core_vault LIMIT 1")
          .get() as {
          settings_json: string;
        }
      ).settings_json
    ) as Record<string, unknown>;
    expect(settings["blob_store"]).toBeUndefined();
  });

  test("enabling remote CAS without a backup target names the recovery consequence", async () => {
    const vaultRoot = await tempDir("remote-without-backup-vault-");
    const dataDir = await tempDir("remote-without-backup-gateway-");
    const registry = openVaultRegistry({
      rootDir: vaultRoot,
      logger: silentLogger,
      ownerName: "Priya",
    });
    registry.create("Personal");
    cleanups.push(() => registry.stop());
    const database = GatewayDatabase.open(dataDir);
    cleanups.push(() => database.close());
    const base = await startHandlerServer(
      makeVaultRouteHandler(registry, { gatewayDatabase: database })
    );

    const response = await fetch(`${base}/centraid/_vault/blob-store`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        blob_store: {
          kind: "s3",
          endpoint: "https://s3.example.test",
          bucket: "private-bucket",
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      warning: expect.stringMatching(
        /offsite bytes.*recovery kit cannot restore/iu
      ),
    });
  });

  test("GET /outbox and GET /blocking surface canEdit true for gmail.send, false for an unregistered verb", async () => {
    const { base, plane } = await setup();
    const gmailItem = stageGmailSend(plane);
    const otherItem = stageUnknownVerb(plane);

    const listed = (await (
      await fetch(`${base}/centraid/_vault/outbox`)
    ).json()) as {
      items: Array<{ itemId: string; canEdit: boolean }>;
    };
    const byId = new Map(listed.items.map((i) => [i.itemId, i.canEdit]));
    expect(byId.get(gmailItem)).toBe(true);
    expect(byId.get(otherItem)).toBe(false);

    const blocking = (await (
      await fetch(`${base}/centraid/_vault/blocking`)
    ).json()) as {
      outbox: Array<{ itemId: string; canEdit: boolean }>;
    };
    const blockingById = new Map(
      blocking.outbox.map((i) => [i.itemId, i.canEdit])
    );
    expect(blockingById.get(gmailItem)).toBe(true);
    expect(blockingById.get(otherItem)).toBe(false);

    // The raw request never rides either read surface.
    expect(JSON.stringify(listed)).not.toContain("request_json");
    expect(JSON.stringify(listed)).not.toContain("{{connection:access_token}}");
  });

  // Issue #659 M5 (gateway half): apps/mobile revalidates these two polled
  // reads with If-None-Match, which does nothing unless the server tags them.
  test("Notifications and Parked answer 304 on an unchanged body and re-tag when it changes", async () => {
    const dir = await tempDir();
    const registry = openVaultRegistry({
      rootDir: dir,
      logger: silentLogger,
      ownerName: "Priya",
    });
    registry.create("Personal");
    cleanups.push(() => registry.stop());
    const plane = registry.current();
    configureConnection(plane);
    const base = await startHandlerServer(
      makeVaultRouteHandler(registry, {
        notificationsEvents: new NotificationsEventBus(),
      })
    );

    const get = (path: string, etag?: string): Promise<Response> =>
      fetch(`${base}${path}`, {
        headers: etag === undefined ? {} : { "If-None-Match": etag },
      });

    // The steps WITHIN a surface are sequential by necessity — you need the
    // ETag before you can revalidate with it — but the two surfaces are
    // independent, so they run together.
    const revalidates = async (path: string): Promise<void> => {
      const first = await get(path);
      expect(first.status).toBe(200);
      const etag = first.headers.get("etag");
      expect(etag).toBeTruthy();
      const body = await first.text();

      const revalidated = await get(path, etag!);
      expect(revalidated.status).toBe(304);
      await expect(revalidated.text()).resolves.toBe("");

      // A client that does not revalidate still sees the identical payload.
      await expect(get(path).then((r) => r.text())).resolves.toBe(body);
    };
    await Promise.all([
      revalidates("/centraid/_vault/notifications"),
      revalidates("/centraid/_vault/parked"),
    ]);

    // Mutate BOTH surfaces: a notice changes Notifications, a confirm-gated
    // assistant invocation parks and changes Parked.
    const notificationsEtag = (
      await get("/centraid/_vault/notifications")
    ).headers.get("etag");
    const parkedEtag = (await get("/centraid/_vault/parked")).headers.get(
      "etag"
    );
    plane.notices.put({
      kind: "automation",
      sourceRef: "mail/digest",
      headline: "Digest failed",
      severity: "high",
      detail: { sourceType: "automation", outcome: "failure" },
    });
    const parkedResult = await runWithVaultContext(
      {
        vaultId: plane.boot.vaultId,
        ownerId: plane.boot.ownerPartyId,
        ownsVault: true,
      },
      () =>
        plane.invokeAsAssistant({
          command: "social.send_message",
          input: { message_id: "not-yet-real" },
        })
    );
    expect(parkedResult.status).toBe("parked");

    const freshNotifications = await get(
      "/centraid/_vault/notifications",
      notificationsEtag!
    );
    expect(freshNotifications.status).toBe(200);
    expect(freshNotifications.headers.get("etag")).not.toBe(notificationsEtag);

    const freshParked = await get("/centraid/_vault/parked", parkedEtag!);
    expect(freshParked.status).toBe(200);
    expect(freshParked.headers.get("etag")).not.toBe(parkedEtag);
    await expect(freshParked.text()).resolves.toContain("social.send_message");
  }, 60_000);

  test("Notifications projects canonical decisions beside collapsed notices and supports read/archive", async () => {
    const dir = await tempDir();
    const registry = openVaultRegistry({
      rootDir: dir,
      logger: silentLogger,
      ownerName: "Priya",
    });
    registry.create("Personal");
    cleanups.push(() => registry.stop());
    const plane = registry.current();
    configureConnection(plane);
    const itemId = stageGmailSend(plane);
    const notice = plane.notices.put({
      kind: "automation",
      sourceRef: "mail/digest",
      headline: "Digest failed",
      severity: "high",
      detail: { sourceType: "automation", outcome: "failure" },
    });
    const base = await startHandlerServer(
      makeVaultRouteHandler(registry, {
        notificationsEvents: new NotificationsEventBus(),
      })
    );

    const notifications = (await (
      await fetch(`${base}/centraid/_vault/notifications?include_archived=true`)
    ).json()) as {
      decisions: {
        count: number;
        outbox: Array<{ itemId: string; canEdit: boolean }>;
      };
      notices: Array<{ noticeId: string; headline: string }>;
      unreadNoticeCount: number;
    };
    expect(notifications.decisions.count).toBe(1);
    expect(notifications.decisions.outbox).toContainEqual(
      expect.objectContaining({ itemId, canEdit: true })
    );
    expect(notifications.notices).toContainEqual(
      expect.objectContaining({
        noticeId: notice.noticeId,
        headline: "Digest failed",
      })
    );
    expect(notifications.unreadNoticeCount).toBe(1);

    const read = await fetch(
      `${base}/centraid/_vault/notifications/notices/${notice.noticeId}`,
      {
        method: "POST",
        body: JSON.stringify({ action: "read" }),
      }
    );
    expect(read.status).toBe(200);
    const archived = await fetch(
      `${base}/centraid/_vault/notifications/notices/${notice.noticeId}`,
      {
        method: "POST",
        body: JSON.stringify({ action: "archive" }),
      }
    );
    expect(archived.status).toBe(200);
    expect(plane.notices.list()).toStrictEqual([]);
  });

  test("Notifications SSE emits its content-free doorbell immediately after a canonical change", async () => {
    const dir = await tempDir();
    const events = new NotificationsEventBus();
    const wakeSignals: boolean[] = [];
    const registry = openVaultRegistry({
      rootDir: dir,
      logger: silentLogger,
      ownerName: "Priya",
      onNotificationsChanged: (vaultId, wake) => {
        wakeSignals.push(wake);
        events.publish(vaultId, wake);
      },
    });
    registry.create("Personal");
    cleanups.push(() => registry.stop());
    const plane = registry.current();
    const base = await startHandlerServer(
      makeVaultRouteHandler(registry, { notificationsEvents: events })
    );
    const controller = new AbortController();
    const response = await fetch(
      `${base}/centraid/_vault/notifications/events`,
      {
        signal: controller.signal,
      }
    );
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Notifications SSE response has no body");
    const decoder = new TextDecoder();
    const initial = await reader.read();
    expect(decoder.decode(initial.value)).toContain(
      "event: notifications-changed"
    );

    plane.recordAppInstall("planner", {
      scopes: [{ schema: "schedule", verbs: "read+act" }],
    });
    plane.db.vault
      .prepare(
        `INSERT INTO schedule_calendar
           (calendar_id, owner_party_id, name, default_tz, visibility)
         VALUES ('calendar-notifications-sse', ?, 'Personal', 'Asia/Kolkata', 'private')`
      )
      .run(plane.boot.ownerPartyId);
    plane.db.vault
      .prepare(
        `UPDATE agent_capability SET requires_confirmation=1
          WHERE command_id = (
            SELECT command_id FROM agent_command
            WHERE name='schedule.propose_event'
          )`
      )
      .run();
    const parked = await plane.bridgeFor("planner")({
      op: "invoke",
      payload: {
        command: "schedule.propose_event",
        input: {
          summary: "Notifications delivery check",
          dtstart: "2026-07-30T09:00:00Z",
          dtend: "2026-07-30T09:30:00Z",
          calendar_id: "calendar-notifications-sse",
        },
      },
    });
    expect(parked.result).toMatchObject({ status: "parked" });
    expect(wakeSignals.at(-1)).toBe(true);
    const changed = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error("Notifications SSE exceeded 1 second")),
          1_000
        );
      }),
    ]);
    expect(decoder.decode(changed.value)).toBe(
      'event: notifications-changed\ndata: {"type":"notifications-changed"}\n\n'
    );
    controller.abort();
  });

  test("approve-with-edit rebuilds the gmail.send request server-side from the edited artifact", async () => {
    const { base, plane } = await setup();
    const itemId = stageGmailSend(plane);

    const res = await fetch(`${base}/centraid/_vault/outbox/${itemId}`, {
      method: "POST",
      body: JSON.stringify({
        decision: "approve",
        artifact: {
          to: ["ravi@example.com", "asha@example.com"],
          subject: "Edited subject",
          body: "Edited body text.",
          message_id: "msg-1",
        },
      }),
    });
    expect(res.status).toBe(200);
    const outcome = (await res.json()) as { status: string };
    expect(outcome.status).toBe("executed");

    const { requestBody, status } = rawOf(plane, itemId);
    expect(status).toBe("approved");
    const parsed = JSON.parse(requestBody) as {
      method: string;
      url: string;
      headers: Record<string, string>;
      body: string;
    };
    // Everything not derived from the artifact stayed as staged.
    expect(parsed.method).toBe("POST");
    expect(parsed.url).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
    );
    expect(parsed.headers.authorization).toBe(
      "Bearer {{connection:access_token}}"
    );
    // The raw RFC 2822 message reflects the EDITED subject/body/recipients.
    const raw = (JSON.parse(parsed.body) as { raw: string }).raw;
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    expect(decoded).toContain("To: ravi@example.com, asha@example.com");
    expect(decoded).toContain("Subject: Edited subject");
    expect(decoded).toContain("Edited body text.");
  });

  test("an unknown verb refuses the edit with a clear 4xx instead of silently keeping the staged request", async () => {
    const { base, plane } = await setup();
    const itemId = stageUnknownVerb(plane);

    const res = await fetch(`${base}/centraid/_vault/outbox/${itemId}`, {
      method: "POST",
      body: JSON.stringify({
        decision: "approve",
        artifact: { title: "Edited standup", when: "2026-07-11T11:00:00Z" },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("edit_unsupported");
    expect(body.message).toMatch(
      /editing isn't supported for gcal\.create_event/u
    );

    // Nothing changed — the item is still pending, request untouched.
    const { status } = rawOf(plane, itemId);
    expect(status).toBe("pending");
  });

  test("shape-drifted artifacts (added field, removed field, type change) are all refused with a 400", async () => {
    const { base, plane } = await setup();

    const addedFieldItem = stageGmailSend(plane);
    const added = await fetch(
      `${base}/centraid/_vault/outbox/${addedFieldItem}`,
      {
        method: "POST",
        body: JSON.stringify({
          decision: "approve",
          artifact: {
            to: ["ravi@example.com"],
            subject: "Hi",
            body: "x",
            message_id: "msg-1",
            extra: "not allowed",
          },
        }),
      }
    );
    expect(added.status).toBe(400);
    expect(((await added.json()) as { message: string }).message).toMatch(
      /exactly the staged fields/u
    );

    const removedFieldItem = stageGmailSend(plane);
    const removed = await fetch(
      `${base}/centraid/_vault/outbox/${removedFieldItem}`,
      {
        method: "POST",
        body: JSON.stringify({
          decision: "approve",
          artifact: { to: ["ravi@example.com"], subject: "Hi", body: "x" },
        }),
      }
    );
    expect(removed.status).toBe(400);
    expect(((await removed.json()) as { message: string }).message).toMatch(
      /exactly the staged fields/u
    );

    const typeChangedItem = stageGmailSend(plane);
    const typeChanged = await fetch(
      `${base}/centraid/_vault/outbox/${typeChangedItem}`,
      {
        method: "POST",
        body: JSON.stringify({
          decision: "approve",
          artifact: {
            to: ["ravi@example.com"],
            subject: 42,
            body: "x",
            message_id: "msg-1",
          },
        }),
      }
    );
    expect(typeChanged.status).toBe(400);
    expect(((await typeChanged.json()) as { message: string }).message).toMatch(
      /must stay a string/u
    );

    // None of the refused edits touched the staged rows.
    for (const id of [addedFieldItem, removedFieldItem, typeChangedItem]) {
      expect(rawOf(plane, id).status).toBe("pending");
    }
  });

  test('a client-supplied raw "request" is refused, not silently accepted or ignored', async () => {
    const { base, plane } = await setup();
    const itemId = stageGmailSend(plane);

    const res = await fetch(`${base}/centraid/_vault/outbox/${itemId}`, {
      method: "POST",
      body: JSON.stringify({
        decision: "approve",
        request: { method: "POST", url: "https://evil.example.com/exfiltrate" },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/never accepts a raw "request"/u);

    // The staged request is untouched — no path let a raw request through.
    const { requestBody, status } = rawOf(plane, itemId);
    expect(status).toBe("pending");
    expect(requestBody).not.toContain("evil.example.com");
  });

  test("an artifact edit on discard is refused — discarding sends nothing, so nothing to edit", async () => {
    const { base, plane } = await setup();
    const itemId = stageGmailSend(plane);

    const res = await fetch(`${base}/centraid/_vault/outbox/${itemId}`, {
      method: "POST",
      body: JSON.stringify({
        decision: "discard",
        artifact: {
          to: ["ravi@example.com"],
          subject: "Hi",
          body: "x",
          message_id: "msg-1",
        },
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(
      /only applies to "approve"/u
    );
    expect(rawOf(plane, itemId).status).toBe("pending");
  });

  test("a plain approve with no artifact still works exactly as before (no edit path engaged)", async () => {
    const { base, plane } = await setup();
    const itemId = stageGmailSend(plane);

    const res = await fetch(`${base}/centraid/_vault/outbox/${itemId}`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(res.status).toBe(200);
    const { requestBody, status } = rawOf(plane, itemId);
    expect(status).toBe("approved");
    expect(requestBody).toContain("original-raw-placeholder");
  });

  // The owner-only tier writer uses this route. Two things must hold: the
  // write reaches the mirror the
  // runtime gate reads, and the standing "enrichment isn't running" card goes
  // away with the tier it describes — a card left asserting a setting the
  // owner has just changed is a second silent lie.
  test("the enrichment tier route writes the mirror the gate reads and retires the stale refusal card", async () => {
    const { base, plane } = await setup();
    // Start both domains at `device` (a fresh vault's bootstrap default is
    // `gateway` since #712 C5 — lower them explicitly so the PUT below
    // has a real change to make, same as an owner who narrowed the tier
    // once already).
    const patch: Partial<Record<"photos" | "docs", "device">> = {
      photos: "device",
      docs: "device",
    };
    await fetch(`${base}/centraid/_vault/enrich`, {
      body: JSON.stringify(patch),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    const stale = plane.notices.put({
      kind: "enrichment",
      sourceRef: "photos",
      headline: "Photo enrichment is limited to your devices",
      severity: "info",
      detail: { sourceType: "app", enrichDomain: "photos", tier: "device" },
    });
    const untouched = plane.notices.put({
      kind: "enrichment",
      sourceRef: "docs",
      headline: "Document enrichment is limited to your devices",
      severity: "info",
      detail: { sourceType: "app", enrichDomain: "docs", tier: "device" },
    });

    const res = await fetch(`${base}/centraid/_vault/enrich`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ photos: "gateway" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toStrictEqual({
      enrich: { photos: "gateway", docs: "device" },
    });
    const mirrored = plane.db.vault
      .prepare("SELECT tier FROM enrich_policy WHERE domain = ?")
      .get("photos") as { tier: string };
    expect(mirrored.tier).toBe("gateway");
    // Archived, not deleted — the record of what was refused stays readable.
    expect(
      plane.notices.getBySource("enrichment", "photos")?.archivedAt
    ).not.toBeNull();
    // The domain that did not move keeps its card, unread state and all.
    expect(plane.notices.getBySource("enrichment", "docs")).toStrictEqual(
      untouched
    );
    expect(stale.archivedAt).toBeNull();
  });

  test("unknown outbox item id on an edit attempt 404s", async () => {
    const { base } = await setup();
    const res = await fetch(`${base}/centraid/_vault/outbox/does-not-exist`, {
      method: "POST",
      body: JSON.stringify({
        decision: "approve",
        artifact: { to: ["x@example.com"], subject: "Hi", body: "x" },
      }),
    });
    expect(res.status).toBe(404);
  });
});
