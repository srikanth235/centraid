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
 *  navigations only the screen can perform. `onOpenSettings` left with the
 *  room migration (#1015, Wave 2): an unpaired phone's one way forward is the
 *  room error's `secondary` now. */
export interface BodyProps {
  page: ApprovalsController;
  focus: Focus;
  patch: (next: Partial<Focus>) => void;
  onOpenNotice: (notice: MobileNotice) => void;
  onGrantsLayout: (y: number) => void;
  /** The empty QUEUE's verb. Not the room's `empty`: this page still has a
   *  tail (the standing grants) when nothing is waiting, and a room empty
   *  replaces the body wholesale. */
  reviewGrants: () => void;
}
