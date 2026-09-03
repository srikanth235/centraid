import {
  healthSentence,
  opsGenericLine,
  opsStateCarriesAction,
} from "@centraid/design/blocks";
import type { OpsState } from "@centraid/design/blocks";

export type { OpsState } from "@centraid/design/blocks";

export interface HealthCopy {
  label: string;
  detail: string;
  action?: string;
  emptyText: string;
  loadingText: string;
  errorText: string;
}

export interface HealthLineCopy {
  text: string;
  action?: string;
}

export function healthLineFor(
  state: OpsState,
  copy: HealthCopy
): HealthLineCopy {
  const generic = opsGenericLine(state, {
    empty: copy.emptyText,
    error: copy.errorText,
    loading: copy.loadingText,
  });
  if (generic !== undefined) return { text: generic };
  const text = healthSentence(copy.label, copy.detail);
  return opsStateCarriesAction(state) && copy.action
    ? { action: copy.action, text }
    : { text };
}
