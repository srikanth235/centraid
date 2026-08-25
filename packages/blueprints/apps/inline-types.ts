// The inline-app contract (#505). An app mounting INLINE ships a co-located
// `app-inline.tsx` default-exporting an `InlineAppModule`; the shell's
// InlineAppRoute renders `Root`, wires `window.centraid` from `queries` +
// `changeTables`, and lazily installs `kitAsk`.
//
// It lives under `@centraid/blueprints/apps` because BOTH sides depend on it and
// blueprints must never import `@centraid/client`. Types only, so it checks
// under both tsconfigs.
import type { ComponentType, ReactNode } from "react";

import type { PendingProjectionDeclaration } from "./_shared/pending-overlay.js";

/** Per-app copy for the inline Ask panel. */
export interface InlineKitAsk {
  scope: string;
  placeholder?: string;
  intro?: string;
  suggest?: string[];
}

/** Typed loosely on purpose: the concrete `HandlerCtx`/`VaultApi` lives in
 *  blueprints' ambient types, invisible to the client tsconfig. */
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

/** A `queries/<name>.ts` module, imported for inline use. */
export interface InlineQueryModule {
  default: InlineQueryRun;
}

/**
 * One mounted scope (#599). `label` is the ONLY string an app may render for a
 * scope: app-facing copy never names the underlying storage. `canWrite` is the
 * shell's answer, already resolved from the member's role — apps disable, never
 * guess.
 */
export interface InlineScope {
  id: string;
  label: string;
  /**
   * The durable founding marker (#711). "Somewhere other than my own" is exactly
   * `personal === false`, never a match on `label`, which the owner may rename.
   * Undefined means the host did not say and reads as UNMARKED — withholding a
   * hint is harmless, marking everything says something untrue.
   *
   * There is no vault "kind" and no `sharing` scope (#726): "shared" is only
   * ever a fact about where a thing sits.
   */
  personal?: boolean;
  color?: string;
  icon?: string;
  canWrite: boolean;
}

/**
 * The app supplies CONTENT; the frame owns styling. No class, colour or metric
 * here on purpose — an app that could restyle the bar would draw a second chrome
 * inside the first. The frame's own affordances stand beside a contribution,
 * never displaced by it.
 */
export interface InlineAppBarContribution {
  /** Omit to keep the app's installed name. */
  title?: string;
  /** Pass the number, not the styling: the frame sets the numeric register. */
  count?: ReactNode;
  /** Trailing. Quiet first, the one filled ink last. */
  actions?: ReactNode;
}

/** Mirrors the shell's `StatusAction` structurally: blueprints must never
 *  import `@centraid/client`. */
export interface InlineStatusAction {
  label: string;
  run: () => void;
}

/** Both numbers are real counts, never a fraction. */
export interface InlineStatusProgress {
  done: number;
  total: number;
  /** What is counted, e.g. "photos". */
  unit?: string;
}

/** One destination in a claimed compact band. */
export interface InlineBandDestination {
  id: string;
  /** Every tab is labelled: a glyph alone is not a name. */
  label: string;
  /** An unknown key renders no glyph rather than a broken one. */
  icon?: string;
}

/**
 * Capped at five destinations plus More, as the frame's own band is. The frame
 * renders EITHER its band or this one, never both, and keeps a home capsule
 * outside the app's tab group either way.
 */
export interface InlineBandClaim {
  destinations: readonly InlineBandDestination[];
  /** `aria-current="page"`. */
  activeId?: string;
  onSelect: (id: string) => void;
  /** The band's sixth slot. */
  onMore?: () => void;
}

/**
 * Every method is a CONTRIBUTION, not a render: the shell decides whether to
 * honour it. Calls are idempotent and `null` withdraws; the object identity is
 * stable for the mount, so it may sit in a dependency list.
 *
 * Call from an EFFECT or an event handler, NEVER during render: the bar and band
 * render above the app, so a call while rendering updates a component already
 * painting. The frame shows the installed name until the first contribution, so
 * the frame this costs is never a blank bar.
 */
export interface InlineFrame {
  /** `null` restores the bare frame bar. */
  setAppBar: (bar: InlineAppBarContribution | null) => void;
  /** The frame's ONE status line, replacing toasts. No second line, badge,
   *  spinner or dot: a later call replaces the earlier in place. */
  setStatus: (
    text: string,
    extra?: { action?: InlineStatusAction; progress?: InlineStatusProgress }
  ) => void;
  /** Drop back to the route's ambient sentence. */
  clearStatus: () => void;
  /** Honoured only for a first-party app on the compact form factor; ignored
   *  otherwise, so an app never has to ask. `null` withdraws. */
  claimBand: (claim: InlineBandClaim | null) => void;
}

/** Props the shell passes the app's `Root`. */
export interface InlineAppProps {
  /** Carries the shell's data-app-* knobs. */
  rootRef: (el: HTMLElement | null) => void;
  /** App bar, status line, compact band. */
  frame: InlineFrame;
  /** Served/harness mounts omit it and stay regular-width, so a narrow pane
   * never removes its only navigation. */
  compact?: boolean;
}

/** The descriptor an inline app default-exports from `app-inline.tsx`. */
export interface InlineAppModule {
  appId: string;
  /** Pure action→replica-row projection, consumed by every seat (#738). */
  pendingProjection: PendingProjectionDeclaration;
  /** The change-subscription filter. */
  changeTables: string[];
  /** Imported blueprint-side, run against the replica. */
  queries: Record<string, InlineQueryModule>;
  /** Ask-panel config, if the app mounts one. */
  kitAsk?: InlineKitAsk;
  /** Opt in to N-scope mounting (#599): the shell runs `queries` once per
   *  scope. Without it the single-scope contract is unchanged. */
  multiScope?: true;
  Root: ComponentType<InlineAppProps>;
}
