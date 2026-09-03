import type { ComponentType, ReactNode } from "react";

import type { PendingProjectionDeclaration } from "./_shared/pending-overlay.js";

export interface InlineKitAsk {
  scope: string;
  placeholder?: string;
  intro?: string;
  suggest?: string[];
}

export interface InlineQueryArgs {
  params: Record<string, string>;
  query: Record<string, unknown>;
  input?: Record<string, unknown>;
  app: { id: string; dir: string };
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  ctx: unknown;
}

export type InlineQueryRun = (args: InlineQueryArgs) => unknown;

export interface InlineQueryModule {
  default: InlineQueryRun;
}

export interface InlineScope {
  id: string;
  label: string;
  personal?: boolean;
  color?: string;
  icon?: string;
  canWrite: boolean;
}

export interface InlineAppBarContribution {
  title?: string;
  count?: ReactNode;
  actions?: ReactNode;
}

export interface InlineStatusAction {
  label: string;
  run: () => void;
}

export interface InlineStatusProgress {
  done: number;
  total: number;
  unit?: string;
}

export interface InlineBandDestination {
  id: string;
  label: string;
  icon?: string;
}

export interface InlineBandClaim {
  destinations: readonly InlineBandDestination[];
  activeId?: string;
  onSelect: (id: string) => void;
  onMore?: () => void;
}

export interface InlineFrame {
  setAppBar: (bar: InlineAppBarContribution | null) => void;
  setStatus: (
    text: string,
    extra?: { action?: InlineStatusAction; progress?: InlineStatusProgress }
  ) => void;
  clearStatus: () => void;
  claimBand: (claim: InlineBandClaim | null) => void;
}

export interface InlineAppProps {
  rootRef: (el: HTMLElement | null) => void;
  frame: InlineFrame;
  compact?: boolean;
}

export interface InlineAppModule {
  appId: string;
  pendingProjection: PendingProjectionDeclaration;
  changeTables: string[];
  queries: Record<string, InlineQueryModule>;
  kitAsk?: InlineKitAsk;
  multiScope?: true;
  Root: ComponentType<InlineAppProps>;
}
