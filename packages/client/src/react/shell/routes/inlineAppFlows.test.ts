import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as GatewayClient from "../../../gateway-client.js";
import type { ShellActions } from "../actions.js";
import type * as Prompt from "../prompt.js";
import { deleteInlineApp, renameInlineApp } from "./inlineAppFlows.js";

const { deleteApp, updateAppMeta, openPrompt } = vi.hoisted(() => ({
  deleteApp: vi.fn<typeof GatewayClient.deleteApp>(),
  updateAppMeta: vi.fn<typeof GatewayClient.updateAppMeta>(),
  openPrompt: vi.fn<typeof Prompt.openPrompt>(),
}));

vi.mock(import("../../../gateway-client.js"), () => ({
  deleteApp,
  updateAppMeta,
}));

vi.mock(import("../prompt.js"), () => ({ openPrompt }));

const app = { id: "notes", name: "Notes" } as AppMetaResolvedType;

describe("inlineAppFlows", () => {
  beforeEach(() => {
    deleteApp.mockReset();
    updateAppMeta.mockReset();
    openPrompt.mockReset();
  });

  it("renames through the prompt and reports the new name", async () => {
    openPrompt.mockResolvedValue("Journal");
    const updates: Array<{ id: string; name?: string }> = [];
    updateAppMeta.mockImplementation(async (input) => {
      updates.push(input);
      return { ok: true };
    });
    const spoken: string[] = [];
    const say: ShellActions["showToast"] = (message) => {
      spoken.push(message);
    };
    await renameInlineApp({ app, say });
    expect(updates).toStrictEqual([{ id: "notes", name: "Journal" }]);
    expect(spoken).toStrictEqual(['Renamed to "Journal"']);
  });

  it("leaves the app alone when the rename prompt is cancelled", async () => {
    openPrompt.mockResolvedValue(null);
    const spoken: string[] = [];
    const say: ShellActions["showToast"] = (message) => {
      spoken.push(message);
    };
    await renameInlineApp({ app, say });
    expect(updateAppMeta).not.toHaveBeenCalled();
    expect(spoken).toStrictEqual([]);
  });

  it("deletes after confirmation and then hands control back", async () => {
    const confirm = vi.fn<ShellActions["confirm"]>().mockResolvedValue(true);
    const spoken: string[] = [];
    const say: ShellActions["showToast"] = (message) => {
      spoken.push(message);
    };
    const deleted: string[] = [];
    const deletes: Array<{ id: string }> = [];
    deleteApp.mockImplementation(async (input) => {
      deletes.push(input);
      return { ok: true };
    });
    await deleteInlineApp({
      app,
      confirm,
      say,
      onDeleted: () => {
        deleted.push(app.id);
      },
    });
    expect(deletes).toStrictEqual([{ id: "notes" }]);
    expect(spoken).toStrictEqual(['Deleted "Notes"']);
    expect(deleted).toStrictEqual(["notes"]);
  });

  it("does not delete when the confirmation is refused", async () => {
    const confirm = vi.fn<ShellActions["confirm"]>().mockResolvedValue(false);
    const say = vi.fn<ShellActions["showToast"]>();
    const onDeleted = vi.fn<() => void>();
    await deleteInlineApp({ app, confirm, say, onDeleted });
    expect(deleteApp).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
