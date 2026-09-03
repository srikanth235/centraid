import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PaletteConversationSearch } from "./paletteConversationSearch.js";
import { buildPaletteGroups, buildPaletteSuggestions } from "./paletteData.js";
import type { PaletteDeps } from "./paletteData.js";
import type { PaletteEntitySearch } from "./paletteEntitySearch.js";
import type { PaletteRecentHit, PaletteRecents } from "./paletteRecents.js";

vi.mock(import("../iconSvg.js"), () => ({
  iconSvg: (name: string) => `<svg data-icon="${name}"/>`,
}));

describe("paletteData", () => {
  beforeEach(() => {
    (globalThis as unknown as { CentraidTokens: unknown }).CentraidTokens = {
      tileFinish: () => ({
        background: "#111",
        boxShadow: "none",
        glyphColor: "#fff",
      }),
    };
  });

  function deps(over: Partial<PaletteDeps> = {}): PaletteDeps {
    return {
      userApps: [
        {
          id: "todos",
          name: "Todos",
          color: "blue",
          iconKey: "Todo",
          desc: "Tasks",
        },
      ],
      tileVariant: "gradient",
      navigate: vi.fn<PaletteDeps["navigate"]>(),
      onClose: vi.fn<PaletteDeps["onClose"]>(),
      ...over,
    } as PaletteDeps;
  }

  describe(buildPaletteGroups, () => {
    it("lists apps and nav targets when the query is empty", () => {
      const groups = buildPaletteGroups("", deps());
      expect(groups.map((g) => g.group)).toStrictEqual(["Apps", "Go to"]);
      expect(groups[0]!.items.map((r) => r.label)).toContain("Todos");
      expect(groups[1]!.items.map((r) => r.label)).toContain("Settings");
    });

    it("filters apps + nav by the query, and never offers a create row (#799)", () => {
      const groups = buildPaletteGroups("todo", deps());
      expect(
        groups.find((g) => g.group === "Apps")?.items.map((r) => r.label)
      ).toStrictEqual(["Todos"]);
      expect(groups.find((g) => g.group === "Go to")).toBeUndefined();
      expect(groups.find((g) => g.group === "Create")).toBeUndefined();
      expect(
        buildPaletteGroups("budget tracker", deps()).find(
          (g) => g.group === "Create"
        )
      ).toBeUndefined();
    });

    it("an app row navigates to the app and closes on run", () => {
      const navigate = vi.fn<PaletteDeps["navigate"]>();
      const onClose = vi.fn<PaletteDeps["onClose"]>();
      const groups = buildPaletteGroups("todos", deps({ navigate, onClose }));
      groups[0]!.items[0]!.run();
      expect(onClose).toHaveBeenCalledOnce();
      expect(navigate).toHaveBeenCalledWith({ kind: "app", id: "todos" });
    });

    it("adds a Conversations group from the search source and deep-links on run (#420)", () => {
      const navigate = vi.fn<PaletteDeps["navigate"]>();
      const onClose = vi.fn<PaletteDeps["onClose"]>();
      const ensure = vi.fn<PaletteConversationSearch["ensure"]>();
      const conversationSearch = {
        ensure,
        results: () => [
          { id: "c9", title: "Budget chat", snippet: "the ⟦budget⟧ plan" },
        ],
        reset: vi.fn<PaletteConversationSearch["reset"]>(),
        setOnResults: vi.fn<PaletteConversationSearch["setOnResults"]>(),
      };
      const groups = buildPaletteGroups(
        "budget",
        deps({ navigate, onClose, conversationSearch })
      );
      expect(ensure).toHaveBeenCalledWith("budget");
      const convo = groups.find((g) => g.group === "Conversations")!;
      expect(convo.items[0]!.label).toBe("Budget chat");
      expect(convo.items[0]!.sub).toBe("the budget plan");
      convo.items[0]!.run();
      expect(onClose).toHaveBeenCalledOnce();
      expect(navigate).toHaveBeenCalledWith({
        kind: "assistant",
        conversationId: "c9",
      });
    });

    it("omits the Conversations group with no query or no hits (#420)", () => {
      const empty = {
        ensure: vi.fn<PaletteConversationSearch["ensure"]>(),
        results: () => [],
        reset: vi.fn<PaletteConversationSearch["reset"]>(),
        setOnResults: vi.fn<PaletteConversationSearch["setOnResults"]>(),
      };
      expect(
        buildPaletteGroups("", deps({ conversationSearch: empty })).find(
          (g) => g.group === "Conversations"
        )
      ).toBeUndefined();
      expect(
        buildPaletteGroups("budget", deps({ conversationSearch: empty })).find(
          (g) => g.group === "Conversations"
        )
      ).toBeUndefined();
    });

    it("groups entity-aware vault hits by app — objects, not apps (#708 §A)", () => {
      const navigate = vi.fn<PaletteDeps["navigate"]>();
      const onClose = vi.fn<PaletteDeps["onClose"]>();
      const ensure = vi.fn<PaletteEntitySearch["ensure"]>();
      const entitySearch: PaletteEntitySearch = {
        ensure,
        results: () => [
          {
            appId: "notes",
            appLabel: "Notes",
            entity: "knowledge.note",
            kind: "note",
            id: "note-1",
            label: "Café plans",
            snippet: "旅行 ✨",
            meta: "",
          },
        ],
        reset: vi.fn<PaletteEntitySearch["reset"]>(),
        setOnResults: vi.fn<PaletteEntitySearch["setOnResults"]>(),
      };
      const groups = buildPaletteGroups(
        "notes: café",
        deps({ entitySearch, navigate, onClose })
      );
      expect(ensure).toHaveBeenCalledWith("notes: café");
      const notes = groups.find((group) => group.group === "Notes")!;
      expect(notes.icon).toMatchObject({ hue: "var(--c-slate)" });
      expect(notes.items[0]).toMatchObject({
        label: "Café plans",
        sub: "旅行 ✨",
        kind: "note",
      });
      expect(notes.items[0]!.meta).toBeUndefined();
      notes.items[0]!.run();
      expect(onClose).toHaveBeenCalledOnce();
      expect(navigate).toHaveBeenCalledWith({ kind: "app", id: "notes" });
    });

    it("gives the Conversations group an icon + a conversation kind on its rows", () => {
      const conversationSearch: PaletteConversationSearch = {
        ensure: vi.fn<PaletteConversationSearch["ensure"]>(),
        results: () => [{ id: "c9", title: "Budget chat", snippet: "" }],
        reset: vi.fn<PaletteConversationSearch["reset"]>(),
        setOnResults: vi.fn<PaletteConversationSearch["setOnResults"]>(),
      };
      const groups = buildPaletteGroups("budget", deps({ conversationSearch }));
      const convo = groups.find((g) => g.group === "Conversations")!;
      expect(convo.icon).toBeDefined();
      expect(convo.items[0]!.kind).toBe("conversation");
    });
  });

  describe("Recents + suggestions empty state (#708 §A point 4)", () => {
    function recentsSource(items: PaletteRecentHit[]): PaletteRecents {
      return {
        items: () => items,
        suggestions: () =>
          [...new Set(items.map((h) => h.appId))]
            .map((appId) => items.find((h) => h.appId === appId)!.label)
            .slice(0, 4),
        ensure: vi.fn<PaletteRecents["ensure"]>(),
        reset: vi.fn<PaletteRecents["reset"]>(),
        setOnResults: vi.fn<PaletteRecents["setOnResults"]>(),
      };
    }

    it("shows a Recents group of vault objects before any query", () => {
      const recents = recentsSource([
        {
          appId: "notes",
          appLabel: "Notes",
          entity: "knowledge.note",
          kind: "note",
          id: "n1",
          label: "Trip notes",
          snippet: "",
          meta: "Aug 3",
        },
      ]);
      const groups = buildPaletteGroups("", deps({ recents }));
      expect(recents.ensure).toHaveBeenCalledWith();
      const group = groups.find((g) => g.group === "Recents")!;
      expect(group).toBeDefined();
      expect(group.items[0]).toMatchObject({
        label: "Trip notes",
        kind: "note",
        meta: "Aug 3",
      });
    });

    it("omits Recents once a query is typed", () => {
      const recents = recentsSource([
        {
          appId: "notes",
          appLabel: "Notes",
          entity: "knowledge.note",
          kind: "note",
          id: "n1",
          label: "Trip notes",
          snippet: "",
          meta: "",
        },
      ]);
      const groups = buildPaletteGroups("café", deps({ recents }));
      expect(groups.find((g) => g.group === "Recents")).toBeUndefined();
    });

    it("omits Recents entirely when there are no hits yet — no empty group", () => {
      const groups = buildPaletteGroups(
        "",
        deps({ recents: recentsSource([]) })
      );
      expect(groups.find((g) => g.group === "Recents")).toBeUndefined();
    });

    it("buildPaletteSuggestions reads the recents source's chips", () => {
      const recents = recentsSource([
        {
          appId: "people",
          appLabel: "People",
          entity: "core.party",
          kind: "person",
          id: "p1",
          label: "Alex Rivera",
          snippet: "",
          meta: "",
        },
      ]);
      expect(buildPaletteSuggestions(deps({ recents }))).toStrictEqual([
        "Alex Rivera",
      ]);
      expect(recents.ensure).toHaveBeenCalledWith();
    });

    it("buildPaletteSuggestions returns no chips without a recents source", () => {
      expect(buildPaletteSuggestions(deps())).toStrictEqual([]);
    });
  });
});
