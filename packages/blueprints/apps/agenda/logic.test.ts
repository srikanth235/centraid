import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { Mock } from "vitest";

// Agenda's vault IO (#839 W2-1).
//
// THREE OUTCOMES, THREE DIFFERENT SENTENCES, none of them an error — that is
// the rule this file exists to hold. `executed` earns the receipt on the
// frame's one status line, `parked` earns the owner-confirmation sentence (a
// cancel PARKS by design, so this is the ordinary path and not the exception),
// and a write still sitting on this device earns the queued sentence. Only a
// genuine refusal reaches the in-pane notice banner.
//
// The RSVP projection and the search sequence are the two places the app
// paints before the vault has spoken, so both are asserted for what they do
// when the answer never comes or comes late.
//
// NODE, NOT JSDOM, and deliberately so: this file is a mutation seed
// (`stryker.agenda.config.mjs`), and Stryker's vitest runner reports "No tests
// were executed" for a jsdom project — a suite under the `@vitest-environment
// jsdom` docblock defends nothing in the mutation lane. The browser surface
// this module touches is one `querySelector` plus `textContent`/`hidden`, and
// `window.centraid`; both are stood up by hand below, so anything the module
// reaches for beyond them fails here rather than silently working.
import { useFakeClock } from "@centraid/test-kit/fake-clock";

import type { InlineFrame } from "../inline-types.ts";
import { createLogic } from "./logic.ts";
import type { AgEvent, AppData, AppState, Attendee } from "./types.ts";
import {
  OUTCOME_DETACHED,
  OUTCOME_OCCURRENCE,
  OUTCOME_PARKED,
  OUTCOME_PROPOSED,
  OUTCOME_QUEUED,
  OUTCOME_UPDATED,
  RSVP_OUTCOME,
} from "./view-copy.ts";

function event(patch: Partial<AgEvent> & { event_id: string }): AgEvent {
  return { dtstart: "2026-08-21T09:00:00Z", ...patch };
}

function state(patch: Partial<AppState> = {}): AppState {
  return {
    view: "week",
    anchorDay: new Date("2026-08-21T00:00:00Z"),
    search: "",
    searchResults: null,
    hiddenCals: new Set<string>(),
    selectedId: null,
    quick: null,
    editorId: null,
    createOpen: false,
    narrow: false,
    ...patch,
  };
}

function data(patch: Partial<AppData> = {}): AppData {
  return {
    events: [],
    miniEvents: [],
    calendars: [],
    calById: new Map(),
    parties: [],
    me: "p-me",
    ...patch,
  };
}

type WriteOpts = { action: string; input?: Record<string, unknown> };
type ReadOpts = { query: string; input?: Record<string, unknown> };

/** The one element this app writes to imperatively. */
interface BannerStub {
  textContent: string;
  hidden: boolean;
}

let banner: BannerStub | null = null;

function mountBanner(present = true): void {
  banner = present ? { textContent: "", hidden: true } : null;
  (globalThis as { document?: unknown }).document = {
    querySelector: (selector: string) =>
      selector === "#noticeBanner" ? banner : null,
  };
}

type WriteFn = (opts: WriteOpts) => Promise<unknown>;
type ReadFn = (opts: ReadOpts) => Promise<unknown>;

interface Harness {
  state: AppState;
  data: AppData;
  logic: ReturnType<typeof createLogic>;
  frame: InlineFrame;
  setStatus: Mock<InlineFrame["setStatus"]>;
  clearStatus: Mock<InlineFrame["clearStatus"]>;
  write: Mock<WriteFn>;
  read: Mock<ReadFn>;
  render: Mock<() => void>;
  refresh: Mock<() => Promise<void>>;
  banner: () => { text: string; hidden: boolean };
}

function harness(
  over: {
    state?: Partial<AppState>;
    data?: Partial<AppData>;
    write?: WriteFn;
    read?: ReadFn;
    /** Withhold the frame's notice banner, as a served mount does. */
    banner?: boolean;
  } = {}
): Harness {
  const appState = state(over.state);
  const appData = data(over.data);
  const write = vi.fn<WriteFn>(
    over.write ?? (async () => ({ status: "executed" }) as VaultOutcome)
  );
  const read = vi.fn<ReadFn>(over.read ?? (async () => ({})));
  mountBanner(over.banner !== false);
  (globalThis as { window?: unknown }).window = { centraid: { read, write } };
  onTestFinished(() => {
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { document?: unknown }).document;
  });
  const setStatus = vi.fn<InlineFrame["setStatus"]>();
  const clearStatus = vi.fn<InlineFrame["clearStatus"]>();
  const frame: InlineFrame = {
    setAppBar: vi.fn<InlineFrame["setAppBar"]>(),
    setStatus,
    clearStatus,
    claimBand: vi.fn<InlineFrame["claimBand"]>(),
  };
  const render = vi.fn<() => void>();
  const refresh = vi.fn<() => Promise<void>>(async () => {});
  return {
    state: appState,
    data: appData,
    logic: createLogic({
      state: appState,
      data: appData,
      frame,
      render,
      refresh,
    }),
    frame,
    setStatus,
    clearStatus,
    write,
    read,
    render,
    refresh,
    banner: () => ({
      text: banner?.textContent ?? "",
      hidden: banner?.hidden ?? true,
    }),
  };
}

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
    expect(answered.refresh).toHaveBeenCalledOnce();
    expect(answered.render).not.toHaveBeenCalled();

    const unreachable = harness({
      write: async () => {
        throw new Error("offline");
      },
    });
    await unreachable.logic.write("edit-event", { event_id: "e1" });
    expect(unreachable.refresh).not.toHaveBeenCalled();
    expect(unreachable.render).toHaveBeenCalledOnce();
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
    expect(app.setStatus).toHaveBeenCalledWith(OUTCOME_PROPOSED, {
      action: { label: "Undo", run: expect.any(Function) },
    });
    const run = app.setStatus.mock.calls[0]?.[1]?.action?.run as () => void;
    run();
    await Promise.resolve();
    expect(app.write.mock.calls.at(-1)?.[0]).toStrictEqual({
      action: "cancel-event",
      input: { event_id: "e-new" },
    });
  });

  it("offers no undo when the vault named no event", async () => {
    const app = harness({
      write: async () => ({ status: "executed", output: {} }),
    });
    await app.logic.proposeEvent({ summary: "Dentist" } as never);
    expect(app.setStatus).toHaveBeenCalledWith(OUTCOME_PROPOSED, {});
  });

  it("says the ask is with the owner when the vault parked it", async () => {
    const app = harness({ write: async () => ({ status: "parked" }) });
    await app.logic.proposeEvent({ summary: "Dentist" } as never);
    expect(app.setStatus).toHaveBeenCalledWith(OUTCOME_PARKED, {});
  });

  // Spelled out rather than looped: each case installs its own
  // `window.centraid`, so the three writes have to be driven one after the
  // other against the global they each just claimed.
  it("says the write is on this device when it is still held here", async () => {
    const queued = harness({ write: async () => ({ status: "queued" }) });
    await queued.logic.proposeEvent({ summary: "Dentist" } as never);
    expect(queued.setStatus).toHaveBeenCalledWith(OUTCOME_QUEUED, {});

    const inFlight = harness({ write: async () => ({ status: "in-flight" }) });
    await inFlight.logic.proposeEvent({ summary: "Dentist" } as never);
    expect(inFlight.setStatus).toHaveBeenCalledWith(OUTCOME_QUEUED, {});

    const sending = harness({ write: async () => ({ status: "sending" }) });
    await sending.logic.proposeEvent({ summary: "Dentist" } as never);
    expect(sending.setStatus).toHaveBeenCalledWith(OUTCOME_QUEUED, {});
  });

  it("says nothing on the status line for an outright refusal", async () => {
    const app = harness({ write: async () => ({ status: "failed" }) });
    await app.logic.proposeEvent({ summary: "Dentist" } as never);
    expect(app.setStatus).not.toHaveBeenCalled();
    expect(app.banner().hidden).toBe(false);
  });
});

describe("editing", () => {
  it("distinguishes the series receipt from the one-occurrence receipt", async () => {
    const series = harness();
    await series.logic.editEvent({ event_id: "e1", summary: "New" });
    expect(series.write.mock.calls[0]?.[0]).toStrictEqual({
      action: "edit-event",
      input: { event_id: "e1", summary: "New" },
    });
    expect(series.setStatus).toHaveBeenCalledWith(OUTCOME_UPDATED, {});

    const one = harness();
    await one.logic.editOccurrence({
      event_id: "e1",
      original_start: "2026-08-21T09:00:00Z",
    } as never);
    expect(one.write.mock.calls[0]?.[0].action).toBe("edit-occurrence");
    expect(one.setStatus).toHaveBeenCalledWith(OUTCOME_OCCURRENCE, {});
  });

  it("narrates a held edit rather than claiming a receipt", async () => {
    const app = harness({ write: async () => ({ status: "queued" }) });
    await app.logic.editEvent({ event_id: "e1" });
    expect(app.setStatus).toHaveBeenCalledWith(OUTCOME_QUEUED, {});
    expect(app.setStatus).not.toHaveBeenCalledWith(OUTCOME_UPDATED, {});
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

  // A member who presses Going and watches the row stay "No answer yet" for a
  // round trip has been told the press did nothing — so the projection has to
  // be on screen BEFORE the command leaves, not after it settles.
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
    expect(app.render).toHaveBeenCalledWith();
  });

  it("sends the answer as a typed command and names it back on the receipt", async () => {
    const app = loaded();
    await app.logic.respondRsvp("e1", "p-me", "tentative");
    expect(app.write.mock.calls[0]?.[0]).toStrictEqual({
      action: "rsvp",
      input: { event_id: "e1", party_id: "p-me", partstat: "tentative" },
    });
    expect(app.setStatus).toHaveBeenCalledWith(RSVP_OUTCOME.tentative, {});
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
    expect(app.setStatus).toHaveBeenCalledWith(OUTCOME_PARKED, {});
  });
});

describe("cancelling parks, and a park is not a failure", () => {
  it("says the ask is with the owner and does not re-read", async () => {
    const app = harness({ write: async () => ({ status: "parked" }) });
    await app.logic.cancelEvent("e1");
    expect(app.setStatus).toHaveBeenCalledWith(OUTCOME_PARKED, {});
    expect(app.refresh).not.toHaveBeenCalled();
    expect(app.render).toHaveBeenCalledOnce();
    expect(app.banner()).toStrictEqual({ text: "", hidden: true });
  });

  it("re-reads once the vault actually applied it", async () => {
    const app = harness({ write: async () => ({ status: "executed" }) });
    await app.logic.cancelEvent("e1");
    expect(app.refresh).toHaveBeenCalledOnce();
  });

  it("re-reads a denial too — the window it drew is no longer trustworthy", async () => {
    const app = harness({
      write: async () => ({ status: "denied", reason: "no grant" }),
    });
    await app.logic.cancelEvent("e1");
    expect(app.refresh).toHaveBeenCalledOnce();
    expect(app.banner().text).toBe("Denied by consent: no grant");
  });

  it("only repaints a refusal, and puts the reason in the notice", async () => {
    const app = harness({
      write: async () => ({ status: "failed", predicate: "owner_only: x" }),
    });
    await app.logic.cancelEvent("e1");
    expect(app.refresh).not.toHaveBeenCalled();
    expect(app.render).toHaveBeenCalledOnce();
    expect(app.banner().text).toBe("The vault refused: owner_only: x.");
  });

  it("reports an unreachable gateway without touching the status line", async () => {
    const app = harness({
      write: async () => {
        throw new Error("offline");
      },
    });
    await app.logic.cancelEvent("e1");
    expect(app.setStatus).not.toHaveBeenCalled();
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
    expect(app.write.mock.calls[0]?.[0]).toStrictEqual({
      action: "detach",
      input: { attachment_id: "a1" },
    });
    expect(app.setStatus).toHaveBeenCalledWith(OUTCOME_DETACHED, {});
  });

  it("narrates a held detach rather than claiming the file is gone", async () => {
    const app = harness({ write: async () => ({ status: "in-flight" }) });
    await app.logic.removeAttachment("a1");
    expect(app.setStatus).toHaveBeenCalledWith(OUTCOME_QUEUED, {});
  });
});

describe("search asks the vault, never the loaded window", () => {
  it("coalesces the typing into one read", async () => {
    const clock = useFakeClock();
    const app = harness({ read: async () => ({ events: [] }) });
    app.logic.applySearchInput("den");
    app.logic.applySearchInput("dentist");
    await clock.advance(200);
    expect(app.read).toHaveBeenCalledOnce();
    expect(app.read.mock.calls[0]?.[0]).toStrictEqual({
      query: "search",
      input: { term: "dentist" },
    });
  });

  it("keeps the member's own text, spaces and all", async () => {
    const clock = useFakeClock();
    const app = harness({ read: async () => ({ events: [] }) });
    app.logic.applySearchInput("  dentist ");
    await clock.advance(200);
    expect(app.state.search).toBe("  dentist ");
    expect(app.state.searchResults).toStrictEqual([]);
  });

  it("drops back to no search on a box holding only spaces", async () => {
    const clock = useFakeClock();
    const app = harness({
      state: { searchResults: [event({ event_id: "e1" })] },
    });
    app.logic.applySearchInput("   ");
    await clock.advance(200);
    expect(app.read).not.toHaveBeenCalled();
    expect(app.state.searchResults).toBeNull();
  });

  it("holds the matches the vault found", async () => {
    const clock = useFakeClock();
    const hit = event({ event_id: "e1" });
    const app = harness({ read: async () => ({ events: [hit] }) });
    app.logic.applySearchInput("dentist");
    await clock.advance(200);
    expect(app.state.searchResults).toStrictEqual([hit]);
  });

  it("reads a missing events key as an empty match set", async () => {
    const clock = useFakeClock();
    const app = harness({ read: async () => ({}) });
    app.logic.applySearchInput("dentist");
    await clock.advance(200);
    expect(app.state.searchResults).toStrictEqual([]);
  });

  it("says UNKNOWN — not 'nothing matches' — when the index was out of reach", async () => {
    const clock = useFakeClock();
    const app = harness({
      read: async () => {
        throw new Error("offline");
      },
    });
    app.logic.applySearchInput("dentist");
    await clock.advance(200);
    expect(app.state.searchResults).toBeNull();
  });

  it("drops an answer the member has already typed past", async () => {
    const clock = useFakeClock();
    const app: Harness = harness({
      read: async () => {
        // A second keystroke lands while this read is in flight.
        app.logic.clearSearch();
        return { events: [event({ event_id: "stale" })] };
      },
    });
    app.logic.applySearchInput("dentist");
    await clock.advance(200);
    expect(app.state.searchResults).toBeNull();
  });

  it("clears the box and bars a live read from landing", async () => {
    const clock = useFakeClock();
    const app = harness({
      state: { search: "dentist", searchResults: [event({ event_id: "e1" })] },
    });
    app.logic.clearSearch();
    expect(app.state.search).toBe("");
    expect(app.state.searchResults).toBeNull();
    await clock.advance(200);
    expect(app.read).not.toHaveBeenCalled();
  });
});
