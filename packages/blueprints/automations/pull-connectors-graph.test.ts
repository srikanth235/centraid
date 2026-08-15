/*
 * Second half of the pull-connector source contract (issues #304/#781):
 * the Microsoft Graph delta family, Linear, Notion, Todoist, and Gmail.
 * The first half (shared auth refusal, GitHub, Dropbox, Google Calendar/
 * Contacts) lives in pull-connectors.test.ts beside this file; the split is
 * the repo's 625-line file ceiling, not a conceptual boundary.
 *
 * Original scope note of the hand-authored PULL CONNECTORS in this tree
 * (issues #304/#781): cursor discipline (provider tokens, high-water
 * watermarks, honest expiry/reset), external-payload → staging-row shaping
 * (identity normalization, truncation, stable external ids), bounded pages
 * per fire, and the shared auth-refusal path.
 *
 * `packages/blueprints/src/pull-handlers.test.ts` already owns: the Gmail
 * history-page drain, GitLab's independent watermarks, Slack channel-id
 * keying, the Todoist/Notion principal identity pins, and the Microsoft
 * Calendar stale-horizon delta restart. Nothing here restates those flows.
 */

import { describe, expect, it } from "vitest";

import {
  createHarness,
  cursorHarness,
  json,
  loadPull,
} from "./handler-harness.js";
import type { FetchCall, FetchReply } from "./handler-harness.js";

function pullCtx(
  fetch: (call: FetchCall) => FetchReply | Promise<FetchReply>
): {
  ctx: Record<string, unknown>;
  log: { info: (m: string) => void; warn: (m: string) => void };
  fetches: FetchCall[];
} {
  const harness = createHarness({ fetch });
  return { ctx: harness.ctx, log: harness.log, fetches: harness.fetches };
}

describe("microsoft graph delta connectors", () => {
  const CONNECTORS = [
    {
      id: "microsoft-onedrive-pull",
      key: "onedrive.deltaLink",
      freshPath: "/me/drive/root/delta",
      listing: {
        value: [
          {
            id: "f1",
            name: "notes.txt",
            file: { mimeType: "text/plain" },
            webUrl: "https://1drv.example/f1",
            lastModifiedDateTime: "2026-06-01T00:00:00Z",
          },
        ],
        "@odata.deltaLink": "https://graph.microsoft.com/delta-new",
      },
    },
    {
      id: "microsoft-outlook-pull",
      key: "outlook.deltaLink",
      freshPath: "/me/mailFolders/inbox/messages/delta",
      listing: {
        value: [
          {
            id: "m1",
            subject: "Hello",
            from: {
              emailAddress: { name: "Jane", address: "JANE@Example.com" },
            },
            receivedDateTime: "2026-06-01T00:00:00Z",
            bodyPreview: "hi",
            conversationId: "conv-1",
          },
        ],
        "@odata.deltaLink": "https://graph.microsoft.com/delta-new",
      },
    },
  ] as const;

  it.each(CONNECTORS.map((entry) => [entry.id, entry] as const))(
    "%s: recovers a 410 delta token by restarting once and storing the fresh link",
    async (_id, connector) => {
      const spec = await loadPull(connector.id);
      const { ctx, log, fetches } = pullCtx(({ url }) =>
        url === "https://graph.microsoft.com/stale"
          ? { status: 410, headers: {}, text: "gone" }
          : json(connector.listing)
      );
      const harness = cursorHarness({
        [connector.key]: "https://graph.microsoft.com/stale",
      });

      const result = await spec.pull({ ctx, cursor: harness.cursor, log });

      expect(result.rows).toHaveLength(1);
      expect(fetches[0]!.url).toBe("https://graph.microsoft.com/stale");
      expect(fetches[1]!.url).toContain(connector.freshPath);
      expect(harness.updates.get(connector.key)).toBe(
        "https://graph.microsoft.com/delta-new"
      );
    }
  );

  it.each(CONNECTORS.map((entry) => [entry.id, entry] as const))(
    "%s: a delta token still invalid after the reset fails the fire",
    async (_id, connector) => {
      const spec = await loadPull(connector.id);
      const { ctx, log } = pullCtx(() => ({
        status: 410,
        headers: {},
        text: "gone",
      }));
      const harness = cursorHarness({
        [connector.key]: "https://graph.microsoft.com/stale",
      });

      await expect(
        spec.pull({ ctx, cursor: harness.cursor, log })
      ).rejects.toThrow(/delta token remained invalid after reset/u);
    }
  );

  it("onedrive stages only live files, never folders or tombstones", async () => {
    const spec = await loadPull("microsoft-onedrive-pull");
    const { ctx, log } = pullCtx(() =>
      json({
        value: [
          {
            id: "f1",
            name: "notes.txt",
            file: { mimeType: "text/plain" },
            size: 123,
            webUrl: "https://1drv.example/f1",
            lastModifiedDateTime: "2026-06-01T00:00:00Z",
            lastModifiedBy: { user: { displayName: "Srikanth" } },
          },
          { id: "dead", deleted: {}, file: { mimeType: "text/plain" } },
          { id: "dir1", name: "folder", folder: {} },
        ],
        "@odata.deltaLink": "https://graph.microsoft.com/delta-new",
      })
    );

    const result = await spec.pull({
      ctx,
      cursor: cursorHarness().cursor,
      log,
    });

    expect(result.rows).toStrictEqual([
      {
        entity_type: "core.content_item",
        external_id: "onedrive:f1",
        payload: {
          sourceId: "onedrive:f1",
          title: "notes.txt",
          mediaType: "text/plain",
          sourceUrl: "https://1drv.example/f1",
          modifiedAt: "2026-06-01T00:00:00Z",
          owner: "Srikanth",
          body: "123 bytes",
        },
      },
    ]);
  });

  it("outlook drops @removed tombstones and keys threads by conversation", async () => {
    const spec = await loadPull("microsoft-outlook-pull");
    const { ctx, log } = pullCtx(() =>
      json({
        value: [
          {
            id: "m1",
            subject: "Hello",
            from: {
              emailAddress: { name: "Jane", address: "JANE@Example.com" },
            },
            receivedDateTime: "2026-06-01T00:00:00Z",
            bodyPreview: "hi",
            conversationId: "conv-1",
          },
          { id: "m2", "@removed": { reason: "deleted" } },
        ],
        "@odata.deltaLink": "https://graph.microsoft.com/delta-new",
      })
    );

    const result = await spec.pull({
      ctx,
      cursor: cursorHarness().cursor,
      log,
    });

    expect(result.rows).toStrictEqual([
      {
        entity_type: "social.message",
        external_id: "outlook:m1",
        payload: {
          messageId: "outlook:m1",
          subject: "Hello",
          fromName: "Jane",
          fromEmail: "jane@example.com",
          sentAt: "2026-06-01T00:00:00Z",
          body: "hi",
          threadKey: "outlook-conv:conv-1",
        },
      },
    ]);
  });
});

describe("microsoft-calendar-pull", () => {
  // pull-handlers.test.ts owns the stale-horizon roll (a delta link whose
  // encoded window fell behind is abandoned). These cover the other side of
  // that contract: a fresh-horizon link is REUSED, and a 410 inside a fresh
  // window re-bootstraps the calendarView once.
  it("reuses a fresh-horizon delta link and shapes calendarView rows", async () => {
    const spec = await loadPull("microsoft-calendar-pull");
    const { ctx, log, fetches } = pullCtx(({ url }) => {
      expect(url).toBe("https://graph.microsoft.com/delta-cur");
      return json({
        value: [
          {
            id: "ev1",
            iCalUId: "uid-ev1",
            subject: "Dentist",
            bodyPreview: "bring reports",
            start: {
              dateTime: "2099-01-05T10:00:00Z",
              timeZone: "Asia/Kolkata",
            },
            end: { dateTime: "2099-01-05T10:30:00Z" },
            isCancelled: true,
          },
          { id: "ev2", "@removed": { reason: "deleted" } },
        ],
        "@odata.deltaLink": "https://graph.microsoft.com/delta-new",
      });
    });
    const harness = cursorHarness({
      // ctx.now is 2099-01-01, so the freshly computed horizon ends
      // 2101-01-01 — one day past this stored end, well under the roll
      // threshold, so the link must be kept.
      "outlookcal.deltaLink": "https://graph.microsoft.com/delta-cur",
      "outlookcal.windowEnd": "2100-12-31T00:00:00.000Z",
    });

    const result = await spec.pull({ ctx, cursor: harness.cursor, log });

    expect(fetches).toHaveLength(1);
    expect(result.rows).toStrictEqual([
      {
        entity_type: "core.event",
        external_id: "outlookcal:ev1",
        payload: {
          uid: "uid-ev1",
          summary: "Dentist",
          description: "bring reports",
          dtstart: "2099-01-05T10:00:00Z",
          dtend: "2099-01-05T10:30:00Z",
          startTz: "Asia/Kolkata",
          rrule: null,
          status: "cancelled",
        },
      },
    ]);
    expect(harness.updates.get("outlookcal.deltaLink")).toBe(
      "https://graph.microsoft.com/delta-new"
    );
    // A kept link means the window did not move.
    expect(harness.updates.has("outlookcal.windowEnd")).toBe(false);
  });

  it("recovers a 410 inside a fresh window by re-bootstrapping the view once", async () => {
    const spec = await loadPull("microsoft-calendar-pull");
    const { ctx, log, fetches } = pullCtx(({ url }) =>
      url === "https://graph.microsoft.com/delta-cur"
        ? { status: 410, headers: {}, text: "gone" }
        : json({
            value: [{ id: "ev1", subject: "Rebuilt" }],
            "@odata.deltaLink": "https://graph.microsoft.com/delta-new",
          })
    );
    const harness = cursorHarness({
      "outlookcal.deltaLink": "https://graph.microsoft.com/delta-cur",
      "outlookcal.windowEnd": "2100-12-31T00:00:00.000Z",
    });

    const result = await spec.pull({ ctx, cursor: harness.cursor, log });

    // The rebuilt view spans now−1y .. now+2y around the deterministic
    // ctx.now, and the rolled window end is persisted.
    expect(fetches[1]!.url).toBe(
      "https://graph.microsoft.com/v1.0/me/calendarView/delta?startDateTime=2098-01-01T00%3A00%3A00.000Z&endDateTime=2101-01-01T00%3A00%3A00.000Z"
    );
    expect(result.rows).toHaveLength(1);
    expect(harness.updates.get("outlookcal.windowEnd")).toBe(
      "2101-01-01T00:00:00.000Z"
    );
    expect(harness.updates.get("outlookcal.deltaLink")).toBe(
      "https://graph.microsoft.com/delta-new"
    );
  });

  it("fails the fire when the rebuilt view is still gone", async () => {
    const spec = await loadPull("microsoft-calendar-pull");
    const { ctx, log } = pullCtx(() => ({
      status: 410,
      headers: {},
      text: "gone",
    }));
    const harness = cursorHarness({
      "outlookcal.deltaLink": "https://graph.microsoft.com/delta-cur",
      "outlookcal.windowEnd": "2100-12-31T00:00:00.000Z",
    });

    await expect(
      spec.pull({ ctx, cursor: harness.cursor, log })
    ).rejects.toThrow(/delta token remained invalid after reset/u);
  });
});

describe("microsoft-contacts-pull", () => {
  it("filters by the watermark, normalizes identity, and observes the new high water", async () => {
    const spec = await loadPull("microsoft-contacts-pull");
    const { ctx, log, fetches } = pullCtx(() =>
      json({
        value: [
          {
            id: "c1",
            displayName: "Ravi Kumar",
            givenName: "Ravi",
            surname: "Kumar",
            emailAddresses: [{ address: "RAVI@Example.com", name: "work" }],
            mobilePhone: " +91 11111 ",
            birthday: "1990-04-01T00:00:00Z",
            lastModifiedDateTime: "2026-06-02T00:00:00Z",
          },
          {
            id: "c2",
            emailAddresses: [{ address: "noname@example.com" }],
            lastModifiedDateTime: "2026-06-03T00:00:00Z",
          },
        ],
      })
    );
    const harness = cursorHarness({
      "outlookcontacts.modifiedAt": "2026-06-01T00:00:00Z",
    });

    const result = await spec.pull({ ctx, cursor: harness.cursor, log });

    expect(fetches[0]!.url).toContain(
      "%24filter=lastModifiedDateTime+ge+2026-06-01"
    );
    expect(result.rows[0]).toStrictEqual({
      entity_type: "core.party",
      external_id: "outlookcontacts:c1",
      payload: {
        fn: "Ravi Kumar",
        sortName: "Kumar, Ravi",
        bday: "1990-04-01",
        identifiers: [
          { scheme: "email", value: "ravi@example.com", label: "work" },
          { scheme: "tel", value: "+91 11111", label: "mobile" },
        ],
      },
    });
    // No display name: the first identifier stands in.
    expect(result.rows[1]!.payload).toMatchObject({
      fn: "noname@example.com",
    });
    expect(harness.updates.get("outlookcontacts.modifiedAt")).toBe(
      "2026-06-03T00:00:00Z"
    );
  });
});

describe("linear-pull", () => {
  it("treats a 200 carrying GraphQL errors as a failed fire", async () => {
    const spec = await loadPull("linear-pull");
    const { ctx, log } = pullCtx(() =>
      json({ errors: [{ message: "rate limited" }] })
    );

    await expect(
      spec.pull({ ctx, cursor: cursorHarness().cursor, log })
    ).rejects.toThrow(/linear graphql error/u);
  });

  it("stores the page cursor only while more pages exist and shapes issue rows", async () => {
    const spec = await loadPull("linear-pull");
    const issue = {
      id: "abc",
      identifier: "ENG-1",
      title: "Fix login",
      description: "d".repeat(5000),
      url: "https://linear.example/ENG-1",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      state: { name: "In Progress" },
      assignee: { name: "Asha" },
    };
    const { ctx, log } = pullCtx(({ body }) => {
      expect(JSON.parse(body ?? "{}")).toMatchObject({
        variables: { after: "cur-1" },
      });
      return json({
        data: {
          issues: {
            pageInfo: { hasNextPage: true, endCursor: "cur-2" },
            nodes: [issue],
          },
        },
      });
    });
    const harness = cursorHarness({ "linear.after": "cur-1" });

    const result = await spec.pull({ ctx, cursor: harness.cursor, log });

    expect(harness.updates.get("linear.after")).toBe("cur-2");
    expect(result.rows).toStrictEqual([
      {
        entity_type: "core.content_item",
        external_id: "linear:abc",
        payload: {
          sourceId: "linear:abc",
          title: "[ENG-1] Fix login",
          mediaType: "application/vnd.linear.issue",
          sourceUrl: "https://linear.example/ENG-1",
          modifiedAt: "2026-01-02T00:00:00Z",
          owner: "Asha",
          body: `Status: In Progress\n\n${"d".repeat(4000)}`,
        },
      },
    ]);
  });
});

describe("notion-pull", () => {
  it("recovers an invalid start_cursor by clearing it and searching from the top", async () => {
    const spec = await loadPull("notion-pull");
    const { ctx, log, fetches } = pullCtx(({ body }) => {
      const parsed = JSON.parse(body ?? "{}") as { start_cursor?: string };
      if (parsed.start_cursor === "bad") {
        return {
          status: 400,
          headers: {},
          text: '{"message":"invalid start_cursor"}',
        };
      }
      return json({
        results: [
          {
            object: "page",
            id: "pg1",
            url: "https://notion.example/pg1",
            last_edited_time: "2026-02-01T00:00:00Z",
            last_edited_by: { name: "Srikanth" },
            properties: {
              Name: {
                type: "title",
                title: [{ plain_text: "Reading " }, { plain_text: "list" }],
              },
            },
          },
          { object: "database", id: "db1" },
        ],
        has_more: false,
      });
    });
    const harness = cursorHarness({ "notion.start_cursor": "bad" });

    const result = await spec.pull({ ctx, cursor: harness.cursor, log });

    expect(fetches).toHaveLength(2);
    expect(
      (JSON.parse(fetches[1]!.body ?? "{}") as Record<string, unknown>)
        .start_cursor
    ).toBeUndefined();
    // Only pages stage; the title is joined from the title property runs.
    expect(result.rows).toStrictEqual([
      {
        entity_type: "core.content_item",
        external_id: "notion:pg1",
        payload: {
          sourceId: "notion:pg1",
          title: "Reading list",
          mediaType: "application/vnd.notion.page",
          sourceUrl: "https://notion.example/pg1",
          modifiedAt: "2026-02-01T00:00:00Z",
          owner: "Srikanth",
          body: "",
        },
      },
    ]);
    expect(harness.updates.get("notion.start_cursor")).toBeNull();
  });
});

describe("todoist-pull", () => {
  it("stages only open tasks with the due/priority context in the body", async () => {
    const spec = await loadPull("todoist-pull");
    const { ctx, log } = pullCtx(() =>
      json([
        {
          id: "11",
          content: "Renew passport",
          description: "Bring photos",
          due: { date: "2026-09-01" },
          priority: 4,
          url: "https://todoist.example/11",
          created_at: "2026-08-01T00:00:00Z",
          is_completed: false,
        },
        { id: "12", content: "Done thing", is_completed: true },
      ])
    );

    const result = await spec.pull({
      ctx,
      cursor: cursorHarness().cursor,
      log,
    });

    expect(result.rows).toStrictEqual([
      {
        entity_type: "core.content_item",
        external_id: "todoist:11",
        payload: {
          sourceId: "todoist:11",
          title: "Renew passport",
          mediaType: "application/vnd.todoist.task",
          sourceUrl: "https://todoist.example/11",
          modifiedAt: "2026-08-01T00:00:00Z",
          owner: null,
          body: "Bring photos\nDue: 2026-09-01\nPriority: 4\nhttps://todoist.example/11",
        },
      },
    ]);
  });

  it("refuses an account whose Inbox identity pin is missing", async () => {
    const spec = await loadPull("todoist-pull");
    const { ctx } = pullCtx(() =>
      json([{ id: "p1", is_inbox_project: false }])
    );

    await expect(spec.principal({ ctx })).rejects.toThrow(
      /account has no Inbox project identity/u
    );
  });
});

describe("google-gmail-pull", () => {
  it("falls back to the bounded 30-day window when the history cursor expired", async () => {
    const spec = await loadPull("google-gmail-pull", { fresh: true });
    const { ctx, log, fetches } = pullCtx(({ url }) => {
      if (url.endsWith("/profile")) {
        return json({ emailAddress: "owner@example.com", historyId: "900" });
      }
      if (url.includes("/history?")) {
        return { status: 404, headers: {}, text: "expired" };
      }
      if (url.includes("/messages?")) return json({ messages: [{ id: "m9" }] });
      return json({
        id: "m9",
        threadId: "t9",
        internalDate: "1700000000000",
        snippet: "quick note",
        payload: {
          headers: [
            { name: "From", value: '"Jane Doe" <JANE@Example.COM>' },
            { name: "Subject", value: "Yo" },
          ],
        },
      });
    });

    await expect(spec.principal({ ctx })).resolves.toBe("owner@example.com");
    const harness = cursorHarness({ "gmail.historyId": "5" });
    const result = await spec.pull({ ctx, cursor: harness.cursor, log });

    expect(fetches.some((call) => call.url.includes("q=newer_than:30d"))).toBe(
      true
    );
    expect(result.summary).toBe("pulled 1 message(s) (window)");
    expect(result.rows[0]).toStrictEqual({
      entity_type: "social.message",
      external_id: "gmail:m9",
      payload: {
        messageId: "gmail:m9",
        subject: "Yo",
        // RFC 2822 From parsing: display name kept, address lowercased.
        fromName: "Jane Doe",
        fromEmail: "jane@example.com",
        sentAt: "2023-11-14T22:13:20.000Z",
        body: "quick note",
        threadKey: "gmail-thread:t9",
      },
    });
    // The watermark is the profile's historyId captured BEFORE listing.
    expect(harness.updates.get("gmail.historyId")).toBe("900");
  });

  it("refuses to pull without the principal probe's watermark", async () => {
    const spec = await loadPull("google-gmail-pull", { fresh: true });
    const { ctx, log } = pullCtx(() => json({}));

    await expect(
      spec.pull({ ctx, cursor: cursorHarness().cursor, log })
    ).rejects.toThrow("gmail principal probe did not return a profile");
  });
});
