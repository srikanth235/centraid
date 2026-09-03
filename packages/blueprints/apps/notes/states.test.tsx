import { readFileSync } from "node:fs";
import path from "node:path";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, test } from "vitest";

import { decoratePendingMutation } from "../_shared/pending-overlay.ts";
import type { InlineFrame } from "../inline-types.ts";
import { Root } from "./app-root.tsx";
import { NoteCard, NoteRow } from "./components/Library.tsx";
import { Conflict } from "./components/States.tsx";
import type { Note } from "./types.ts";
import {
  CONFLICT_INTACT,
  CONFLICT_KEPT,
  CONFLICT_TITLE,
  STALE_VERB,
  staleReplica,
} from "./view-copy.ts";

const SOURCE = readFileSync(
  path.resolve(import.meta.dirname, "app-root.tsx"),
  "utf8"
);

describe("conflict: both bodies kept, and nothing to choose", () => {
  test("the panel reports the fact and offers only the history", () => {
    const markup = renderToStaticMarkup(
      createElement(Conflict, { onOpenHistory: () => undefined })
    );
    const host = document.createElement("div");
    host.innerHTML = markup;

    const panel = host.querySelector(`section[aria-label="${CONFLICT_TITLE}"]`);
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain(CONFLICT_KEPT);
    expect(panel?.textContent).toContain(CONFLICT_INTACT);

    const buttons = [...host.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toStrictEqual([
      "Version history",
    ]);
    expect(host.querySelector(".kit-btn.primary")).toBeNull();
  });

  test("the orchestrator opens it on the note, off the version chain", () => {
    expect(SOURCE).toMatch(
      /shelf === NOTE && hasConcurrentVersions\(state\.versions \?\? \[\]\)/u
    );
    expect(SOURCE).toMatch(
      /<Conflict onOpenHistory=\{\(\) => go\(HISTORY\)\}/u
    );
  });
});

describe("parked: the owner's approval, said in both library shapes", () => {
  const PARKED = decoratePendingMutation(
    {
      op: "upsert" as const,
      entity: "knowledge.note",
      rowId: "note-parked",
      values: {
        note_id: "note-parked",
        title: "Lease terms",
        preview: "The deposit clause moved to §4.",
        updated_at: new Date().toISOString(),
      },
    },
    {
      intentId: "notes-edit-lease-terms",
      state: "parked",
      action: "edit-note",
      reason: "Waiting for the owner to approve this change.",
    }
  ).values as unknown as Note;

  const REASON = "Waiting for the owner to approve this change.";

  afterEach(() => {
    (window as unknown as { centraid?: unknown }).centraid = undefined;
  });

  test.each([
    ["card", NoteCard],
    ["row", NoteRow],
  ] as const)(
    "the %s carries the chip, the sentence and the way in",
    async (_label, Shape) => {
      const opened: string[] = [];
      (window as unknown as { centraid: unknown }).centraid = {
        openApprovals: () => opened.push("approvals"),
      };
      const container = document.createElement("div");
      document.body.append(container);
      const reactRoot = createRoot(container);
      await act(async () => {
        reactRoot.render(
          createElement(Shape, {
            note: PARKED,
            onOpen: () => undefined,
            onTogglePin: () => undefined,
          })
        );
      });

      expect(container.querySelector(".kit-pending-chip")?.textContent).toBe(
        "parked"
      );
      expect(container.textContent).toContain(REASON);

      const review = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Review in Approvals"
      );
      expect(review).toBeDefined();
      await act(async () => review?.click());
      expect(opened).toStrictEqual(["approvals"]);

      act(() => reactRoot.unmount());
      container.remove();
    }
  );

  test("a note with no held write draws no chip at all", () => {
    const markup = renderToStaticMarkup(
      createElement(NoteCard, {
        note: {
          note_id: "note-settled",
          title: "Lease terms",
          preview: "The deposit clause moved to §4.",
          updated_at: new Date().toISOString(),
        } satisfies Note,
        onOpen: () => undefined,
        onTogglePin: () => undefined,
      })
    );
    expect(markup).not.toContain("kit-pending-chip");
  });
});

describe("offline is READ from the host, and it speaks as the stale notice", () => {
  const NOTES: readonly Note[] = [
    {
      note_id: "note-lease",
      title: "Lease terms",
      preview: "The deposit clause moved to §4.",
      updated_at: new Date().toISOString(),
    },
  ];

  const NO_FRAME: InlineFrame = {
    setAppBar: () => undefined,
    setStatus: () => undefined,
    clearStatus: () => undefined,
    claimBand: () => undefined,
  };

  let reactRoot: ReturnType<typeof createRoot> | undefined;
  let hostEl: HTMLElement | null = null;

  beforeAll(() => {
    for (const method of ["showModal", "close"] as const)
      Object.defineProperty(HTMLDialogElement.prototype, method, {
        configurable: true,
        value: () => undefined,
      });
  });

  afterEach(() => {
    if (reactRoot) act(() => reactRoot?.unmount());
    reactRoot = undefined;
    hostEl = null;
    document.body.replaceChildren();
    (window as unknown as { centraid?: unknown }).centraid = undefined;
  });

  async function mount(): Promise<HTMLDivElement> {
    (window as unknown as { centraid: unknown }).centraid = {
      read: ({ query }: { query: string }) =>
        query === "library"
          ? Promise.resolve({
              notes: NOTES,
              trash: [],
              notebooks: [],
              tags: [],
              truncated: false,
              window: 200,
            })
          : Promise.resolve({}),
    };
    const container = document.createElement("div");
    document.body.append(container);
    reactRoot = createRoot(container);
    await act(async () => {
      reactRoot?.render(
        createElement(Root, {
          rootRef: (el: HTMLElement | null) => {
            hostEl = el;
          },
          frame: NO_FRAME,
        })
      );
    });
    return container;
  }

  function staleSentence(container: HTMLElement): string | undefined {
    const clock = /(?<at>\d{2}:\d{2})/u;
    return [...container.querySelectorAll("span")]
      .map((span) => span.textContent ?? "")
      .find((text) => {
        const at = clock.exec(text)?.groups?.at;
        return at !== undefined && text === staleReplica(at);
      });
  }

  test("a host that says the gateway is down raises the stale notice", async () => {
    const container = await mount();
    expect(staleSentence(container)).toBeUndefined();

    hostEl!.dataset.gatewayStatus = "down";
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(staleSentence(container)).toBeTypeOf("string");
    const refresh = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === STALE_VERB
    );
    expect(refresh).toBeDefined();
  });

  test("a host that says the gateway is up withholds it", async () => {
    const container = await mount();
    hostEl!.dataset.gatewayStatus = "up";
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(staleSentence(container)).toBeUndefined();
  });

  test("the verdict is the reachability kit's, never an invented one", () => {
    expect(SOURCE).toContain("libraryReachability({");
    expect(SOURCE).toContain("rootElRef.current?.dataset.gatewayStatus");
    expect(SOURCE).toMatch(/readFailed: readFailedState/u);
    expect(SOURCE).not.toContain("navigator.onLine");
    expect(SOURCE).toMatch(/\{offline && loaded \? \(\s*<Stale/u);
  });
});
// @vitest-environment jsdom
