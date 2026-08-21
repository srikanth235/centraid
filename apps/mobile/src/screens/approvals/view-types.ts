// The Notifications screen's own view state, shared by its three view files
// (#765). None of it is the gateway's, and none of it survives a re-read.

import type { MobileNotice } from "../../lib/gateway";
import type { WaitingFilter } from "./approvals-model";
import type { ApprovalsController } from "./useApprovals";

/** What is selected, open, or being edited. */
export interface Focus {
  filter: WaitingFilter;
  selectedItemId: string | undefined;
  editing: boolean;
  alwaysAllow: boolean;
  expandedId: string | undefined;
}

/** Everything a body block needs: the data half, the view state, and the
 *  navigations only the screen can perform. */
export interface BodyProps {
  page: ApprovalsController;
  focus: Focus;
  patch: (next: Partial<Focus>) => void;
  onOpenNotice: (notice: MobileNotice) => void;
  onOpenSettings: () => void;
  onGrantsLayout: (y: number) => void;
  reviewGrants: () => void;
}
