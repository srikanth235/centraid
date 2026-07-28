// Centraid blueprint kit — native Web Components (issue #327; de-Lit pass).
//
// This is deliberately a registration barrel: authored apps retain the single
// `import "./elements.js"` contract, while each element owns its implementation
// in a small module. Keeping that boundary lets the lint gate enforce one
// custom-element class per module without making consumers import internals.

export { PICK_KIND_LABELS, entityKindLabel, KitElement } from './elements-base.js';
export { KitAvatar } from './kit-avatar.js';
export { KitMeter } from './kit-meter.js';
export { KitLineChart } from './kit-line-chart.js';
export { KitBarChart } from './kit-bar-chart.js';
export { KitSkeleton } from './kit-skeleton.js';
export { KitToast } from './kit-toast.js';
export { KitMentionChip } from './kit-mention-chip.js';
export { KitReferenceStrip } from './kit-reference-strip.js';
