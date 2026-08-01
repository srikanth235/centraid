import type { IconName } from "@centraid/design";

import type { SidebarPage, SidebarProps } from "./Sidebar.js";

// The sidebar's information architecture, as data.
//
// Three zones, in the order the column reads them (issue #667):
//
//   1. actions   — unlabelled. What you reach for every session.
//   2. vault     — labelled "Vault". The surfaces that act on vault contents.
//   3. recents   — the conversation ledger, rendered by Sidebar's HistorySection
//                  because it owns pinned/archived grouping and row menus.
//
// Zones 1 and 2 live here so the IA is one readable list instead of a wall of
// JSX: reordering a row, renaming it, or moving it between groups is a data
// edit, and the set of destinations can be asserted in a test without
// rendering. Sidebar.tsx maps NavItem → the row component and owns nothing
// about order or grouping.
//
// Naming rule: a row is named for what the member finds there, never for the
// internal model. "Devices", not "Household"; "Data", not "Vault Atlas";
// "Analytics", not "Insights". `page` still carries the internal SidebarPage
// key, so route highlighting is unaffected by what the label says.

export interface NavItem {
  /** Stable identity for keys + tests; independent of the label. */
  id: string;
  label: string;
  icon: IconName;
  /** Route-highlight key. Omitted for rows that are actions, not places. */
  page?: SidebarPage;
  /** Right-aligned hint — a keyboard shortcut or a count. */
  meta?: string;
  /** Tinted row for the one primary action in the column. */
  accent?: boolean;
  /** A quiet dot for "there is something unread here", distinct from a count. */
  dot?: boolean;
  /** Absent = the row renders disabled rather than disappearing, so the
   *  column's shape is stable across hosts that wire fewer handlers. */
  onSelect?: () => void;
}

export interface NavSection {
  id: string;
  /** Omitted for the leading group — an unlabelled first block reads as
   *  "the app", and a label there would be noise. */
  label?: string;
  items: NavItem[];
}

/** The slice of SidebarProps the IA reads. Keeps this module honest: it can
 *  only build rows from wiring the caller actually passed. */
export type NavInput = Pick<
  SidebarProps,
  | "activeConversationId"
  | "activePage"
  | "approvalsCount"
  | "notificationsHasUnreadNotices"
  | "onApprovals"
  | "onAtlas"
  | "onAutomations"
  | "onConnectors"
  | "onHome"
  | "onHousehold"
  | "onInsights"
  | "onNewApp"
  | "onNewChat"
  | "onSearch"
>;

export function buildNavSections(props: NavInput): NavSection[] {
  const actions: NavItem[] = [
    {
      id: "new-chat",
      label: "New Chat",
      icon: "Plus",
      accent: true,
      // "New Chat" is only the active row on a fresh, unsaved conversation;
      // once a thread exists its own Recents row carries the highlight.
      ...(props.activePage === "assistant" && !props.activeConversationId
        ? { page: "assistant" as const }
        : {}),
      ...(props.onNewChat ? { onSelect: props.onNewChat } : {}),
    },
    {
      id: "search",
      label: "Search",
      icon: "Search",
      meta: "⌘K",
      ...(props.onSearch ? { onSelect: props.onSearch } : {}),
    },
    {
      id: "home",
      label: "Home",
      icon: "Home",
      page: "home",
      onSelect: props.onHome,
    },
    {
      id: "notifications",
      label: "Notifications",
      icon: "Bell",
      page: "approvals",
      // A count is a queue you must clear; a dot is news you should see. They
      // mean different things, so they render as different marks.
      ...(props.approvalsCount ? { meta: String(props.approvalsCount) } : {}),
      ...(props.notificationsHasUnreadNotices ? { dot: true } : {}),
      ...(props.onApprovals ? { onSelect: props.onApprovals } : {}),
    },
  ];
  // The builder is dev-gated (#434); when it is off there is no second
  // create verb and the actions block stays four rows.
  if (props.onNewApp)
    actions.push({
      id: "build-new",
      label: "Build new",
      icon: "Pencil",
      meta: "⌘N",
      onSelect: props.onNewApp,
    });

  const vault: NavItem[] = [
    {
      id: "automations",
      label: "Automations",
      icon: "Bolt",
      page: "automations",
      ...(props.onAutomations ? { onSelect: props.onAutomations } : {}),
    },
    {
      id: "connectors",
      label: "Connectors",
      icon: "Plug",
      page: "connectors",
      ...(props.onConnectors ? { onSelect: props.onConnectors } : {}),
    },
    {
      id: "devices",
      label: "Devices",
      icon: "Monitor",
      page: "household",
      ...(props.onHousehold ? { onSelect: props.onHousehold } : {}),
    },
    {
      id: "data",
      label: "Data",
      icon: "Folder",
      page: "atlas",
      ...(props.onAtlas ? { onSelect: props.onAtlas } : {}),
    },
    {
      id: "analytics",
      label: "Analytics",
      icon: "Activity",
      page: "insights",
      ...(props.onInsights ? { onSelect: props.onInsights } : {}),
    },
  ];

  return [
    { id: "actions", items: actions },
    { id: "vault", label: "Vault", items: vault },
  ];
}
