// Needs you's own view state, shared by its view files (#765). None of it is
// the gateway's, and none of it survives a re-read.

import type { WaitingFilter } from "./needs-you-model";
import type { NeedsYouController } from "./useNeedsYou";

/** What is selected, open, or being edited. */
export interface Focus {
  filter: WaitingFilter;
  selectedItemId: string | undefined;
  editing: boolean;
  alwaysAllow: boolean;
  expandedId: string | undefined;
}

/** Everything a body block needs: the data half and the view state. The
 *  notice and standing-grant navigations left with R-NY-2 (#1015): notices
 *  live in Activity's alerts tab and grants in Settings → Access, so nothing on
 *  this page leaves it except a decision's own ceremony. */
export interface BodyProps {
  page: NeedsYouController;
  focus: Focus;
  patch: (next: Partial<Focus>) => void;
}
