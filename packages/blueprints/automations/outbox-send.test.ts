import { describe, expect, it } from "vitest";

import { createHarness, loadEnricher } from "./handler-harness.js";

function decodeRaw(body: string | undefined): string {
  const parsed = JSON.parse(body ?? "{}") as { raw?: string };
  return Buffer.from(parsed.raw ?? "", "base64url").toString("utf8");
}

function gmailEntities() {
  return {
    "social.message": [
      {
        message_id: "m1",
        thread_id: "t1",
        sender_party_id: "p-owner",
        body_content_id: "c-body",
        delivery: "sent",
        external_id: null,
      },
    ],
    "social.thread": [
      { thread_id: "t1", channel: "email", subject: "Plumber quote" },
    ],
    "social.thread_participant": [
      { thread_id: "t1", party_id: "p-owner", handle: "owner@example.com" },
      { thread_id: "t1", party_id: "p2", handle: "friend@example.com" },
      { thread_id: "t1", party_id: "p3", handle: "not-an-email" },
    ],
    "core.party_identifier": [
      { party_id: "p3", scheme: "email", value: "backup@example.com" },
      {
        party_id: "p3",
        scheme: "email",
        value: "primary@example.com",
        is_primary: 1,
      },
    ],
  };
}

describe("google-gmail-send outbox staging", () => {
  it("stages a released email as the exact gmail.send outbox item", async () => {
    const handler = await loadEnricher("google-gmail-send");
    const harness = createHarness({
      entities: gmailEntities(),
      content: {
        "c-body:text": {
          status: "ok",
          kind: "text",
          mediaType: "text/plain",
          text: "See you at nine.",
          truncated: false,
        },
      },
    });

    const result = (await handler({ ctx: harness.ctx, log: harness.log })) as {
      summary: string;
      output: { staged: number; skipped: number };
    };

    expect(result.output).toStrictEqual({ staged: 1, skipped: 0 });
    expect(harness.invokes).toHaveLength(1);
    const staged = harness.invokes[0]!;
    expect(staged.command).toBe("outbox.stage");
    expect(staged.input).toMatchObject({
      kind: "pull.gmail",
      label: "personal",
      verb: "gmail.send",
      target: "friend@example.com, primary@example.com",
      artifact: {
        to: ["friend@example.com", "primary@example.com"],
        subject: "Plumber quote",
        body: "See you at nine.",
        message_id: "m1",
      },
    });
    const request = staged.input.request as {
      method: string;
      url: string;
      headers: Record<string, string>;
      body: string;
    };
    expect(request.method).toBe("POST");
    expect(request.url).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
    );
    expect(request.headers.authorization).toBe(
      "Bearer {{connection:access_token}}"
    );
    expect(decodeRaw(request.body)).toBe(
      [
        "To: friend@example.com, primary@example.com",
        "Subject: Plumber quote",
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="UTF-8"',
        "",
        "See you at nine.",
      ].join("\r\n")
    );
    expect(harness.state.get("staged:m1")).toBe("item-1");
  });

  it("resolves recipients by handle first, then primary party email, never the sender", async () => {
    const handler = await loadEnricher("google-gmail-send");
    const entities = gmailEntities();
    entities["social.thread_participant"].push({
      thread_id: "t1",
      party_id: "p4",
      handle: "friend@example.com",
    });
    const harness = createHarness({ entities });

    await handler({ ctx: harness.ctx, log: harness.log });

    const artifact = harness.invokes[0]!.input.artifact as { to: string[] };
    expect(artifact.to).toStrictEqual([
      "friend@example.com",
      "primary@example.com",
    ]);
  });

  it("skips non-email threads and already-staged messages without writing", async () => {
    const handler = await loadEnricher("google-gmail-send");
    const entities = gmailEntities();
    entities["social.thread"][0]!.channel = "slack";
    entities["social.message"].push({
      message_id: "m2",
      thread_id: "t-missing",
      sender_party_id: "p-owner",
      body_content_id: "c2",
      delivery: "sent",
      external_id: null,
    });
    const harness = createHarness({
      entities,
      state: { "staged:m2": "item-prior" },
    });

    const result = (await handler({ ctx: harness.ctx, log: harness.log })) as {
      output: { staged: number; skipped: number };
    };

    expect(result.output).toStrictEqual({ staged: 0, skipped: 2 });
    expect(harness.invokes).toHaveLength(0);
  });

  it("leaves a message with no resolvable recipient unstaged so a later fire heals it", async () => {
    const handler = await loadEnricher("google-gmail-send");
    const entities = gmailEntities();
    entities["social.thread_participant"] = [
      { thread_id: "t1", party_id: "p-owner", handle: "owner@example.com" },
      { thread_id: "t1", party_id: "p9", handle: "not-an-email" },
    ];
    entities["core.party_identifier"] = [];
    const harness = createHarness({ entities });

    const result = (await handler({ ctx: harness.ctx, log: harness.log })) as {
      output: { staged: number; skipped: number };
    };

    expect(result.output).toStrictEqual({ staged: 0, skipped: 1 });
    expect(harness.invokes).toHaveLength(0);
    expect(harness.state.size).toBe(0);
  });

  it("throws on an outbox refusal, keeping earlier staged items but not the refused one", async () => {
    const handler = await loadEnricher("google-gmail-send");
    const entities = gmailEntities();
    entities["social.message"] = [
      {
        message_id: "mA",
        thread_id: "t1",
        sender_party_id: "p-owner",
        body_content_id: "c-body",
        delivery: "sent",
        external_id: null,
      },
      {
        message_id: "mZ",
        thread_id: "t1",
        sender_party_id: "p-owner",
        body_content_id: "c-body",
        delivery: "sent",
        external_id: null,
      },
    ];
    const harness = createHarness({
      entities,
      invoke: (record) => {
        const artifact = record.input.artifact as { message_id: string };
        return artifact.message_id === "mA"
          ? { status: "refused", reason: "consent lapsed" }
          : { status: "executed", output: { item_id: "ok-1" } };
      },
    });

    await expect(
      handler({ ctx: harness.ctx, log: harness.log })
    ).rejects.toThrow("outbox.stage refused for mA: consent lapsed");
    expect(harness.state.get("staged:mZ")).toBe("ok-1");
    expect(harness.state.has("staged:mA")).toBe(false);
  });

  it("stages at most 10 items per fire and leaves the rest for the next one", async () => {
    const handler = await loadEnricher("google-gmail-send");
    const rows = Array.from({ length: 12 }, (_, index) => ({
      message_id: `m${String(index + 1).padStart(2, "0")}`,
      thread_id: "t1",
      sender_party_id: "p-owner",
      body_content_id: "c-body",
      delivery: "sent",
      external_id: null,
    }));
    const entities = gmailEntities();
    const harness = createHarness({
      entities,
      input: { rows },
    });

    const result = (await handler({ ctx: harness.ctx, log: harness.log })) as {
      summary: string;
      output: { staged: number };
    };

    expect(result.output.staged).toBe(10);
    expect(harness.invokes).toHaveLength(10);
    expect(result.summary).toBe("staged 10 outbox item(s), skipped 0");
    expect(
      harness.reads.filter((read) => read.entity === "social.message")
    ).toHaveLength(0);
  });
});

function inviteEntities() {
  return {
    "core.vault": [{ owner_party_id: "p-owner" }],
    "schedule.attendee": [
      {
        attendee_id: "att-1",
        event_id: "ev-1",
        party_id: "p-guest",
        partstat: "needs-action",
      },
    ],
    "core.event": [
      {
        event_id: "ev-1",
        summary: "Dinner; bring wine, please",
        description: "Line one\nLine two",
        dtstart: "2099-02-01T18:30:00.000Z",
        dtend: "2099-02-01T20:00:00.000Z",
        status: "confirmed",
        sequence: 2,
      },
    ],
    "core.party_identifier": [
      {
        party_id: "p-owner",
        scheme: "email",
        value: "owner@example.com",
        is_primary: 1,
      },
      {
        party_id: "p-guest",
        scheme: "email",
        value: "guest@example.com",
        is_primary: 1,
      },
    ],
  };
}

describe("google-calendar-invite-send outbox staging", () => {
  it("renders the guest a minimal RFC 5545 invite inside the staged message", async () => {
    const handler = await loadEnricher("google-calendar-invite-send");
    const harness = createHarness({ entities: inviteEntities() });

    const result = (await handler({ ctx: harness.ctx, log: harness.log })) as {
      output: { staged: number; skipped: number };
    };

    expect(result.output).toStrictEqual({ staged: 1, skipped: 0 });
    const staged = harness.invokes[0]!;
    expect(staged.command).toBe("outbox.stage");
    expect(staged.input).toMatchObject({
      kind: "pull.gmail",
      verb: "gmail.send",
      target: "guest@example.com",
      artifact: {
        to: ["guest@example.com"],
        subject: "Invite: Dinner; bring wine, please",
        event_id: "ev-1",
        attendee_id: "att-1",
      },
    });
    const raw = decodeRaw((staged.input.request as { body: string }).body);
    expect(raw).toContain('Content-Type: text/calendar; charset="UTF-8"');
    const ics = raw.split("\r\n").filter((line) => /^[A-Z]+[;:]/u.test(line));
    expect(ics).toContain("DTSTART:20990201T183000Z");
    expect(ics).toContain("DTEND:20990201T200000Z");
    expect(ics).toContain("SUMMARY:Dinner\\; bring wine\\, please");
    expect(ics).toContain("DESCRIPTION:Line one\\nLine two");
    expect(ics).toContain("UID:ev-1@centraid.local");
    expect(ics).toContain("SEQUENCE:2");
    expect(ics).toContain("ORGANIZER:mailto:owner@example.com");
    expect(ics).toContain("ATTENDEE;RSVP=TRUE:mailto:guest@example.com");
    expect(harness.state.get("staged:att-1")).toBe("item-1");
  });

  it("skips cancelled events and already-staged attendees; a mail-less guest stays healable", async () => {
    const handler = await loadEnricher("google-calendar-invite-send");
    const entities = inviteEntities();
    entities["core.event"][0]!.status = "cancelled";
    entities["schedule.attendee"].push(
      {
        attendee_id: "att-2",
        event_id: "ev-1",
        party_id: "p-guest",
        partstat: "needs-action",
      },
      {
        attendee_id: "att-3",
        event_id: "ev-gone",
        party_id: "p-guest",
        partstat: "needs-action",
      }
    );
    const harness = createHarness({
      entities,
      state: { "staged:att-2": "item-prior" },
    });

    const result = (await handler({ ctx: harness.ctx, log: harness.log })) as {
      output: { staged: number; skipped: number };
    };

    expect(result.output).toStrictEqual({ staged: 0, skipped: 3 });
    expect(harness.invokes).toHaveLength(0);
  });

  it("skips the owner's own needs-action row instead of inviting the organizer", async () => {
    const handler = await loadEnricher("google-calendar-invite-send");
    const entities = inviteEntities();
    entities["schedule.attendee"] = [
      {
        attendee_id: "att-self",
        event_id: "ev-1",
        party_id: "p-owner",
        partstat: "needs-action",
      },
    ];
    const harness = createHarness({ entities });

    const result = (await handler({ ctx: harness.ctx, log: harness.log })) as {
      output: { staged: number; skipped: number };
    };

    expect(result.output).toStrictEqual({ staged: 0, skipped: 1 });
    expect(harness.invokes).toHaveLength(0);
  });

  it("throws on an outbox refusal without remembering the attendee as staged", async () => {
    const handler = await loadEnricher("google-calendar-invite-send");
    const harness = createHarness({
      entities: inviteEntities(),
      invoke: () => ({ status: "refused", reason: "no standing grant" }),
    });

    await expect(
      handler({ ctx: harness.ctx, log: harness.log })
    ).rejects.toThrow(
      "outbox.stage refused for attendee att-1: no standing grant"
    );
    expect(harness.state.has("staged:att-1")).toBe(false);
  });
});
