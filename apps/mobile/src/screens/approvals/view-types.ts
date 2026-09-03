import type { MobileNotice } from "../../lib/gateway";
import type { WaitingFilter } from "./approvals-model";
import type { ApprovalsController } from "./useApprovals";

export interface Focus {
  filter: WaitingFilter;
  selectedItemId: string | undefined;
  editing: boolean;
  alwaysAllow: boolean;
  expandedId: string | undefined;
}

export interface BodyProps {
  page: ApprovalsController;
  focus: Focus;
  patch: (next: Partial<Focus>) => void;
  onOpenNotice: (notice: MobileNotice) => void;
  onOpenSettings: () => void;
  onGrantsLayout: (y: number) => void;
  reviewGrants: () => void;
}
