/*
 * Skills — gateway harness grounding (`src/skills/`)
 *
 * Harness grounding for the Centraid app builder, modeled as a `skills/`
 * directory of `SKILL.md` units.
 *
 * - `composeSkills(names)` concatenates the named static skills' bodies — the
 *   authoring contracts that used to be `CENTRAID_APPEND_PROMPT` /
 *   `AUTOMATION_APPEND_PROMPT`. Byte-equivalent, now editable markdown.
 * - `buildUiGroundingBlocks()` renders the grounding that must be computed per
 *   turn (live design tokens); it is appended alongside the composed skills.
 *
 * Which skills apply is decided by the app `kind` at the call site:
 *   - app        → composeSkills(['authoring-centraid-apps']) + UI blocks
 *   - automation → composeSkills(['automation-authoring'])
 */

export { buildAuthoringExtraPrompt } from "./authoring-prompt.js";
