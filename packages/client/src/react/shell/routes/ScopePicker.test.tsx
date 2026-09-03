import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OwnerScope } from "../ownerScope.js";
import ScopePicker from "./ScopePicker.js";

let root: Root | null = null;
let host: HTMLElement | null = null;
describe("ScopePicker suite", () => {
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  function scope(over: Partial<OwnerScope> = {}): OwnerScope {
    return {
      id: "v1",
      label: "Personal",
      canWrite: true,
      ...over,
    };
  }

  function render(el: React.ReactElement): HTMLElement {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(el));
    return host;
  }

  const MANY: OwnerScope[] = [
    scope(),
    scope({ id: "v2", label: "Family" }),
    scope({ id: "v3", label: "Neighbours", canWrite: false }),
  ];

  describe(ScopePicker, () => {
    it("offers only vaults this owner can write to — a read-only vault is not a target", () => {
      const el = render(
        <ScopePicker
          scopes={MANY}
          value="v1"
          onChange={() => {}}
          label="New conversation in"
        />
      );
      const options = [...el.querySelectorAll("option")].map(
        (o) => o.textContent
      );
      expect(options).toHaveLength(2);
      expect(options.join(" ")).toContain("Personal");
      expect(options.join(" ")).toContain("Family");
      expect(options.join(" ")).not.toContain("Neighbours");
    });

    it("labels each option with the vault name alone — no role badge, no wire word", () => {
      const el = render(
        <ScopePicker scopes={MANY} value="v1" onChange={() => {}} label="In" />
      );
      const options = [...el.querySelectorAll("option")].map(
        (o) => o.textContent
      );
      expect(options).toStrictEqual(["Personal", "Family"]);
      expect(el.textContent).not.toMatch(/\badmin\b/u);
      expect(el.textContent).not.toMatch(/\bvault\b/iu);
    });

    it("collapses to a plain statement when there is only one writable vault", () => {
      const el = render(
        <ScopePicker
          scopes={[
            scope(),
            scope({
              id: "v3",
              label: "Neighbours",
              canWrite: false,
            }),
          ]}
          value="v1"
          onChange={() => {}}
          label="Install into"
        />
      );
      expect(el.querySelector("select")).toBeNull();
      expect(el.textContent).toContain("Install into");
      expect(el.textContent).toContain("Personal");
    });

    it("locks to a statement once the choice is made, however many vaults exist", () => {
      const el = render(
        <ScopePicker
          scopes={MANY}
          value="v2"
          onChange={() => {}}
          label="Reading"
          locked
        />
      );
      expect(el.querySelector("select")).toBeNull();
      expect(el.textContent).toContain("Family");
    });

    it("reports a pick by scope id", () => {
      const onChange =
        vi.fn<React.ComponentProps<typeof ScopePicker>["onChange"]>();
      const el = render(
        <ScopePicker scopes={MANY} value="v1" onChange={onChange} label="In" />
      );
      const select = el.querySelector("select")!;
      act(() => {
        select.value = "v2";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(onChange).toHaveBeenCalledWith("v2");
    });

    it("renders nothing at all when no vault is known", () => {
      const el = render(
        <ScopePicker
          scopes={[]}
          value={undefined}
          onChange={() => {}}
          label="In"
        />
      );
      expect(el.textContent).toBe("");
    });
  });
});
