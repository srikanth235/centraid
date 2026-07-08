// The vanilla↔React handoff seam (issue #325, Phase 3).
//
// The renderer is two independently-loaded module graphs: the vanilla shell
// (tsc → per-file ES modules) and the React bundle (Vite → react-boot.js).
// They can't `import` each other, so converted screens meet here: react-boot
// publishes `window.CentraidReact` with one `mount<Screen>` per converted
// screen, and the vanilla route module (still owning routing/teardown) calls
// it, mounts the returned React tree into the page container, and registers the
// returned disposer as the page's cleanup. If the bundle is missing the vanilla
// module falls back to its own render, so the app is runnable at every commit.

import type { TileVariant } from '@centraid/design-tokens';

// The bridge is intentionally self-contained — it must not import the vanilla
// shell modules, whose ambient globals aren't in the React island's tsconfig.
// `DiscoverTemplate` mirrors `TemplateEntry` (app-shell-context.ts) field for
// field so the vanilla side's `TemplateEntry` values pass through unchanged.
export interface DiscoverTemplate {
  id: string;
  name: string;
  desc: string;
  colorKey: string;
  iconKey: string;
  version: string;
  kind?: 'app' | 'automation';
  emoji?: string;
  category?: string;
  triggerKind?: 'cron' | 'webhook';
  triggerLabel?: string;
  integrations?: readonly string[];
}

/** Right-click anchor passed back to the shell's template context menu. */
export interface DiscoverMenuAnchor {
  kind: 'point';
  x: number;
  y: number;
}

/** Everything the React Discover screen needs from the vanilla shell. */
export interface DiscoverBridgeProps {
  appTemplates: readonly DiscoverTemplate[];
  automationTemplates: readonly DiscoverTemplate[];
  tileVariant: TileVariant;
  onOpenTemplate: (t: DiscoverTemplate) => void;
  onOpenAutomationTemplate: (t: DiscoverTemplate) => void;
  onTemplateContext: (t: DiscoverTemplate, anchor: DiscoverMenuAnchor) => void;
}

export interface CentraidReactBridge {
  /** Mount the React Discover screen into `host`; returns an unmount disposer. */
  mountDiscover(host: HTMLElement, props: DiscoverBridgeProps): () => void;
}

declare global {
  interface Window {
    CentraidReact?: CentraidReactBridge;
  }
}
