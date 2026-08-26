// @vitest-environment jsdom
// LOCKER'S HONEST STATES (STATES.md's Locker matrix, umbrella #872).
//
// Locker owes the seven canonical states plus five of its own — Locked,
// Re-auth, Revealed, Window end and the viewer refusal. This file proves them
// where a member meets them, and it drives the PRODUCTION `Root` for the ones
// that are a claim about the whole room (locked, denied, day one), because
// those are exactly the ones an app can get right in a component and wrong in
// the tree above it.
//
// THE STATE THIS FILE EXISTS FOR is the first block: a Locker that boots
// browsable is not a Locker. Everything else here is downstream of that.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test } from "vitest";

import type { InlineFrame } from "../inline-types.ts";
import { Root } from "./app-root.tsx";
import { SealedField } from "./components/Fields.tsx";
import { LockerList } from "./components/List.tsx";
import { Notices } from "./components/States.tsx";
import { OPEN_ITEM, windowEndCopy } from "./format.ts";
import { PERMIT_LIFE_MS } from "./permits.ts";
import type { LockerRow } from "./types.ts";
import {
  DAY_ONE_ADD,
  FIELD_LABEL,
  DAY_ONE_IMPORT,
  DAY_ONE_TITLE,
  LOCK_BODY,
  NO_MATCH,
  OFFLINE_NOTICE,
  REAUTH_NOTICE,
  SEALED_NOTE,
  SETUP_BODY,
  SHOW_MORE,
  VIEWER_REFUSED,
  WINDOW_RULE,
  pendingNotice,
  permitGateTitle,
  revealedNote,
  staleNotice,
} from "./view-copy.ts";

const NO_FRAME: InlineFrame = {
  setAppBar: () => undefined,
  setStatus: () => undefined,
  clearStatus: () => undefined,
  claimBand: () => undefined,
};

const ROW: LockerRow = {
  item_id: "l1",
  type: "login",
  title: "GitHub",
  subtitle: "ana@example.test",
  tags: ["work"],
};

const NOOP = (): void => undefined;

// ------------------------------------------------- locked, first run, denied

describe("the room is shut until it is opened", () => {
  let reactRoot: ReturnType<typeof createRoot> | undefined;

  afterEach(() => {
    if (reactRoot) act(() => reactRoot?.unmount());
    reactRoot = undefined;
    document.body.replaceChildren();
    (window as unknown as { centraid?: unknown }).centraid = undefined;
  });

  async function mount(auth: Record<string, unknown>): Promise<HTMLElement> {
    (window as unknown as { centraid: unknown }).centraid = {
      read: ({ query }: { query: string }) =>
        query === "auth"
          ? Promise.resolve(auth)
          : Promise.resolve({ items: [ROW] }),
      write: () => Promise.resolve({}),
    };
    const container = document.createElement("div");
    document.body.append(container);
    reactRoot = createRoot(container);
    await act(async () => {
      reactRoot?.render(
        createElement(Root, { rootRef: NOOP, frame: NO_FRAME })
      );
    });
    return container;
  }

  test("LOCKED: a configured vault opens on the lock screen, with no list", async () => {
    const container = await mount({
      ok: true,
      configured: true,
      authenticated: false,
    });
    expect(container.textContent).toContain(LOCK_BODY);
    // The band, the rail and every list are WITHDRAWN, not dimmed.
    expect(container.querySelector("nav")).toBeNull();
    expect(container.querySelector("[data-item-id]")).toBeNull();
    expect(container.textContent).not.toContain(ROW.title);
  });

  test("FIRST RUN: an unconfigured vault states the rule before the field", async () => {
    const container = await mount({ ok: true, configured: false });
    expect(container.textContent).toContain(SETUP_BODY);
    expect(container.querySelector("[data-item-id]")).toBeNull();
    // Twelve characters is enforced in front of the member, not by a refusal.
    const commit = container.querySelector("button[type='submit']");
    expect((commit as HTMLButtonElement | null)?.disabled).toBe(true);
  });

  test("a host that never answers stays shut rather than guessing", async () => {
    const container = await mount({});
    expect(container.querySelector("[data-item-id]")).toBeNull();
  });

  test("DENIED: a revoked grant shows the receipt and that nothing was deleted", async () => {
    (window as unknown as { centraid: unknown }).centraid = {
      read: ({ query }: { query: string }) =>
        query === "auth"
          ? Promise.resolve({
              ok: true,
              configured: true,
              authenticated: true,
              sessionToken: "s1",
            })
          : Promise.resolve({
              items: [],
              vaultDenied: { message: "The grant was revoked." },
            }),
      write: () => Promise.resolve({}),
    };
    const container = document.createElement("div");
    document.body.append(container);
    reactRoot = createRoot(container);
    await act(async () => {
      reactRoot?.render(
        createElement(Root, { rootRef: NOOP, frame: NO_FRAME })
      );
    });
    expect(container.querySelector("#consentBanner")).not.toBeNull();
    expect(container.textContent).toContain("nothing was deleted");
    expect(container.textContent).toContain("The grant was revoked.");
    // Denied is not day one: it offers the grant back, not a first move.
    expect(container.textContent).not.toContain(DAY_ONE_TITLE);
    expect(container.textContent).toContain("Review vault access");
  });
});

// --------------------------------------------------------- day one and lens

describe("day one and an empty lens are different facts", () => {
  const list = (props: Partial<Parameters<typeof LockerList>[0]>) =>
    renderToStaticMarkup(
      createElement(LockerList, {
        rows: [],
        windowCount: 0,
        loaded: true,
        truncated: false,
        onOpen: NOOP,
        onCopyUsername: NOOP,
        onShowMore: NOOP,
        onImport: NOOP,
        onAdd: NOOP,
        ...props,
      })
    );

  test("DAY ONE: an empty vault offers the two ways in", () => {
    const markup = list({});
    expect(markup).toContain(DAY_ONE_TITLE);
    expect(markup).toContain(DAY_ONE_IMPORT);
    expect(markup).toContain(DAY_ONE_ADD);
  });

  test("an empty LENS says only that, and offers no first move", () => {
    const markup = list({ windowCount: 12 });
    expect(markup).toContain(NO_MATCH);
    expect(markup).not.toContain(DAY_ONE_TITLE);
  });

  test("NOTHING IS EMPTY UNTIL A READ HAS LANDED", () => {
    const markup = list({ loaded: false });
    expect(markup).not.toContain(DAY_ONE_TITLE);
    expect(markup).not.toContain(NO_MATCH);
  });
});

// ------------------------------------------------------------- window's end

describe("WINDOW END: a bounded window says so", () => {
  test("names what is shown, that more exist, and offers the way on", () => {
    const markup = renderToStaticMarkup(
      createElement(LockerList, {
        rows: [ROW],
        windowCount: 300,
        loaded: true,
        truncated: true,
        onOpen: NOOP,
        onCopyUsername: NOOP,
        onShowMore: NOOP,
        onImport: NOOP,
        onAdd: NOOP,
      })
    );
    expect(markup).toContain(WINDOW_RULE);
    expect(markup).toContain(SHOW_MORE);
    expect(windowEndCopy(300, true)).toContain("older items beyond them");
  });

  test("an untruncated window states the count and offers no more", () => {
    const markup = renderToStaticMarkup(
      createElement(LockerList, {
        rows: [ROW],
        windowCount: 1,
        loaded: true,
        truncated: false,
        onOpen: NOOP,
        onCopyUsername: NOOP,
        onShowMore: NOOP,
        onImport: NOOP,
        onAdd: NOOP,
      })
    );
    expect(markup).toContain(WINDOW_RULE);
    expect(markup).not.toContain(SHOW_MORE);
  });
});

// ------------------------------------------ pending, offline, stale, parked

describe("the notices name the boundary rather than apologise for it", () => {
  const notices = (props: Partial<Parameters<typeof Notices>[0]>) =>
    renderToStaticMarkup(
      createElement(Notices, {
        onDeviceWrites: 0,
        offline: false,
        onWhyOffline: NOOP,
        staleAt: null,
        onRefresh: NOOP,
        conflict: false,
        onCompare: NOOP,
        parked: false,
        onReviewParked: NOOP,
        reauth: false,
        ...props,
      })
    );

  test("PENDING says the writes are metadata, and that no secret is queued", () => {
    const markup = notices({ onDeviceWrites: 2 });
    expect(markup).toContain(pendingNotice(2));
    expect(markup).toContain("no secret is ever queued");
  });

  test("OFFLINE names what still works before what does not", () => {
    expect(notices({ offline: true })).toContain(OFFLINE_NOTICE);
  });

  test("STALE states the time it last matched, with the way to close it", () => {
    const markup = notices({ staleAt: "08:02" });
    expect(markup).toContain(staleNotice("08:02"));
    expect(markup).toContain("Refresh");
  });

  test("PARKED says a purge waits for the owner rather than having happened", () => {
    expect(notices({ parked: true })).toContain("waits for you");
  });

  test("CONFLICT offers the comparison rather than picking a winner", () => {
    expect(notices({ conflict: true })).toContain("Compare");
  });

  test("RE-AUTH says the permit expired and that nothing is revealed", () => {
    expect(notices({ reauth: true })).toContain(REAUTH_NOTICE);
  });

  test("nothing wrong, nothing said — an empty banner is chrome", () => {
    expect(notices({})).toBe("");
  });
});

// -------------------------------------------------------- sealed / revealed

describe("SEALED and REVEALED are two states of one row", () => {
  const field = (props: Partial<Parameters<typeof SealedField>[0]>) =>
    renderToStaticMarkup(
      createElement(SealedField, {
        label: "Password",
        field: "password",
        revealed: null,
        revealedAt: null,
        now: 1_000_000,
        onReveal: NOOP,
        onCopy: NOOP,
        onConceal: NOOP,
        ...props,
      })
    );

  test("SEALED shows a dot run, states the cost, and offers Reveal and Copy", () => {
    const markup = field({});
    expect(markup).toContain(SEALED_NOTE);
    expect(markup).toContain("Reveal");
    expect(markup).toContain("Copy");
    expect(markup).not.toContain("Conceal");
    // The run's length never tracks the secret's.
    expect(markup).toContain("••••••••••••••");
  });

  test("REVEALED states the remaining time and that the receipt is written", () => {
    const at = 1_000_000;
    const markup = field({
      revealed: "k7Q-vn2-Rme",
      revealedAt: at,
      now: at + 4_000,
    });
    expect(markup).toContain(revealedNote(4, 26));
    expect(markup).toContain("the receipt is already written");
    expect(markup).toContain("k7Q-vn2-Rme");
    expect(markup).toContain("Conceal");
    // …and the Reveal VERB is gone — matched as a control, because the note
    // above it legitimately contains the word "Revealed".
    expect(markup).not.toContain(">Reveal<");
  });

  test("the countdown floors at the permit's life, never runs negative", () => {
    const at = 1_000_000;
    const markup = field({
      revealed: "x",
      revealedAt: at,
      now: at + PERMIT_LIFE_MS + 9_000,
    });
    expect(markup).toContain(revealedNote(39, 0));
  });
});

// ------------------------------------------------------ the gate's question

describe("the permit gate names what it is buying", () => {
  test("a sealed field, by its own word", () => {
    expect(permitGateTitle(FIELD_LABEL.password ?? "")).toBe(
      "Reveal the password?"
    );
    expect(permitGateTitle(FIELD_LABEL.card_number ?? "")).toBe(
      "Reveal the card number?"
    );
  });

  test("and the READ, where the type seals nothing to reveal", () => {
    expect(permitGateTitle(FIELD_LABEL[OPEN_ITEM] ?? "")).toBe(
      "Open this item?"
    );
  });
});

// -------------------------------------------------------------- the refusal

describe("VIEWER REFUSED is a ruling, and it is stated", () => {
  test("Locker owns the sentence, whoever draws the wall", () => {
    expect(VIEWER_REFUSED).toContain("user-presence boundary");
    expect(VIEWER_REFUSED).toContain("refuses the seat outright");
  });
});
