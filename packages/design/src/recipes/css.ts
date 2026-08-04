/**
 * Small generated recipe layer shared by the kit and the shell.  The kit can
 * inline this string; the client may scope the same selectors below its
 * `:where(.centraid-inline-scope)` root.
 */
export function emitRecipeCss(scope = ":root"): string {
  const lines = [
    `/* Generated from @centraid/design recipes — do not edit by hand. */`,
    `${scope} .kit-btn { min-height: var(--target-min, 44px); border-radius: var(--r-md); font: var(--t-small-strong); transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease); }`,
    `${scope} .kit-btn[data-variant="primary"] { background: var(--accent-fill); color: var(--text-inv); border-color: transparent; }`,
    `${scope} .kit-btn[data-variant="primary"]:hover:not([aria-disabled="true"]) { background: var(--accent-deep-hover); }`,
    `${scope} .kit-btn[data-variant="secondary"] { background: var(--bg-elev); color: var(--text); border: 1px solid var(--line); }`,
    `${scope} .kit-btn[data-variant="quiet"] { background: transparent; color: var(--text-soft); border-color: transparent; }`,
    `${scope} .kit-btn[data-variant="destructive"] { background: transparent; color: var(--danger); border: 1px solid var(--danger); }`,
    `${scope} .kit-btn[data-variant="destructiveFilled"] { background: var(--danger); color: var(--text-inv); border-color: transparent; }`,
    `${scope} .kit-btn:hover:not([aria-disabled="true"]):not([data-variant="primary"]):not([data-variant="destructiveFilled"]) { background: var(--bg-hover); }`,
    `${scope} .kit-btn[data-variant="destructiveFilled"]:hover:not([aria-disabled="true"]) { background: var(--danger); color: var(--text-inv); }`,
    `${scope} .kit-btn:focus-visible, ${scope} .kit-icon-btn:focus-visible { outline: 2px solid var(--focus-ring-color); outline-offset: 2px; }`,
    `${scope} .kit-btn[aria-disabled="true"] { color: var(--text-disabled); cursor: not-allowed; }`,
    `${scope} .kit-input { min-height: var(--target-min, 44px); border: 1px solid var(--line); border-radius: var(--r-md); background: var(--bg-elev); color: var(--text); }`,
    `${scope} .kit-input:focus-within { border-color: var(--accent); box-shadow: var(--focus-ring); }`,
    `${scope} .kit-panel { background: var(--bg-elev); border: 1px solid var(--line); border-radius: var(--r-lg); }`,
    `${scope} .kit-chip { border-radius: var(--r-pill); background: var(--accent-soft); color: var(--accent-text); }`,
    `${scope} .kit-progress { background: var(--bg-sunken); border-radius: var(--r-pill); }`,
    `${scope} .kit-progress > * { background: var(--accent-fill); border-radius: inherit; transition: width var(--dur-2) var(--ease); }`,
    `${scope} .kit-recipe-disabled { opacity: var(--o-disabled); pointer-events: none; }`,
  ];
  return lines.join("\n") + "\n";
}
