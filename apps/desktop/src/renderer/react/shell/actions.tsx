import { createContext, useContext } from 'react';
import type { ShellRoute } from '../../app-shell-context.js';
import type { ShellMenuAnchor } from './Sidebar.js';

// The cross-cutting action surface the route wrappers consume — the React
// equivalent of the vanilla ShellContext's action entries. Navigation is NOT
// here (routes get `nav` from ShellApp); this is for the overlay/imperative
// actions (toast, context menus, previews, builder entry) that a screen fires
// but doesn't own. App.tsx provides the implementations; they're ported from
// the vanilla cardsMod/autoMod one cluster at a time.
export interface ShellActions {
  showToast: (message: string) => void;
  /** Open the builder (new app, or editing an existing one). */
  enterBuilder: (opts: { appContext?: AppMetaResolvedType; initialPrompt?: string }) => void;
  /** The new-app sheet (⌘N / sidebar Build new). */
  openNewAppSheet: () => void;
  /** ⌘K command palette. */
  openCommandPalette: () => void;
  /** Right-click / ••• menu for an installed app or draft. */
  openContextMenu: (app: AppMetaResolvedType, anchor: ShellMenuAnchor) => void;
  /** Navigate — mirrors ShellApp's nav so deep children can route without
   *  threading `nav` all the way down. Set by App.tsx per render. */
  navigate: (route: ShellRoute) => void;
}

const ShellActionsContext = createContext<ShellActions | null>(null);

export const ShellActionsProvider = ShellActionsContext.Provider;

export function useShellActions(): ShellActions {
  const ctx = useContext(ShellActionsContext);
  if (!ctx) throw new Error('useShellActions must be used within a ShellActionsProvider');
  return ctx;
}
