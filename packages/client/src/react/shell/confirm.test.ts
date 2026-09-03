import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openConfirm } from "./confirm.js";

describe("confirm", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  describe(openConfirm, () => {
    it("mounts a dialog with the title/message and resolves true on Confirm", async () => {
      const p = openConfirm({
        title: "Delete?",
        message: "Are you sure",
        confirmLabel: "Delete",
      });
      const card = document.querySelector(".card")!;
      expect(card.textContent).toContain("Delete?");
      expect(card.textContent).toContain("Are you sure");
      (card.querySelector(".danger, .primary") as HTMLButtonElement).click();
      await expect(p).resolves.toBe(true);
      expect(document.querySelector(".card")).toBeNull();
    });

    it("resolves false on Cancel and on backdrop click", async () => {
      const p1 = openConfirm({ title: "T", message: "M" });
      (document.querySelector(".ghost") as HTMLButtonElement).click();
      await expect(p1).resolves.toBe(false);

      const p2 = openConfirm({ title: "T", message: "M" });
      (document.querySelector(".backdrop") as HTMLElement).click();
      await expect(p2).resolves.toBe(false);
    });

    it("uses the danger button style when danger is set", () => {
      void openConfirm({ title: "T", message: "M", danger: true });
      expect(document.querySelector(".danger")).not.toBeNull();
    });

    it("Enter confirms safe actions via document shortcut; danger relies on focused Confirm", async () => {
      const p1 = openConfirm({ title: "T", message: "M" });
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      await expect(p1).resolves.toBe(true);

      const p2 = openConfirm({ title: "T", message: "M", danger: true });
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      expect(document.querySelector(".card")).not.toBeNull();
      (document.querySelector(".danger") as HTMLButtonElement).click();
      await expect(p2).resolves.toBe(true);

      const p3 = openConfirm({ title: "T", message: "M", danger: true });
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      await expect(p3).resolves.toBe(false);
    });

    it("backdrop click dismisses without confirming", async () => {
      const p = openConfirm({ title: "T", message: "M", danger: true });
      const backdrop = document.querySelector(
        '[data-testid="modal-backdrop"]'
      ) as HTMLElement;
      expect(backdrop).not.toBeNull();
      backdrop.click();
      await expect(p).resolves.toBe(false);
      expect(document.querySelector(".card")).toBeNull();
    });

    it("focuses the Confirm button for danger so Enter can activate it natively", async () => {
      void openConfirm({
        title: "Delete?",
        message: "Are you sure",
        danger: true,
        confirmLabel: "Delete",
      });
      await new Promise((resolve) => {
        setTimeout(resolve, 40);
      });
      const confirmBtn = document.querySelector(".danger") as HTMLButtonElement;
      expect(confirmBtn).not.toBeNull();
      expect(document.activeElement).toBe(confirmBtn);
    });
  });
});
