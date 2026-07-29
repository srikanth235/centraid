import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MemberScope } from "../shell/memberScope.js";
import HouseholdScreen from "./HouseholdScreen.js";
import type { HouseholdScreenProps } from "./HouseholdScreen.js";

// Household is the page that had to exist once the space switcher was retired
// (#599, Decision 14): a member is no longer "in" one space, so something must
// show all of them at once — beside the people who hold roles in them.

const NOW = Date.UTC(2026, 6, 13, 12, 0, 0);

let root: Root | null = null;
let container: HTMLDivElement | null = null;
describe("HouseholdScreen suite", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  function scope(over: Partial<MemberScope> = {}): MemberScope {
    return {
      id: "v1",
      label: "Personal",
      role: "admin",
      canWrite: true,
      ...over,
    };
  }

  async function mount(
    props: Partial<HouseholdScreenProps> = {}
  ): Promise<HTMLDivElement> {
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container as HTMLDivElement);
      root.render(
        <HouseholdScreen
          now={NOW}
          spaces={[scope()]}
          defaultScopeId="v1"
          onOpenStorage={() => {}}
          {...props}
        />
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    return container;
  }

  describe(HouseholdScreen, () => {
    it("leads with people and devices, then the spaces they can reach", async () => {
      const el = await mount();
      const text = el.textContent ?? "";
      expect(text).toContain("Household");
      expect(text).toContain("People & devices");
      expect(text).toContain("Spaces");
      expect(text.indexOf("People & devices")).toBeLessThan(
        text.indexOf("Spaces")
      );
    });

    it("names each space and states the access in ownership words, never role jargon", async () => {
      const el = await mount({
        spaces: [
          scope(),
          scope({ id: "v2", label: "Family", role: "read", canWrite: false }),
          scope({ id: "v3", label: "Shed project", role: "write" }),
        ],
        defaultScopeId: "v1",
      });
      const text = el.textContent ?? "";
      expect(text).toContain("Family");
      expect(text).toContain("Shed project");
      expect(text).toContain("3 spaces you can reach");
      // The badge on a non-default space is the ownership word, not the wire role.
      expect(text).toContain("Viewer");
      expect(text).toContain("Member");
      expect(text).not.toMatch(/\badmin\b/u);
      // Nothing on this page may call a space a vault (#599 vocabulary).
      expect(text).not.toMatch(/\bvault\b/iu);
    });

    it("badges exactly one card as the default and offers space settings only there", async () => {
      const onOpenSpaceSettings =
        vi.fn<NonNullable<HouseholdScreenProps["onOpenSpaceSettings"]>>();
      const el = await mount({
        spaces: [scope(), scope({ id: "v2", label: "Family", role: "write" })],
        defaultScopeId: "v1",
        onOpenSpaceSettings,
      });
      const cards = [...el.querySelectorAll("section")];
      const defaults = cards.filter((c) => c.textContent?.includes("Default"));
      expect(defaults).toHaveLength(1);
      expect(defaults[0]!.textContent).toContain("Personal");
      // Settings → Space edits whichever space the client resolves to, so the
      // link must not appear on a card it would silently mis-target.
      const settingsLinks = [...el.querySelectorAll("button")].filter((b) =>
        b.textContent?.includes("Space settings")
      );
      expect(settingsLinks).toHaveLength(1);
      act(() => settingsLinks[0]!.click());
      expect(onOpenSpaceSettings).toHaveBeenCalledWith();
    });

    it("routes every card to storage and backups", async () => {
      const onOpenStorage = vi.fn<HouseholdScreenProps["onOpenStorage"]>();
      const el = await mount({ onOpenStorage });
      const link = [...el.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Storage")
      )!;
      act(() => link.click());
      expect(onOpenStorage).toHaveBeenCalledWith();
    });

    it("renders the roster card when the host can list devices", async () => {
      const loadDevices = vi
        .fn<NonNullable<HouseholdScreenProps["loadDevices"]>>()
        .mockResolvedValue([]);
      const el = await mount({
        loadDevices,
        onRevokeDevice: () => Promise.resolve({ removed: true }),
      });
      expect(loadDevices).toHaveBeenCalledWith();
      expect(el.textContent).not.toContain("doesn’t report a roster");
    });

    it("says so plainly when the gateway reports no roster, rather than rendering nothing", async () => {
      const el = await mount();
      expect(el.textContent).toContain("doesn’t report a roster");
    });

    it('distinguishes "still loading" from "genuinely no spaces"', async () => {
      const loading = await mount({ spaces: [], spacesLoading: true });
      expect(loading.textContent).toContain("Loading spaces…");
      act(() => root?.unmount());
      container?.remove();
      const empty = await mount({ spaces: [], spacesLoading: false });
      expect(empty.textContent).toContain("No spaces are mounted");
    });

    it('offers "New space" only when the host can create one', async () => {
      const withCreate = await mount({ onNewSpace: () => {} });
      expect(withCreate.textContent).toContain("New space");
      act(() => root?.unmount());
      container?.remove();
      const without = await mount();
      expect(without.textContent).not.toContain("New space");
    });
  });
});
