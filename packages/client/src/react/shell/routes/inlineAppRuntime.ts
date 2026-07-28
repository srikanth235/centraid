import type { InlineAppModule } from "@centraid/blueprints/apps/inline-types";
import { toBlueprintCss } from "@centraid/design-tokens";

export const INLINE_SCOPE_CLASS = "centraid-inline-scope";

// The blueprint token layer (--mono/--surface/--_accent/--ease/type scale …),
// rescoped from `:root` to the inline app subtree so it never restyles the
// shell chrome. Injected once; the shell's own `data-theme` on <html> still
// drives the dark block. Kept synchronous so inline theming needs no paint gap.
let inlineTokensInjected = false;
export function ensureInlineScopeTokens(): void {
  if (inlineTokensInjected || typeof document === "undefined") return;
  inlineTokensInjected = true;
  const scoped = toBlueprintCss()
    .replace(
      /:root\[data-theme='dark'\]/gu,
      `:root[data-theme='dark'] .${INLINE_SCOPE_CLASS}`
    )
    .replace(
      /:root:not\(\[data-theme\]\)/gu,
      `:root:not([data-theme]) .${INLINE_SCOPE_CLASS}`
    )
    .replace(
      /(?<lineStart>^|\n):root\s*\{/gu,
      `$<lineStart>.${INLINE_SCOPE_CLASS} {`
    );
  const style = document.createElement("style");
  style.dataset.centraidInlineTokens = "true";
  style.textContent = scoped;
  document.head.appendChild(style);
}

// One cached descriptor promise per (appId, attempt) so React `use()` reads a
// stable promise across renders. A rejection is cached too — otherwise the
// Suspense remount would re-run the loader forever on a persistent chunk
// failure instead of surfacing the error boundary. Retry bumps `attempt` to a
// fresh key (and drops the old one) to re-import.
const descriptorCache = new Map<
  string,
  Promise<{ default: InlineAppModule }>
>();
export function loadDescriptor(
  key: string,
  loader: () => Promise<{ default: InlineAppModule }>
): Promise<{ default: InlineAppModule }> {
  let promise = descriptorCache.get(key);
  if (!promise) {
    promise = loader();
    descriptorCache.set(key, promise);
  }
  return promise;
}

export function dropDescriptor(key: string): void {
  descriptorCache.delete(key);
}
