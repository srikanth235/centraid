// The inline-app contract (issue #505).
//
// A bundled app that mounts INLINE in the shell (no iframe, no served HTML)
// ships a co-located `app-inline.tsx` whose default export is an
// `InlineAppModule` descriptor. The shell route host (packages/client's
// InlineAppRoute) consumes it: it renders `Root`, wires `window.centraid`
// against the shell replica using `queries` + `changeTables`, and lazily
// installs the ask panel from `kitAsk`.
//
// This module lives under `@centraid/blueprints/apps` on purpose: BOTH the
// blueprint side (`app-inline.tsx` imports it relatively) and the client side
// (`import type { InlineAppModule } from '@centraid/blueprints/apps/inline-types'`)
// depend on it, and blueprints must never import `@centraid/client`. It carries
// types only, so it type-checks under both the blueprints and client tsconfigs.
import type { ComponentType, ReactNode } from "react";

/** The `window.KIT_ASK` config each app seeds — mirrors index.html's inline block. */
export interface InlineKitAsk {
  scope: string;
  placeholder?: string;
  intro?: string;
  suggest?: string[];
}

/**
 * The context an inline query handler receives — the shell reproduces the
 * served bridge's `ctx` shape (packages/app-engine bridge-script.ts
 * `runLocalQuery`). Typed loosely at this boundary (the concrete surface is
 * `HandlerCtx`/`VaultApi` in blueprints' ambient `types/centraid.d.ts`, invisible
 * to the client tsconfig) so the same descriptor type-checks on both sides.
 */
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

/** A blueprint query module (`queries/<name>.ts`) as imported for inline use. */
export interface InlineQueryModule {
  default: InlineQueryRun;
}

/**
 * One mounted scope of a multi-scope app (issue #599). The shell mounts a
 * multi-scope app over N scopes at once — the member's own scope plus any
 * shared audience scopes they belong to — and hands the app this descriptor
 * per scope. `label` is the ONLY string an app may render for a scope
 * ("Library", "Family"): app-facing copy never names the underlying storage.
 * `canWrite` is the shell's answer to "may this member add here?", already
 * resolved from the member's role — apps disable, never guess.
 */
export interface InlineScope {
  id: string;
  label: string;
  /**
   * Whether this is the member's OWN vault — the durable founding marker
   * (issue #711 item H). An app's "somewhere other than my own" marker is
   * exactly `personal === false`, never a match on `label`, which the owner
   * is free to rename. Undefined means the host did not say (an older
   * gateway, or a solo mount that answered before the marker existed), and
   * that reads as UNMARKED: withholding a hint is harmless, while marking
   * everything says something untrue.
   *
   * There is no vault "kind" and no `sharing` scope (issue #726): a share's
   * place is the recipient's vault, so "shared" is only ever a fact about
   * where a thing sits — any mounted scope other than the member's own.
   */
  personal?: boolean;
  color?: string;
  icon?: string;
  canWrite: boolean;
}

/**
 * What an inline app contributes to the FRAME's app bar (Photos v4, §3).
 *
 * The app supplies CONTENT; the frame owns the styling. There is no class, no
 * colour and no metric here on purpose: the mark chip, the 20/26 title, the
 * mono count and the button scale are the frame's, and an app that could
 * restyle the bar would be drawing a second chrome inside the first — the
 * duplication this contract exists to retire.
 *
 * The frame's own affordances (history, Build, App settings) are never
 * displaced by a contribution; they stand beside it.
 */
export interface InlineAppBarContribution {
  /** Replaces the app's installed name in the bar. Omit to keep the name. */
  title?: string;
  /** The count beside the title. The frame renders it in the numeric
   *  register (mono, tabular) — pass the number, not the styling. */
  count?: ReactNode;
  /** The app's own actions, trailing. Quiet first, the one filled ink last. */
  actions?: ReactNode;
}

/** One bounded control on the status line. Mirrors the shell's `StatusAction`
 *  structurally — blueprints must never import `@centraid/client`. */
export interface InlineStatusAction {
  label: string;
  run: () => void;
}

/** Determinate progress. Both numbers are real counts, never a fraction. */
export interface InlineStatusProgress {
  done: number;
  total: number;
  /** What is being counted, e.g. "photos". */
  unit?: string;
}

/** One destination in a claimed compact band. */
export interface InlineBandDestination {
  id: string;
  /** The tab's caption. Every tab is labelled — the band has no icon-only
   *  target, because a glyph alone is not a name. */
  label: string;
  /** An icon key from the shared registry. An unknown key renders no glyph
   *  rather than a broken one; the label still names the tab. */
  icon?: string;
}

/**
 * A first-party route claiming the phone's bottom band (CHANGELOG F).
 *
 * Capped at five destinations plus More, exactly as the frame's own band is.
 * The frame renders EITHER its band or this one — never both — and it keeps a
 * home capsule outside the app's tab group either way. `More` is offered only
 * when the app gives it something to open.
 */
export interface InlineBandClaim {
  destinations: readonly InlineBandDestination[];
  /** Which destination is current (`aria-current="page"`). */
  activeId?: string;
  onSelect: (id: string) => void;
  /** The band's sixth slot — the app's own overflow sheet. */
  onMore?: () => void;
}

/**
 * The frame, as an inline app may address it (Photos v4, §3).
 *
 * Every method is a CONTRIBUTION, not a render: the shell decides whether and
 * how to honour it. Calls are safe at any time and idempotent; passing `null`
 * withdraws the contribution. The object identity is stable for the life of
 * the mount, so it can sit in an effect's dependency list.
 *
 * Call from an EFFECT or an event handler, never during the app's own render:
 * the bar and the band render ABOVE the app in the tree, so a call made while
 * rendering would be updating a component that is already painting. The frame
 * shows the app's installed name until the first contribution lands, so the
 * one frame this costs is never a blank bar.
 */
export interface InlineFrame {
  /** Write the frame's app bar. `null` restores the bare frame bar. */
  setAppBar: (bar: InlineAppBarContribution | null) => void;
  /**
   * Say something on the frame's ONE status line — the supported replacement
   * for a toast. There is no second line, no badge, no spinner and no red dot:
   * a later call replaces the earlier one in place.
   */
  setStatus: (
    text: string,
    extra?: { action?: InlineStatusAction; progress?: InlineStatusProgress }
  ) => void;
  /** Drop back to the route's ambient sentence. */
  clearStatus: () => void;
  /**
   * Claim the compact bottom band. Honoured only for a first-party app, only
   * on the compact form factor, and only while the member's `bandOwner`
   * preference says `app`; ignored otherwise, so an app never has to ask.
   * `null` hands the band back.
   */
  claimBand: (claim: InlineBandClaim | null) => void;
}

/** Props the shell passes the app's `Root`. */
export interface InlineAppProps {
  /** The element the shell applies data-app-* knobs to; `Root` reads them here. */
  rootRef: (el: HTMLElement | null) => void;
  /** The frame's contribution channel — app bar, status line, compact band. */
  frame: InlineFrame;
}

/** The descriptor an inline app default-exports from `app-inline.tsx`. */
export interface InlineAppModule {
  appId: string;
  /** Vault entities this app's queries read — the change-subscription filter. */
  changeTables: string[];
  /** Local query modules by name (imported blueprint-side, run against the replica). */
  queries: Record<string, InlineQueryModule>;
  /** Ask-panel config, if the app mounts one. */
  kitAsk?: InlineKitAsk;
  /**
   * Opt in to N-scope mounting (issue #599). When set, the shell mounts this
   * app over every scope the member can see and runs `queries` once per scope;
   * apps without the flag keep the single-scope contract unchanged.
   */
  multiScope?: true;
  Root: ComponentType<InlineAppProps>;
}
