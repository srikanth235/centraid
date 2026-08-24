// governance: allow-repo-hygiene file-size-limit — provider writeback extends
// the same end-to-end broker/executor harness so auth loss, reconnect, reviewed
// outbox state, and emitted HTTP can be asserted as one lifecycle (#630).
import http from "node:http";

import { afterEach, describe, expect, test } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
/** The only approved-artifact-to-network path: credentials, host pins, retries, and review. */
import { tempDir } from "@centraid/test-kit/temp-dir";

import { ConnectionBroker } from "./connection-broker.js";
import {
  configureApiKey,
  itemRow,
  stageItem,
} from "./outbox-executor-test-kit.js";
import { OutboxExecutor } from "./outbox-executor.js";
import { openVaultPlane } from "./vault-plane.js";
import type { VaultPlane } from "./vault-plane.js";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const cleanups: Array<() => Promise<void> | void> = [];
describe("outbox-executor", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });
  function openPlane(dir: string): VaultPlane {
    const plane = openVaultPlane({
      bootstrap: true,
      dir,
      logger: silentLogger,
      ownerName: "Priya",
    });
    cleanups.push(() => plane.stop());
    return plane;
  }

  /** A recording fetch double for the API host — the executor's fetchImpl. */
  interface FetchDouble {
    impl: typeof fetch;
    calls: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }>;
    respond: (status: number, body?: string) => void;
  }

  function fetchDouble(): FetchDouble {
    const responses: Array<{ status: number; body: string }> = [];
    const calls: FetchDouble["calls"] = [];
    const impl = ((
      url: string | URL,
      init?: RequestInit
    ): Promise<Response> => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(
        (init?.headers ?? {}) as Record<string, string>
      )) {
        headers[k.toLowerCase()] = v;
      }
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        headers,
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      const next = responses.shift() ?? { status: 200, body: "{}" };
      return Promise.resolve(new Response(next.body, { status: next.status }));
    }) as typeof fetch;
    return {
      impl,
      calls,
      respond: (status, body = "{}") => responses.push({ status, body }),
    };
  }

  /** A fetch double that settles only when the caller's AbortSignal fires. */
  function hangingFetch(): typeof fetch {
    return ((_url: string | URL, init?: RequestInit): Promise<Response> => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(
            new DOMException(
              "The operation was aborted due to timeout",
              "TimeoutError"
            )
          );
        });
      });
    }) as typeof fetch;
  }

  function executorFor(
    plane: VaultPlane,
    api: FetchDouble,
    options?: ConstructorParameters<typeof OutboxExecutor>[3]
  ): OutboxExecutor {
    const broker = new ConnectionBroker(() => plane);
    return new OutboxExecutor(broker, silentLogger, api.impl, options);
  }

  test("an approved item drains: credential injected toward the pinned host, receipted sent", async () => {
    const plane = openPlane(await tempDir());
    configureApiKey(plane);
    const itemId = stageItem(plane);
    const approved = await plane.decideOutbox({ itemId, decision: "approve" });
    expect(approved.status).toBe("executed");

    const api = fetchDouble();
    api.respond(200, '{"id":"msg-1"}');
    const report = await executorFor(plane, api).drain(plane);
    expect(report).toMatchObject({
      approved: 1,
      sent: 1,
      failed: 0,
      deferred: 0,
    });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]).toMatchObject({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      method: "POST",
      body: '{"raw":"x"}',
    });
    // Injection happened executor-side: the row still holds the placeholder,
    // the wire carried the plaintext.
    expect(api.calls[0]?.headers.authorization).toBe(
      "Bearer sk-outbox-test-key"
    );
    const row = itemRow(plane, itemId);
    expect(row.status).toBe("sent");
    expect(JSON.parse(String(row.result_json)).status_code).toBe(200);
    expect(plane.notices.getBySource("outbox", itemId)).toMatchObject({
      headline: expect.stringContaining("sent"),
      detail: expect.objectContaining({
        outcome: "sent",
        itemId,
        sourceType: "app",
      }),
      severity: "info",
    });
    // The drain is receipted through outbox.record_result.
    const receipts = plane.db.journal
      .prepare(
        `SELECT count(*) AS n FROM consent_receipt
        WHERE action = 'act outbox.record_result' AND decision = 'allow'`
      )
      .get() as { n: number };
    expect(receipts.n).toBe(1);
  });

  test("raw ai_agent outcome notices stay in the Notifications Agents filter", () => {
    let written: Record<string, unknown> | undefined;
    const plane = {
      listOutbox: () => [
        {
          itemId: "item-agent",
          actor: "Digest agent",
          actorKind: "ai_agent",
          verb: "gmail.send",
          target: "ravi@example.com",
          artifact: { subject: "Digest" },
        },
      ],
      rawOutboxItem: () => undefined,
      notices: {
        put: (input: Record<string, unknown>) => {
          written = input;
        },
      },
    } as unknown as VaultPlane;
    const executor = executorFor(plane, fetchDouble());
    (
      executor as unknown as {
        writeOutcomeNotice: (
          current: VaultPlane,
          itemId: string,
          disposition: "sent"
        ) => void;
      }
    ).writeOutcomeNotice(plane, "item-agent", "sent");
    expect(written).toMatchObject({
      detail: { sourceType: "agent", itemId: "item-agent" },
    });
  });

  test("a locally edited Google event writes back and survives revoke/reconnect", async () => {
    const plane = openPlane(await tempDir());
    const configured = plane.gateway.invoke(plane.ownerCredential, {
      command: "sync.configure_credential",
      input: {
        kind: "pull.gcal",
        label: "personal",
        cred_kind: "oauth2",
        provider: "google",
        auth_url: "https://accounts.google.com/o/oauth2/v2/auth",
        token_url: "https://oauth2.googleapis.com/token",
        scopes: "https://www.googleapis.com/auth/calendar.events",
        client_id: "client.apps.googleusercontent.com",
        allowed_hosts: ["www.googleapis.com", "oauth2.googleapis.com"],
      },
    });
    expect(configured.status).toBe("executed");
    if (configured.status !== "executed") throw new Error(configured.status);
    const connectionId = String(
      (configured.output as Record<string, unknown>)["connection_id"]
    );
    const stored = plane.gateway.invoke(plane.ownerCredential, {
      command: "sync.store_tokens",
      input: {
        connection_id: connectionId,
        access_token: "token-before-revoke",
      },
    });
    expect(stored.status).toBe("executed");
    const staged = plane.gateway.invoke(plane.ownerCredential, {
      command: "sync.stage_rows",
      input: {
        connection_id: connectionId,
        rows: [
          {
            entity_type: "core.event",
            external_id: "gcal:provider-event-1",
            payload: {
              uid: "provider-event-1@example.test",
              summary: "Provider title",
              description: null,
              dtstart: "2026-08-01T09:00:00Z",
              dtend: "2026-08-01T10:00:00Z",
              startTz: "Asia/Kolkata",
              rrule: null,
              status: "confirmed",
              providerVersion: '"provider-etag-1"',
            },
          },
        ],
      },
    });
    expect(staged.status).toBe("executed");
    if (staged.status !== "executed") throw new Error(staged.status);
    const batchId = String(
      (staged.output as Record<string, unknown>)["batch_id"]
    );
    plane.gateway.publishImport(plane.ownerCredential, batchId);
    const eventId = (
      plane.db.vault
        .prepare(
          "SELECT target_id FROM sync_external_entity WHERE connection_id = ? AND external_id = 'gcal:provider-event-1'"
        )
        .get(connectionId) as { target_id: string }
    ).target_id;
    const edited = plane.gateway.invoke(plane.ownerCredential, {
      command: "schedule.edit_event",
      input: { event_id: eventId, summary: "Local title" },
    });
    expect(edited.status).toBe("executed");

    const api = fetchDouble();
    api.respond(403, '{"error":"insufficient_scope"}');
    const revoked = await executorFor(plane, api).drain(plane);
    expect(revoked).toMatchObject({ approved: 1, deferred: 1, sent: 0 });
    expect(
      (
        plane.db.vault
          .prepare("SELECT status FROM sync_connection WHERE connection_id = ?")
          .get(connectionId) as { status: string }
      ).status
    ).toBe("needs-auth");
    const writebackId = (
      plane.db.vault
        .prepare(
          "SELECT item_id FROM outbox_item WHERE connection_id = ? AND verb = 'gcal.update_event'"
        )
        .get(connectionId) as { item_id: string }
    ).item_id;
    expect(itemRow(plane, writebackId).status).toBe("approved");

    const reconnected = plane.gateway.invoke(plane.ownerCredential, {
      command: "sync.store_tokens",
      input: {
        connection_id: connectionId,
        access_token: "token-after-reconnect",
      },
    });
    expect(reconnected.status).toBe("executed");
    api.respond(200, '{"id":"provider-event-1"}');
    const sent = await executorFor(plane, api).drain(plane);
    expect(sent).toMatchObject({ sent: 1, deferred: 0 });
    expect(api.calls).toHaveLength(2);
    expect(api.calls[1]).toMatchObject({
      method: "PATCH",
      url: "https://www.googleapis.com/calendar/v3/calendars/primary/events/provider-event-1",
      headers: {
        authorization: "Bearer token-after-reconnect",
        "if-match": '"provider-etag-1"',
      },
    });
    expect(JSON.parse(api.calls[1]?.body ?? "{}").summary).toBe("Local title");
    expect(itemRow(plane, writebackId).status).toBe("sent");
  });

  test("a pending item never drains — the owner decision is the gate", async () => {
    const plane = openPlane(await tempDir());
    configureApiKey(plane);
    const itemId = stageItem(plane);
    const api = fetchDouble();
    const report = await executorFor(plane, api).drain(plane);
    expect(report.approved).toBe(0);
    expect(api.calls).toHaveLength(0);
    expect(itemRow(plane, itemId).status).toBe("pending");
  });

  test("a discarded item is terminal: no egress, ever", async () => {
    const plane = openPlane(await tempDir());
    configureApiKey(plane);
    const itemId = stageItem(plane);
    await plane.decideOutbox({ itemId, decision: "discard" });
    const api = fetchDouble();
    await executorFor(plane, api).drain(plane);
    expect(api.calls).toHaveLength(0);
    expect(itemRow(plane, itemId).status).toBe("discarded");
  });

  test("a request outside the allowed_hosts pin fails terminally with zero egress", async () => {
    const plane = openPlane(await tempDir());
    configureApiKey(plane);
    const itemId = stageItem(plane, {
      request: {
        method: "POST",
        url: "https://evil.example.com/exfil",
        headers: { authorization: "Bearer {{connection:api_key}}" },
        body: '{"raw":"x"}',
      },
    });
    await plane.decideOutbox({ itemId, decision: "approve" });
    const api = fetchDouble();
    const report = await executorFor(plane, api).drain(plane);
    expect(report).toMatchObject({ failed: 1, sent: 0 });
    expect(api.calls).toHaveLength(0);
    const row = itemRow(plane, itemId);
    expect(row.status).toBe("failed");
    expect(JSON.parse(String(row.result_json)).detail).toContain(
      "allowed_hosts"
    );
    expect(plane.notices.getBySource("outbox", itemId)).toMatchObject({
      // D4: the reason rides the headline; the full detail stays in the card.
      headline: expect.stringContaining("failed: "),
      detail: expect.objectContaining({ outcome: "failed", itemId }),
      severity: "high",
    });
  });

  test("a 401 gets one forced refresh, then the drain succeeds (oauth2 lane)", async () => {
    const plane = openPlane(await tempDir());
    // Scriptable token endpoint for the broker's refresh.
    const tokenResponses: Array<Record<string, unknown>> = [
      { access_token: "fresh-token", expires_in: 3600 },
    ];
    const tokenServer = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(tokenResponses.shift() ?? { error: "unscripted" })
      );
    });
    await new Promise<void>((resolve) => {
      tokenServer.listen(0, "127.0.0.1", resolve);
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          tokenServer.close(() => resolve());
        })
    );
    const tokenUrl = `http://127.0.0.1:${(tokenServer.address() as { port: number }).port}/token`;

    const configure = plane.gateway.invoke(plane.ownerCredential, {
      command: "sync.configure_credential",
      input: {
        kind: "pull.gmail",
        label: "personal",
        cred_kind: "oauth2",
        provider: "google",
        auth_url: "https://accounts.google.com/o/oauth2/v2/auth",
        token_url: tokenUrl,
        client_id: "cid.apps.googleusercontent.com",
        allowed_hosts: ["gmail.googleapis.com"],
      },
    });
    if (configure.status !== "executed") throw new Error("configure failed");
    const connectionId = (configure as { output: { connection_id: string } })
      .output.connection_id;
    plane.gateway.invoke(plane.ownerCredential, {
      command: "sync.store_tokens",
      input: {
        connection_id: connectionId,
        access_token: "stale-token",
        refresh_token: "rt-1",
      },
    });

    const itemId = stageItem(plane, {
      request: {
        method: "POST",
        url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        headers: { authorization: "Bearer {{connection:access_token}}" },
        body: '{"raw":"x"}',
      },
    });
    await plane.decideOutbox({ itemId, decision: "approve" });

    const api = fetchDouble();
    api.respond(401, '{"error":"invalid credentials"}');
    api.respond(200, '{"id":"msg-2"}');
    const report = await executorFor(plane, api).drain(plane);
    expect(report).toMatchObject({ sent: 1, failed: 0, deferred: 0 });
    expect(api.calls).toHaveLength(2);
    expect(api.calls[0]?.headers.authorization).toBe("Bearer stale-token");
    expect(api.calls[1]?.headers.authorization).toBe("Bearer fresh-token");
    expect(itemRow(plane, itemId).status).toBe("sent");
  });

  test("a hung external write times out; deferred per the existing network-failure policy — issue #351", async () => {
    const plane = openPlane(await tempDir());
    configureApiKey(plane);
    const itemId = stageItem(plane);
    await plane.decideOutbox({ itemId, decision: "approve" });

    const broker = new ConnectionBroker(() => plane);
    // A short write timeout so the test doesn't wait out the real 60s default.
    const executor = new OutboxExecutor(broker, silentLogger, hangingFetch(), {
      writeTimeoutMs: 30,
    });
    const report = await executor.drain(plane);
    // Same disposition as any other network failure (see drainItem's catch):
    // the item stays approved for a later pass, nothing terminal happens.
    expect(report).toMatchObject({
      approved: 1,
      sent: 0,
      failed: 0,
      deferred: 1,
    });
    expect(itemRow(plane, itemId).status).toBe("approved");
  });

  test("a credential-less connection defers the item — it survives for the reconnect", async () => {
    const plane = openPlane(await tempDir());
    // A connection with no credential sidecar (harness-ambient lane).
    plane.db.vault
      .prepare(
        `INSERT INTO sync_connection (connection_id, kind, label, principal, status, trust, created_at)
       VALUES ('conn-amb', 'pull.gmail', 'personal', NULL, 'active', 'staged', ?)`
      )
      .run(new Date().toISOString());
    const itemId = stageItem(plane);
    await plane.decideOutbox({ itemId, decision: "approve" });
    const api = fetchDouble();
    const report = await executorFor(plane, api).drain(plane);
    expect(report).toMatchObject({
      approved: 1,
      deferred: 1,
      sent: 0,
      failed: 0,
    });
    expect(api.calls).toHaveLength(0);
    expect(itemRow(plane, itemId).status).toBe("approved");
  });

  test("a stale approval reparks to pending instead of draining (issue #308 A7)", async () => {
    const plane = openPlane(await tempDir());
    configureApiKey(plane);
    const itemId = stageItem(plane);
    await plane.decideOutbox({ itemId, decision: "approve" });
    // Monday's approval, Thursday's drain: age the decision past the window.
    plane.db.vault
      .prepare("UPDATE outbox_item SET decided_at = ? WHERE item_id = ?")
      .run(new Date(Date.now() - 25 * 3_600_000).toISOString(), itemId);
    const api = fetchDouble();
    const report = await executorFor(plane, api).drain(plane);
    expect(report).toMatchObject({
      approved: 1,
      sent: 0,
      failed: 0,
      reparked: 1,
    });
    // Zero egress; the item waits for a FRESH decision, with the delay named.
    expect(api.calls).toHaveLength(0);
    const row = plane.db.vault
      .prepare(
        "SELECT status, decided_at, note FROM outbox_item WHERE item_id = ?"
      )
      .get(itemId) as {
      status: string;
      decided_at: string | null;
      note: string;
    };
    expect(row.status).toBe("pending");
    expect(row.decided_at).toBeNull();
    expect(row.note).toContain("expired");
    expect(plane.notices.getBySource("outbox", itemId)).toMatchObject({
      headline: expect.stringContaining("needs approval again"),
      detail: expect.objectContaining({ outcome: "reparked", itemId }),
      severity: "warning",
    });
    // A fresh approval within the window drains normally.
    await plane.decideOutbox({ itemId, decision: "approve" });
    api.respond(200, '{"id":"msg-9"}');
    const second = await executorFor(plane, api).drain(plane);
    expect(second).toMatchObject({ sent: 1, reparked: 0 });
  });

  test("one pass drains a bounded batch; the surplus stays approved for the next pass (issue #308 A8)", async () => {
    const plane = openPlane(await tempDir());
    configureApiKey(plane);
    const items = [stageItem(plane), stageItem(plane), stageItem(plane)];
    await Promise.all(
      items.map((itemId) => plane.decideOutbox({ itemId, decision: "approve" }))
    );
    const api = fetchDouble();
    api.respond(200);
    api.respond(200);
    const capped = await executorFor(plane, api, { maxItemsPerDrain: 2 }).drain(
      plane
    );
    expect(capped).toMatchObject({ approved: 3, sent: 2, deferred: 1 });
    const remaining = plane.db.vault
      .prepare(
        `SELECT count(*) AS n FROM outbox_item WHERE status = 'approved'`
      )
      .get() as { n: number };
    expect(remaining.n).toBe(1);
    // The next pass finishes the queue — bounded, never dropped.
    api.respond(200);
    const next = await executorFor(plane, api, { maxItemsPerDrain: 2 }).drain(
      plane
    );
    expect(next).toMatchObject({ approved: 1, sent: 1, deferred: 0 });
  });

  test("the per-actor cap bounds a single actor flushing the whole pass (issue #308 A8)", async () => {
    const plane = openPlane(await tempDir());
    configureApiKey(plane);
    const items = [stageItem(plane), stageItem(plane)];
    await Promise.all(
      items.map((itemId) => plane.decideOutbox({ itemId, decision: "approve" }))
    );
    const api = fetchDouble();
    api.respond(200);
    const report = await executorFor(plane, api, { maxItemsPerActor: 1 }).drain(
      plane
    );
    expect(report).toMatchObject({ approved: 2, sent: 1, deferred: 1 });
    expect(api.calls).toHaveLength(1);
  });

  test("blocking lists what waits on the owner; the review feed ranks receipts by risk", async () => {
    const plane = openPlane(await tempDir());
    configureApiKey(plane);
    stageItem(plane);
    const blocking = plane.blocking();
    expect(blocking.outbox).toHaveLength(1);
    expect(blocking.outbox[0]).toMatchObject({
      verb: "gmail.send",
      status: "pending",
    });
    expect(blocking.parked).toHaveLength(0);

    // needs-auth connections surface with their note.
    plane.gateway.invoke(plane.ownerCredential, {
      command: "sync.set_connection_status",
      input: {
        connection_id: blockingConnectionId(plane),
        status: "needs-auth",
        note: "refresh refused — reconnect",
      },
    });
    const after = plane.blocking();
    expect(after.needsAuth).toHaveLength(1);
    expect(after.needsAuth[0]).toMatchObject({
      kind: "pull.gmail",
      note: expect.stringContaining("reconnect"),
    });

    // The review feed carries acts with their salience marker, and widens
    // actorKind / grantId for the Approvals activity surface (#552).
    const feed = plane.reviewFeed(10);
    expect(feed.length).toBeGreaterThan(0);
    expect(feed.every((e) => e.action.startsWith("act "))).toBe(true);
    expect(feed.some((e) => e.risk !== null)).toBe(true);
    // Owner-staged acts refine to an actor kind (or null only when no
    // invocation was attached — every staged act here has one).
    expect(
      feed.every((e) => "actorKind" in e && "grantId" in e && "actor" in e)
    ).toBe(true);

    // Explicit Locker fills join the same review-after-the-fact surface with
    // the normalized origin, but never the revealed secret.
    const added = plane.gateway.invoke(plane.ownerCredential, {
      command: "locker.add_item",
      input: {
        type: "login",
        title: "Example",
        username: "owner@example.test",
        password: "not-in-the-review-feed",
        url: "https://example.test",
      },
    });
    expect(added.status).toBe("executed");
    const itemId = (added as { output: { item_id: string } }).output.item_id;
    plane.gateway.reveal(plane.ownerCredential, {
      entity: "locker.item",
      entityId: itemId,
      columns: ["password"],
      context: { kind: "fill", origin: "https://example.test" },
    });
    const fills = plane
      .reviewFeed(20)
      .filter((entry) => entry.action === "reveal");
    expect(fills).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          objectType: "locker.item",
          context: { kind: "fill", origin: "https://example.test" },
          // Owner-direct reveals have no agent invocation — actorId null and
          // refined fields stay null (#552).
          actorId: null,
          actorKind: null,
          actor: null,
          grantId: null,
        }),
      ])
    );
    expect(JSON.stringify(fills)).not.toContain("not-in-the-review-feed");
  });

  test("review feed surfaces standing outbox grant id and refined actorKind (issue #552)", async () => {
    const plane = openPlane(await tempDir());
    configureApiKey(plane);
    // Mint a standing grant, then stage under it so auto-approve carries grant_id.
    const stage1 = plane.gateway.invoke(plane.ownerCredential, {
      command: "outbox.stage",
      input: {
        kind: "pull.gmail",
        label: "personal",
        verb: "gmail.send",
        target: "ravi@example.com",
        artifact: { to: "ravi@example.com", subject: "Hi", body: "See you." },
        request: {
          method: "POST",
          url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
          headers: { authorization: "Bearer {{connection:api_key}}" },
          body: '{"raw":"x"}',
        },
      },
    });
    expect(stage1.status).toBe("executed");
    const itemId = (stage1 as { output: { item_id: string } }).output.item_id;
    const decide = await plane.decideOutbox({
      itemId,
      decision: "approve",
      alwaysAllow: true,
    });
    expect(decide.status).toBe("executed");
    const grantId = (decide as { output: { grant_id?: string } }).output
      .grant_id;
    expect(grantId).toBeTruthy();

    // Second stage under the standing grant — auto-approved at staging time.
    const stage2 = plane.gateway.invoke(plane.ownerCredential, {
      command: "outbox.stage",
      input: {
        kind: "pull.gmail",
        label: "personal",
        verb: "gmail.send",
        target: "ravi@example.com",
        artifact: { to: "ravi@example.com", subject: "Again", body: "Yo." },
        request: {
          method: "POST",
          url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
          headers: { authorization: "Bearer {{connection:api_key}}" },
          body: '{"raw":"y"}',
        },
      },
    });
    expect(stage2.status).toBe("executed");
    expect(
      (stage2 as { output: { status: string; grant_id?: string } }).output
        .status
    ).toBe("approved");
    expect((stage2 as { output: { grant_id?: string } }).output.grant_id).toBe(
      grantId
    );

    const feed = plane.reviewFeed(50);
    const autoAllowed = feed.find(
      (e) => e.action === "act outbox.stage" && e.grantId === grantId
    );
    expect(autoAllowed).toMatchObject({
      grantId,
      decision: "allow",
      // Owner-device stages refine to owner (or null only if table miss).
      actorKind: expect.stringMatching(/owner|app|agent|assistant/u),
    });
    // Null-actor receipts (no invocation) still shape-correct.
    expect(
      feed
        .filter((entry) => entry.actorId === null)
        .every((entry) => entry.actorKind === null && entry.actor === null)
    ).toBe(true);
  });
});

function blockingConnectionId(plane: VaultPlane): string {
  const row = plane.db.vault
    .prepare(
      `SELECT connection_id FROM sync_connection WHERE kind='pull.gmail' LIMIT 1`
    )
    .get() as { connection_id: string };
  return row.connection_id;
}
