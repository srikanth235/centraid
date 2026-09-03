import { describe, expect, it } from "vitest";

import type { Harness } from "./logic.test-fixtures.ts";
import { event, harness } from "./logic.test-fixtures.ts";
import type { Attendee } from "./types.ts";
import {
  OUTCOME_DETACHED,
  OUTCOME_OCCURRENCE,
  OUTCOME_PARKED,
  OUTCOME_PROPOSED,
  OUTCOME_QUEUED,
  OUTCOME_UPDATED,
  RSVP_OUTCOME,
} from "./view-copy.ts";

describe("the in-pane notice", () => {
  it("shows a reason and hides itself on the empty string", () => {
    const app = harness();
    app.logic.notice("The vault refused");
    expect(app.banner()).toStrictEqual({
      text: "The vault refused",
      hidden: false,
    });
    app.logic.notice("");
    expect(app.banner()).toStrictEqual({ text: "", hidden: true });
  });

  it("is a no-op on a frame that mounted no banner", () => {
    const app = harness({ banner: false });
    expect(() => app.logic.notice("nowhere")).not.toThrow();
  });
});

describe("narration", () => {
  it("clears the notice and reports the write landed", () => {
    const app = harness();
    app.logic.notice("stale");
    expect(app.logic.narrate({ status: "executed" })).toBe(true);
    expect(app.banner().text).toBe("");
  });

  it("clears the notice for a park — a park is not a banner", () => {
    const app = harness();
    app.logic.notice("stale");
    expect(app.logic.narrate({ status: "parked" })).toBe(false);
    expect(app.banner()).toStrictEqual({ text: "", hidden: true });
  });

  it("puts a refusal's plain-language reason in the notice", () => {
    const app = harness();
    expect(
      app.logic.narrate({ status: "failed", predicate: "slot_free: x" })
    ).toBe(false);
    expect(app.banner().text).toBe("The vault refused: slot_free: x.");
  });

  it("leaves the notice alone when there is nothing to say", () => {
    const app = harness();
    app.logic.notice("standing");
    expect(app.logic.narrate(undefined)).toBe(false);
    expect(app.banner().text).toBe("standing");
  });
});

describe("the raw write path", () => {
  it("turns an unreachable gateway into a notice and no outcome", async () => {
    const app = harness({
      write: async () => {
        throw new Error("gateway unreachable");
      },
    });
    await expect(app.logic.act("propose", {})).resolves.toBeUndefined();
    expect(app.banner().text).toBe("gateway unreachable");
  });

  it("re-reads after any answered write, and only repaints after none", async () => {
    const answered = harness({ write: async () => ({ status: "failed" }) });
    await answered.logic.write("edit-event", { event_id: "e1" });
    expect(answered.reloads()).toBe(1);
    expect(answered.paints).toStrictEqual([]);

    const unreachable = harness({
      write: async () => {
        throw new Error("offline");
      },
    });
    await unreachable.logic.write("edit-event", { event_id: "e1" });
    expect(unreachable.reloads()).toBe(0);
    expect(unreachable.paints).toHaveLength(1);
  });
});

describe("proposing an event", () => {
  it("puts the receipt on the status line with an undo that cancels it", async () => {
    const app = harness({
      write: async () => ({
        status: "executed",
        output: { event_id: "e-new" },
      }),
    });
    await app.logic.proposeEvent({
      summary: "Dentist",
      dtstart: "2026-09-01T09:00:00Z",
    } as never);
    expect(app.status()).toStrictEqual({
      text: OUTCOME_PROPOSED,
      action: { label: "Undo", run: expect.any(Function) },
    });
    app.status()?.action?.run();
    await Promise.resolve();
    expect(app.sent.at(-1)).toStrictEqual({
      action: "cancel-event",
      input: { event_id: "e-new" },
    });
  });

  it("offers no undo when the vault named no event", async () => {
    const app = harness({
      write: async () => ({ status: "executed", output: {} }),
    });
    await app.logic.proposeEvent({ summary: "Dentist" } as never);
    expect(app.status()).toStrictEqual({
      text: OUTCOME_PROPOSED,
      action: null,
    });
  });

  it("says the ask is with the owner when the vault parked it", async () => {
    const app = harness({ write: async () => ({ status: "parked" }) });
    await app.logic.proposeEvent({ summary: "Dentist" } as never);
    expect(app.status()).toStrictEqual({ text: OUTCOME_PARKED, action: null });
  });

  it("says the write is on this device when it is still held here", async () => {
    const queued = harness({ write: async () => ({ status: "queued" }) });
    await queued.logic.proposeEvent({ summary: "Dentist" } as never);
    expect(queued.statusTexts).toStrictEqual([OUTCOME_QUEUED]);

    const inFlight = harness({ write: async () => ({ status: "in-flight" }) });
    await inFlight.logic.proposeEvent({ summary: "Dentist" } as never);
    expect(inFlight.statusTexts).toStrictEqual([OUTCOME_QUEUED]);

    const sending = harness({ write: async () => ({ status: "sending" }) });
    await sending.logic.proposeEvent({ summary: "Dentist" } as never);
    expect(sending.statusTexts).toStrictEqual([OUTCOME_QUEUED]);
  });

  it("says nothing on the status line for an outright refusal", async () => {
    const app = harness({ write: async () => ({ status: "failed" }) });
    await app.logic.proposeEvent({ summary: "Dentist" } as never);
    expect(app.statusTexts).toStrictEqual([]);
    expect(app.banner().hidden).toBe(false);
  });
});

describe("editing", () => {
  it("distinguishes the series receipt from the one-occurrence receipt", async () => {
    const series = harness();
    await series.logic.editEvent({ event_id: "e1", summary: "New" });
    expect(series.sent).toStrictEqual([
      { action: "edit-event", input: { event_id: "e1", summary: "New" } },
    ]);
    expect(series.status()).toStrictEqual({
      text: OUTCOME_UPDATED,
      action: null,
    });

    const one = harness();
    await one.logic.editOccurrence({
      event_id: "e1",
      original_start: "2026-08-21T09:00:00Z",
    } as never);
    expect(one.sent[0]?.action).toBe("edit-occurrence");
    expect(one.status()).toStrictEqual({
      text: OUTCOME_OCCURRENCE,
      action: null,
    });
  });

  it("narrates a held edit rather than claiming a receipt", async () => {
    const app = harness({ write: async () => ({ status: "queued" }) });
    await app.logic.editEvent({ event_id: "e1" });
    expect(app.status()).toStrictEqual({ text: OUTCOME_QUEUED, action: null });
    expect(app.statusTexts).toStrictEqual([OUTCOME_QUEUED]);
  });
});

describe("RSVP paints before the vault answers", () => {
  const guests: Attendee[] = [
    { party_id: "p-me", name: "Me", partstat: "needs-action" },
    { party_id: "p-other", name: "Ravi", partstat: "accepted" },
  ];

  function loaded(over: Parameters<typeof harness>[0] = {}) {
    return harness({
      data: {
        events: [event({ event_id: "e1", attendees: [...guests] })],
        miniEvents: [event({ event_id: "e1", attendees: [...guests] })],
      },
      state: {
        search: "dentist",
        searchResults: [event({ event_id: "e1", attendees: [...guests] })],
      },
      ...over,
    });
  }

  it("moves the owner's own row in every loaded view at once", async () => {
    const app = loaded();
    await app.logic.respondRsvp("e1", "p-me", "accepted");
    for (const list of [
      app.data.events,
      app.data.miniEvents,
      app.state.searchResults ?? [],
    ]) {
      expect(list[0]?.attendees?.[0]?.partstat).toBe("accepted");
      expect(list[0]?.attendees?.[1]?.partstat).toBe("accepted");
    }
  });

  it("has already painted the answer by the time the write goes out", async () => {
    let paintedAtWrite: string | undefined;
    const app: Harness = loaded({
      write: async () => {
        paintedAtWrite = app.data.events[0]?.attendees?.[0]?.partstat;
        return { status: "executed" };
      },
    });
    await app.logic.respondRsvp("e1", "p-me", "declined");
    expect(paintedAtWrite).toBe("declined");
    expect(app.paints.at(-1)?.partstats).toStrictEqual([
      ["declined", "accepted"],
    ]);
  });

  it("sends the answer as a typed command and names it back on the receipt", async () => {
    const app = loaded();
    await app.logic.respondRsvp("e1", "p-me", "tentative");
    expect(app.sent).toStrictEqual([
      {
        action: "rsvp",
        input: { event_id: "e1", party_id: "p-me", partstat: "tentative" },
      },
    ]);
    expect(app.status()).toStrictEqual({
      text: RSVP_OUTCOME.tentative,
      action: null,
    });
  });

  it("leaves a resting search alone rather than inventing a result set", async () => {
    const app = harness({
      data: { events: [event({ event_id: "e1", attendees: [...guests] })] },
    });
    await app.logic.respondRsvp("e1", "p-me", "accepted");
    expect(app.state.searchResults).toBeNull();
  });

  it("narrates a held RSVP instead of the receipt", async () => {
    const app = harness({ write: async () => ({ status: "parked" }) });
    await app.logic.respondRsvp("e1", "p-me", "accepted");
    expect(app.status()).toStrictEqual({ text: OUTCOME_PARKED, action: null });
  });
});

describe("cancelling parks, and a park is not a failure", () => {
  it("says the ask is with the owner and does not re-read", async () => {
    const app = harness({ write: async () => ({ status: "parked" }) });
    await app.logic.cancelEvent("e1");
    expect(app.status()).toStrictEqual({ text: OUTCOME_PARKED, action: null });
    expect(app.reloads()).toBe(0);
    expect(app.paints).toHaveLength(1);
    expect(app.banner()).toStrictEqual({ text: "", hidden: true });
  });

  it("re-reads once the vault actually applied it", async () => {
    const app = harness({ write: async () => ({ status: "executed" }) });
    await app.logic.cancelEvent("e1");
    expect(app.reloads()).toBe(1);
  });

  it("re-reads a denial too — the window it drew is no longer trustworthy", async () => {
    const app = harness({
      write: async () => ({ status: "denied", reason: "no grant" }),
    });
    await app.logic.cancelEvent("e1");
    expect(app.reloads()).toBe(1);
    expect(app.banner().text).toBe("Denied by consent: no grant");
  });

  it("only repaints a refusal, and puts the reason in the notice", async () => {
    const app = harness({
      write: async () => ({ status: "failed", predicate: "owner_only: x" }),
    });
    await app.logic.cancelEvent("e1");
    expect(app.reloads()).toBe(0);
    expect(app.paints).toHaveLength(1);
    expect(app.banner().text).toBe("The vault refused: owner_only: x.");
  });

  it("reports an unreachable gateway without touching the status line", async () => {
    const app = harness({
      write: async () => {
        throw new Error("offline");
      },
    });
    await app.logic.cancelEvent("e1");
    expect(app.statusTexts).toStrictEqual([]);
    expect(app.banner().text).toBe("offline");
  });
});

describe("attachments", () => {
  it("remembers which event the file picker was opened for", () => {
    const app = harness();
    expect(app.logic.getAttachTarget()).toBeNull();
    app.logic.setAttachTarget("e1");
    expect(app.logic.getAttachTarget()).toBe("e1");
  });

  it("detaches by attachment id and says so once", async () => {
    const app = harness();
    await app.logic.removeAttachment("a1");
    expect(app.sent).toStrictEqual([
      { action: "detach", input: { attachment_id: "a1" } },
    ]);
    expect(app.status()).toStrictEqual({
      text: OUTCOME_DETACHED,
      action: null,
    });
  });

  it("narrates a held detach rather than claiming the file is gone", async () => {
    const app = harness({ write: async () => ({ status: "in-flight" }) });
    await app.logic.removeAttachment("a1");
    expect(app.status()).toStrictEqual({ text: OUTCOME_QUEUED, action: null });
  });
});
