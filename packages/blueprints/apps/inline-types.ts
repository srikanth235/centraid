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
import type { ComponentType } from 'react';

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
  log: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
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
  color?: string;
  icon?: string;
  canWrite: boolean;
}

/** Props the shell passes the app's `Root`. */
export interface InlineAppProps {
  /** The element the shell applies data-app-* knobs to; `Root` reads them here. */
  rootRef: (el: HTMLElement | null) => void;
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
