import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ShellActions } from "../actions.js";
import { ShellActionsProvider } from "../actions.js";
import StorageRoute from "./StorageRoute.js";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

describe(StorageRoute, () => {
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  it("explains the moved route and explicitly opens System", () => {
    const navigate = vi.fn<ShellActions["navigate"]>();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const actions: ShellActions = {
      confirm: vi.fn<ShellActions["confirm"]>(),
      navigate,
      openCommandPalette: vi.fn<ShellActions["openCommandPalette"]>(),
      openContextMenu: vi.fn<ShellActions["openContextMenu"]>(),
      showToast: vi.fn<ShellActions["showToast"]>(),
    };
    act(() =>
      root!.render(
        <ShellActionsProvider value={actions}>
          <StorageRoute />
        </ShellActionsProvider>
      )
    );
    expect(host.textContent).toContain("Storage moved into System");
    const action = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Open System"
    );
    expect(action).toBeDefined();
    act(() => action?.click());
    expect(navigate).toHaveBeenCalledWith({ kind: "gateway" });
  });
});
