import { createContext, useContext } from "react";

import type { ShellRoute } from "../../app-shell-context.js";
import type { ConfirmOpts } from "./confirm.js";
import type { ShellMenuAnchor } from "./contextMenu.js";

export interface ShellActions {
  showToast: (message: string) => void;
  openCommandPalette: () => void;
  openContextMenu: (app: AppMetaResolvedType, anchor: ShellMenuAnchor) => void;
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
  navigate: (route: ShellRoute) => void;
  replace?: (route: ShellRoute) => void;
  refreshAssistantThreads?: () => void;
}

const ShellActionsContext = createContext<ShellActions | null>(null);

export const ShellActionsProvider = ShellActionsContext.Provider;

export function useShellActions(): ShellActions {
  const ctx = useContext(ShellActionsContext);
  if (!ctx)
    throw new Error(
      "useShellActions must be used within a ShellActionsProvider"
    );
  return ctx;
}
