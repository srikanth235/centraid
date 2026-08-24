/*
 * Skills — gateway harness grounding (`src/skills/`)
 *
 * Harness grounding for the gateway's authoring agent, modeled as a `skills/`
 * directory of `SKILL.md` units.
 *
 * `composeSkills(names)` concatenates the named static skills' bodies — the
 * authoring contract, as editable markdown.
 *
 * Which skills apply is decided by the app `kind` at the call site:
 *   - automation → composeSkills(['automation-authoring'])
 *   - app        → nothing; app front ends are written in this repo, not
 *                  authored by a harness (#799).
 */

export { buildAuthoringExtraPrompt } from "./authoring-prompt.js";
