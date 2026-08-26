// The conversation ledger's behaviours (#707). The ledger is
// app content owned by the assistant route, so its coverage lives here beside
// the component rather than with the shell's navigation column.
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import AssistantConversations from "./AssistantConversations.js";
import type {
  AssistantConversationEntry,
  AssistantConversationsProps,
} from "./AssistantConversations.js";

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(el: React.ReactElement): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
}

/** `n` plain conversations, newest first, titled "Thread 1"… */
function threads(n: number): AssistantConversationEntry[] {
  return Array.from({ length: n }, (_unused, index) => ({
    id: `c${index + 1}`,
    title: `Thread ${index + 1}`,
    timeLabel: `${index + 1}h`,
  }));
}

/** Every row's visible title, in DOM order. */
function titles(el: HTMLElement): string[] {
  return [...el.querySelectorAll(".rowTitle")].map(
    (node) => node.textContent ?? ""
  );
}

function control(el: HTMLElement, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll("button")].find((button) =>
    button.textContent?.includes(text)
  );
  if (!found) throw new Error(`no control matching "${text}"`);
  return found;
}

describe("AssistantConversations suite", () => {
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  describe(AssistantConversations, () => {
    it("says the ledger is empty rather than rendering an empty box", () => {
      const el = render(<AssistantConversations conversations={[]} />);
      expect(el.textContent).toContain("No chats yet");
      expect(el.querySelector(".rowTitle")).toBeNull();
    });

    it("offers the one filled ink control — New chat — and fires it", () => {
      const onNewChat =
        vi.fn<NonNullable<AssistantConversationsProps["onNewChat"]>>();
      const el = render(
        <AssistantConversations conversations={[]} onNewChat={onNewChat} />
      );
      act(() => control(el, "New chat").click());
      expect(onNewChat).toHaveBeenCalledWith();
      // Commit is fill-versus-outline, so there is exactly one of them.
      expect(el.querySelectorAll(".newChat")).toHaveLength(1);
    });

    it("hides New chat entirely when no handler is wired", () => {
      const el = render(<AssistantConversations conversations={[]} />);
      expect(el.querySelector(".newChat")).toBeNull();
    });

    it("groups pinned threads above the rest, each group named", () => {
      const el = render(
        <AssistantConversations
          conversations={[
            { id: "a", title: "Recent one", timeLabel: "1h" },
            { id: "b", title: "Kept one", timeLabel: "9h", pinned: true },
          ]}
        />
      );
      expect(titles(el)).toStrictEqual(["Kept one", "Recent one"]);
      const labels = [...el.querySelectorAll(".groupLabel")].map(
        (node) => node.textContent
      );
      expect(labels).toStrictEqual(["Pinned", "Recent"]);
    });

    it("names only the Pinned group when nothing else is left", () => {
      const el = render(
        <AssistantConversations
          conversations={[
            { id: "a", title: "Kept one", timeLabel: "1h", pinned: true },
          ]}
        />
      );
      expect(
        [...el.querySelectorAll(".groupLabel")].map((node) => node.textContent)
      ).toStrictEqual(["Pinned"]);
    });

    it("keeps archived threads behind a collapsed group that carries the count", () => {
      const el = render(
        <AssistantConversations
          conversations={[
            { id: "a", title: "Live one", timeLabel: "1h" },
            { id: "b", title: "Old one", timeLabel: "3d", archived: true },
            { id: "c", title: "Older one", timeLabel: "9d", archived: true },
          ]}
        />
      );
      const toggle = el.querySelector(".archivedToggle") as HTMLButtonElement;
      expect(toggle.textContent).toContain("Archived · 2");
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(titles(el)).toStrictEqual(["Live one"]);

      act(() => toggle.click());
      expect(titles(el)).toStrictEqual(["Live one", "Old one", "Older one"]);
      expect(
        el.querySelector(".archivedToggle")?.getAttribute("aria-expanded")
      ).toBe("true");

      act(() => (el.querySelector(".archivedToggle") as HTMLElement).click());
      expect(titles(el)).toStrictEqual(["Live one"]);
    });

    it("says nothing about archives when there are none", () => {
      const el = render(<AssistantConversations conversations={threads(2)} />);
      expect(el.querySelector(".archivedToggle")).toBeNull();
      expect(el.textContent).not.toContain("Archived");
    });

    it("caps the list, then expands and collapses in place", () => {
      const el = render(<AssistantConversations conversations={threads(18)} />);
      expect(titles(el)).toHaveLength(15);

      const seeAll = control(el, "See all");
      // The count is the whole ACTIVE list, not the hidden remainder.
      expect(seeAll.textContent).toBe("See all · 18");
      act(() => seeAll.click());
      expect(titles(el)).toHaveLength(18);

      const showLess = control(el, "Show less");
      act(() => showLess.click());
      expect(titles(el)).toHaveLength(15);
      expect(el.textContent).toContain("See all · 18");
    });

    it("counts pinned rows against the same cap", () => {
      const pinnedAndRest = threads(18).map((entry, index) =>
        index < 3 ? { ...entry, pinned: true } : entry
      );
      const el = render(
        <AssistantConversations conversations={pinnedAndRest} />
      );
      const shown = titles(el);
      expect(shown).toHaveLength(15);
      expect(shown.slice(0, 3)).toStrictEqual([
        "Thread 1",
        "Thread 2",
        "Thread 3",
      ]);
    });

    it("offers no expansion control at or under the cap", () => {
      const el = render(<AssistantConversations conversations={threads(15)} />);
      expect(el.querySelector(".more")).toBeNull();
    });

    it("keeps archived rows out of the cap arithmetic", () => {
      const el = render(
        <AssistantConversations
          conversations={[
            ...threads(15),
            { id: "z", title: "Filed", timeLabel: "1y", archived: true },
          ]}
        />
      );
      expect(el.querySelector(".more")).toBeNull();
    });

    it("selects a row and marks the open one", () => {
      const onSelect =
        vi.fn<NonNullable<AssistantConversationsProps["onSelect"]>>();
      const el = render(
        <AssistantConversations
          conversations={threads(2)}
          activeConversationId="c2"
          onSelect={onSelect}
        />
      );
      const open = el.querySelector('.row[data-active="true"]');
      expect(open?.textContent).toContain("Thread 2");
      act(() => (el.querySelector(".row") as HTMLButtonElement).click());
      expect(onSelect).toHaveBeenCalledWith("c1");
    });

    it("labels a row with its vault only when one is recorded (#599)", () => {
      const el = render(
        <AssistantConversations
          conversations={[
            {
              id: "a",
              title: "Groceries",
              timeLabel: "2m",
              scopeLabel: "Family",
            },
            { id: "b", title: "Taxes", timeLabel: "5m" },
          ]}
        />
      );
      const metas = [...el.querySelectorAll(".rowMeta")].map(
        (node) => node.textContent
      );
      expect(metas).toStrictEqual(["Family · 2m", "5m"]);
    });

    it("opens the row menu from the ••• control, anchored to its rect", () => {
      const onMenu =
        vi.fn<NonNullable<AssistantConversationsProps["onMenu"]>>();
      const el = render(
        <AssistantConversations conversations={threads(1)} onMenu={onMenu} />
      );
      const more = el.querySelector(
        '[aria-label="Conversation actions"]'
      ) as HTMLButtonElement;
      act(() => more.click());
      expect(onMenu).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({ kind: "rect" })
      );
    });

    it("opens the same menu on right-click, anchored to the pointer", () => {
      const onMenu =
        vi.fn<NonNullable<AssistantConversationsProps["onMenu"]>>();
      const el = render(
        <AssistantConversations conversations={threads(1)} onMenu={onMenu} />
      );
      const shell = el.querySelector(".rowShell") as HTMLElement;
      act(() => {
        shell.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 42,
            clientY: 24,
          })
        );
      });
      expect(onMenu).toHaveBeenCalledWith("c1", {
        kind: "point",
        x: 42,
        y: 24,
      });
    });

    it("falls back to a bare delete control when only onDelete is wired", () => {
      const onDelete =
        vi.fn<NonNullable<AssistantConversationsProps["onDelete"]>>();
      const el = render(
        <AssistantConversations
          conversations={threads(1)}
          onDelete={onDelete}
        />
      );
      expect(
        el.querySelector('[aria-label="Conversation actions"]')
      ).toBeNull();
      const remove = el.querySelector(
        '[aria-label="Delete conversation"]'
      ) as HTMLButtonElement;
      act(() => remove.click());
      expect(onDelete).toHaveBeenCalledWith("c1");
    });

    it("lets the ••• menu supersede the bare delete control", () => {
      const onDelete =
        vi.fn<NonNullable<AssistantConversationsProps["onDelete"]>>();
      const onMenu =
        vi.fn<NonNullable<AssistantConversationsProps["onMenu"]>>();
      const el = render(
        <AssistantConversations
          conversations={threads(1)}
          onDelete={onDelete}
          onMenu={onMenu}
        />
      );
      expect(el.querySelector('[aria-label="Delete conversation"]')).toBeNull();
      expect(el.querySelectorAll(".rowAction")).toHaveLength(1);
    });

    it("renders a row with no handlers at all rather than throwing", () => {
      const el = render(<AssistantConversations conversations={threads(1)} />);
      expect(el.querySelector(".rowAction")).toBeNull();
      act(() => (el.querySelector(".row") as HTMLButtonElement).click());
      expect(titles(el)).toStrictEqual(["Thread 1"]);
    });
  });
});
