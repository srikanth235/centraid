/** Harness grounding units for the gateway's authoring agent. App kind decides applicability at the call site: automation → `automation-authoring`; app → nothing — app front ends are written in this repo, not harness-authored (#799). */

export { buildAuthoringExtraPrompt } from "./authoring-prompt.js";
