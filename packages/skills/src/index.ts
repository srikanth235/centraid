/*
 * @centraid/skills
 *
 * Agent grounding for the centraid app builder, modeled as a `skills/`
 * directory of `SKILL.md` units (the home of the grounding half of the retired
 * `@centraid/agent-harness`).
 *
 * - `composeSkills(names)` concatenates the named static skills' bodies — the
 *   authoring contracts that used to be `CENTRAID_APPEND_PROMPT` /
 *   `AUTOMATION_APPEND_PROMPT`. Byte-equivalent, now editable markdown.
 * - `buildUiGroundingBlocks()` / `buildToolsGroundingBlock()` render the
 *   grounding that must be computed per turn (live design tokens + the host's
 *   tool list); they are appended alongside the composed skills.
 *
 * Which skills apply is decided by the app `kind` at the call site:
 *   - app        → composeSkills(['authoring-centraid-apps']) + UI blocks
 *   - automation → composeSkills(['automation-authoring'])
 */

export { skillsDir, listSkills, composeSkills, parseSkillFile, type SkillMeta } from './compose.js';
export { buildUiGroundingBlocks } from './ui-grounding.js';
export { buildToolsGroundingBlock } from './dynamic.js';
