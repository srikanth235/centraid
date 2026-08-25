// Desktop React DOM component library — the shell's presentational primitives.
// Mirrors the mobile RN component API over @centraid/design (the one
// shared cross-runtime package) + the local `cx`/`tile-visual` helpers.
// Each component owns a co-located `*.module.css`; there are no global
// component classes. Lived in `@centraid/desktop-ui` + `@centraid/ui-core`
// until both were folded here (single consumer, no mobile reuse of the
// logic) — design-tokens stays the sole shared UI package.

export { default as Icon } from "./Icon.js";

export { default as Button, IconButton } from "./Button.js";

export { default as StatusPill } from "./StatusPill.js";

export { default as KindBadge } from "./KindBadge.js";

export { default as Gallery } from "./Gallery.js";

// The v9 block vocabulary (#765) — the shared shapes every operational
// route is assembled from — is imported DIRECTLY (`../ui/RowsBlock.js`), the
// same way `states.tsx` is. A barrel re-export would make every block look
// used to a grep the moment one of them is, which is exactly the signal the
// consolidation sweep needs to keep reading.
