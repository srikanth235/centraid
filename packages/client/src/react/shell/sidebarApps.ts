import type { IconName } from '@centraid/design-tokens';
import type { SidebarApp } from './Sidebar.js';

// Map the shell's live app state (installed userApps + on-disk drafts) into the
// two Sidebar app lists — the pure part of the vanilla `buildHomeSidebar`.
// Installed apps carry the `new` status pill, drafts the `draft` one; the
// Sidebar folds them into one "Apps" list but keeps the status distinct.
export function toSidebarApps(
  userApps: readonly UserAppMeta[],
  drafts: readonly DraftAppMeta[],
): { apps: SidebarApp[]; drafts: SidebarApp[] } {
  const map = (a: UserAppMeta | DraftAppMeta, status: 'new' | 'draft'): SidebarApp => ({
    id: a.id,
    name: a.name,
    iconKey: a.iconKey as IconName,
    color: a.color,
    status,
  });
  return {
    apps: userApps.map((a) => map(a, 'new')),
    drafts: drafts.map((d) => map(d, 'draft')),
  };
}
