/*
 * Source-level contract of the hand-authored PULL CONNECTORS in this tree
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

describe("shared connector auth refusal", () => {
  it.each([
    ["dropbox-pull"],
    ["google-drive-pull"],
    ["notion-pull"],
    ["todoist-pull"],
    ["microsoft-onedrive-pull"],
    ["microsoft-outlook-pull"],
    ["microsoft-contacts-pull"],
  ])("%s: a 401 fails the fire and advances no cursor", async (id) => {
    const spec = await loadPull(id);
    const { ctx, log } = pullCtx(() => ({
      status: 401,
      headers: {},
      text: "token revoked",
    }));
    const harness = cursorHarness({ "any.cursor": "keep" });

    await expect(
      spec.pull({ ctx, cursor: harness.cursor, log })
    ).rejects.toThrow(/auth failed \(401\)/u);
    expect([...harness.updates.entries()]).toStrictEqual([]);
  });
});

describe("github-pull", () => {
  it("pins the principal to the token's login", async () => {
    const spec = await loadPull("github-pull");
    const { ctx } = pullCtx(({ url }) => {
      expect(url).toBe("https://api.github.com/user");
      return json({ login: "srikanth235" });
    });
    await expect(spec.principal({ ctx })).resolves.toBe("srikanth235");
  });

  it("drains asc pages from the since watermark and shapes issue/PR rows", async () => {
    const spec = await loadPull("github-pull");
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      number: index + 1,
      title: `Issue ${index + 1}`,
      state: "open",
      user: { login: "author" },
      created_at: "2026-01-02T00:00:00Z",
      updated_at: `2026-01-02T00:${String(index % 60).padStart(2, "0")}:00Z`,
      body: "b".repeat(5000),
      repository: { full_name: "acme/widgets" },
    }));
    const merged = {
      number: 7,
      title: "Ship it",
      state: "closed",
      user: { login: "author" },
      created_at: "2026-01-03T00:00:00Z",
      updated_at: "2026-02-01T00:00:00Z",
      body: null,
      pull_request: {},
      repository_url: "https://api.github.com/repos/acme/widgets",
    };
    const { ctx, log, fetches } = pullCtx(({ url }) => {
      const page = new URL(url).searchParams.get("page");
      return json(page === "1" ? fullPage : [merged]);
    });
    const harness = cursorHarness({ "github.since": "2026-01-01T00:00:00Z" });

    const result = await spec.pull({ ctx, cursor: harness.cursor, log });

    expect(result.rows).toHaveLength(101);
    expect(fetches).toHaveLength(2);
    expect(fetches[0]!.url).toContain("since=2026-01-01T00%3A00%3A00Z");
    expect(fetches[0]!.url).toContain("direction=asc");
    // The watermark is the max updated_at actually seen, not the clock.
    expect(harness.updates.get("github.since")).toBe("2026-02-01T00:00:00Z");
    expect(result.rows[0]).toStrictEqual({
      entity_type: "social.message",
      external_id: "github:acme/widgets/1",
      payload: {
        messageId: "github:acme/widgets/1",
        subject: "[acme/widgets#1] Issue 1",
        fromName: "author",
        fromEmail: null,
        sentAt: "2026-01-02T00:00:00Z",
        body: `issue acme/widgets#1 is open\n\n${"b".repeat(4000)}`,
        threadKey: "github:acme/widgets#1",
      },
    });
    // A PR names itself as one, and the repo parses out of repository_url.
    expect(result.rows[100]).toMatchObject({
      external_id: "github:acme/widgets/7",
      payload: { body: "PR acme/widgets#7 is closed" },
    });
  });
});

describe("dropbox-pull", () => {
  it("recovers a reset provider cursor by relisting from the root once", async () => {
    const spec = await loadPull("dropbox-pull");
    const { ctx, log, fetches } = pullCtx(({ url, body }) => {
      if (url.endsWith("/files/list_folder/continue")) {
        return { status: 409, headers: {}, text: '{"error_summary":"reset/"}' };
      }
      expect(JSON.parse(body ?? "{}")).toMatchObject({ path: "" });
      return json({
        entries: [
          { ".tag": "file", id: "id:1", name: "a.txt", path_display: "/a.txt" },
          { ".tag": "folder", id: "id:2", name: "dir" },
        ],
        cursor: "cur-new",
        has_more: false,
      });
    });
    const harness = cursorHarness({ "dropbox.cursor": "cur-stale" });

    const result = await spec.pull({ ctx, cursor: harness.cursor, log });

    expect(fetches.map((call) => new URL(call.url).pathname)).toStrictEqual([
      "/2/files/list_folder/continue",
      "/2/files/list_folder",
    ]);
    // Folders never stage; the fresh cursor replaces the reset one.
    expect(result.rows).toStrictEqual([
      {
        entity_type: "core.content_item",
        external_id: "dropbox:id:1",
        payload: {
          sourceId: "dropbox:id:1",
          title: "a.txt",
          mediaType: "application/octet-stream",
          sourceUrl: "dropbox:/a.txt",
          modifiedAt: null,
          owner: null,
          body: "",
        },
      },
    ]);
    expect(harness.updates.get("dropbox.cursor")).toBe("cur-new");
  });

  it("gives up when the cursor stays reset after one recovery attempt", async () => {
    const spec = await loadPull("dropbox-pull");
    const { ctx, log } = pullCtx(() => ({
      status: 409,
      headers: {},
      text: '{"error_summary":"reset/"}',
    }));
    const harness = cursorHarness({ "dropbox.cursor": "cur-stale" });

    await expect(
      spec.pull({ ctx, cursor: harness.cursor, log })
    ).rejects.toThrow(/answered 409/u);
  });
});

describe("google-calendar-pull", () => {
  it("keeps syncToken and pageToken mutually exclusive and lands on the sync token", async () => {
    const spec = await loadPull("google-calendar-pull");
    const pageOne = {
      items: [
        {
          id: "e1",
          iCalUID: "uid-e1",
          summary: "Standup",
          start: { dateTime: "2026-05-01T09:00:00Z", timeZone: "Asia/Kolkata" },
          end: { dateTime: "2026-05-01T09:15:00Z" },
          recurrence: ["RRULE:FREQ=WEEKLY", "EXDATE:20260508"],
          status: "confirmed",
          etag: '"v1"',
          updated: "2026-04-30T00:00:00Z",
        },
        // A bare tombstone of an event this vault never saw: dropped.
        { id: "gone", status: "cancelled" },
        {
          id: "e2",
          summary: "Holiday",
          start: { date: "2026-05-02" },
          end: { date: "2026-05-03" },
        },
      ],
      nextPageToken: "p2",
    };
    const { ctx, log, fetches } = pullCtx(({ url }) => {
      const params = new URL(url).searchParams;
      return json(
        params.get("pageToken") === "p2"
          ? { items: [], nextSyncToken: "sync-1" }
          : pageOne
      );
    });
    const harness = cursorHarness();

    const result = await spec.pull({ ctx, cursor: harness.cursor, log });

    const paramsOf = (index: number) =>
      new URL(fetches[index]!.url).searchParams;
    expect(paramsOf(0).has("syncToken")).toBe(false);
    expect(paramsOf(0).has("pageToken")).toBe(false);
    expect(paramsOf(1).get("pageToken")).toBe("p2");
    // Sending syncToken alongside pageToken is a Calendar API 400.
    expect(paramsOf(1).has("syncToken")).toBe(false);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toStrictEqual({
      entity_type: "core.event",
      external_id: "gcal:e1",
      payload: {
        uid: "uid-e1",
        summary: "Standup",
        description: null,
        dtstart: "2026-05-01T09:00:00Z",
        dtend: "2026-05-01T09:15:00Z",
        startTz: "Asia/Kolkata",
        rrule: "RRULE:FREQ=WEEKLY\nEXDATE:20260508",
        status: "confirmed",
        providerVersion: '"v1"',
        providerUpdatedAt: "2026-04-30T00:00:00Z",
        providerFields: [
          "summary",
          "description",
          "start",
          "end",
          "recurrence",
          "status",
        ],
      },
    });
    // All-day events carry the date form; a finished listing stores the
    // sync token and clears the page token.
    expect(result.rows[1]).toMatchObject({
      external_id: "gcal:e2",
      payload: { dtstart: "2026-05-02", dtend: "2026-05-03" },
    });
    expect(harness.updates.get("gcal.syncToken")).toBe("sync-1");
    expect(harness.updates.get("gcal.pageToken")).toBeNull();
  });

  it("clears both cursors on an expired sync token so the next fire rewalks", async () => {
    const spec = await loadPull("google-calendar-pull");
    const { ctx, log, fetches } = pullCtx(() => ({
      status: 410,
      headers: {},
      text: "gone",
    }));
    const harness = cursorHarness({ "gcal.syncToken": "stale-sync" });

    const result = await spec.pull({ ctx, cursor: harness.cursor, log });

    expect(new URL(fetches[0]!.url).searchParams.get("syncToken")).toBe(
      "stale-sync"
    );
    expect(result.rows).toStrictEqual([]);
    expect(harness.updates.get("gcal.syncToken")).toBeNull();
    expect(harness.updates.get("gcal.pageToken")).toBeNull();
  });
});

describe("google-contacts-pull", () => {
  it("normalizes People identities and drops the unstageable shell", async () => {
    const spec = await loadPull("google-contacts-pull");
    const { ctx, log } = pullCtx(() =>
      json({
        connections: [
          {
            resourceName: "people/c1",
            etag: "e1",
            names: [
              { displayName: "Asha Rao", familyName: "Rao", givenName: "Asha" },
            ],
            emailAddresses: [{ value: " Asha@Example.com ", type: "home" }],
            phoneNumbers: [{ value: " +91 98765 " }],
            birthdays: [{ date: { month: 9, day: 5 } }],
          },
          {
            resourceName: "people/c2",
            emailAddresses: [{ value: "ONLY@example.com" }],
          },
          { resourceName: "people/c3" },
        ],
      })
    );
    const harness = cursorHarness();

    const result = await spec.pull({ ctx, cursor: harness.cursor, log });

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toStrictEqual({
      entity_type: "core.party",
      external_id: "gcontacts:people/c1",
      payload: {
        fn: "Asha Rao",
        sortName: "Rao, Asha",
        // A birthday without a year still records month/day. NOTE: the
        // current template yields THREE leading dashes ("--" placeholder
        // plus the joining "-"), where vCard's yearless form is "--09-05".
        // Recorded as-is per the source-level-contract rule; flagged in the
        // #781 slice report as a suspected live defect, not fixed here.
        bday: "---09-05",
        identifiers: [
          { scheme: "email", value: "asha@example.com", label: "home" },
          { scheme: "tel", value: "+91 98765", label: null },
        ],
        providerVersion: "e1",
        providerUpdatedAt: null,
        providerFields: [
          "names",
          "emailAddresses",
          "phoneNumbers",
          "birthdays",
        ],
      },
    });
    // Nameless but reachable: the identifier stands in as the display name.
    expect(result.rows[1]).toMatchObject({
      external_id: "gcontacts:people/c2",
      payload: { fn: "only@example.com", sortName: null },
    });
  });

  it("repeats syncToken alongside pageToken on continuation pages (People API contract)", async () => {
    const spec = await loadPull("google-contacts-pull");
    const { ctx, log, fetches } = pullCtx(({ url }) => {
      const params = new URL(url).searchParams;
      return json(
        params.get("pageToken") === "pt-1"
          ? { connections: [], nextSyncToken: "sync-1" }
          : { connections: [], nextPageToken: "pt-1" }
      );
    });
    const harness = cursorHarness({ "gcontacts.syncToken": "sync-0" });

    await spec.pull({ ctx, cursor: harness.cursor, log });

    const second = new URL(fetches[1]!.url).searchParams;
    expect(second.get("syncToken")).toBe("sync-0");
    expect(second.get("pageToken")).toBe("pt-1");
    expect(harness.updates.get("gcontacts.syncToken")).toBe("sync-1");
    expect(harness.updates.get("gcontacts.pageToken")).toBeNull();
  });
});

describe("google-drive-pull", () => {
  it("resumes from the modifiedTime watermark and shapes file rows", async () => {
    const spec = await loadPull("google-drive-pull");
    const { ctx, log, fetches } = pullCtx(() =>
      json({
        files: [
          {
            id: "d1",
            name: "Budget.xlsx",
            mimeType: "application/vnd.ms-excel",
            modifiedTime: "2026-03-02T00:00:00.000Z",
            webViewLink: "https://drive.example/d1",
            description: "household budget",
            owners: [{ emailAddress: "owner@example.com" }],
          },
          {
            id: "d2",
            name: "Old scan",
            createdTime: "2026-03-05T00:00:00.000Z",
          },
        ],
      })
    );
    const harness = cursorHarness({
      "gdrive.modifiedTime": "2026-03-01T00:00:00.000Z",
    });

    const result = await spec.pull({ ctx, cursor: harness.cursor, log });

    const q = new URL(fetches[0]!.url).searchParams.get("q");
    expect(q).toBe(
      "trashed = false and modifiedTime >= '2026-03-01T00:00:00.000Z'"
    );
    expect(result.rows[0]).toStrictEqual({
      entity_type: "core.content_item",
      external_id: "gdrive:d1",
      payload: {
        sourceId: "gdrive:d1",
        title: "Budget.xlsx",
        mediaType: "application/vnd.ms-excel",
        sourceUrl: "https://drive.example/d1",
        modifiedAt: "2026-03-02T00:00:00.000Z",
        owner: "owner@example.com",
        body: "household budget",
      },
    });
    // createdTime backstops a file that never reports modifiedTime, and the
    // watermark follows the max seen.
    expect(result.rows[1]!.payload).toMatchObject({
      modifiedAt: "2026-03-05T00:00:00.000Z",
    });
    expect(harness.updates.get("gdrive.modifiedTime")).toBe(
      "2026-03-05T00:00:00.000Z"
    );
  });
});
