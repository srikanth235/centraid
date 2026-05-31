# @centraid/skills

Agent grounding for the centraid app **builder**, modeled as a `skills/`
directory rather than TypeScript string-builders.

This package is the home of what used to be the "grounding" half of the retired
`@centraid/agent-harness`: the prose that teaches a coding agent how to author
centraid apps (folder layout, the `app.json` manifest, the JS-only handler
contract, migrations, automations, the security model) and the visual contract
(design tokens, icon set, component primitives, UX rules).

## Layout

```
skills/
  authoring-centraid-apps/SKILL.md   # how to author/modify a centraid UI app
  automation-authoring/SKILL.md      # how to author a centraid automation app
src/
  index.ts        # public API
  compose.ts      # SKILL.md discovery + frontmatter parsing + body composition
  ui-grounding.ts # buildUiGroundingBlocks() — live design-token + icon grounding
  dynamic.ts      # buildToolsGroundingBlock() — the host-tool list for a turn
```

### Why some grounding is markdown and some is code

Each `SKILL.md` is a static markdown unit with YAML frontmatter (`name` +
`description`) — the Anthropic Agent Skill format, so both backends (Claude
Agent SDK and the codex app-server) can discover and progressively disclose it
from disk. The two **authoring contracts** are pure prose, so they live as
`SKILL.md`.

Two grounding inputs are computed per turn and cannot be static files:

- **Design tokens + icon set** (`ui-grounding.ts`) — rendered live from
  `@centraid/design-tokens` so a token change propagates without a rebuild.
- **Host-tool list** (`dynamic.ts`) — enumerated per runner kind.

These ship as render functions and are appended to the turn's instructions
alongside the composed skills. Promoting `ui-grounding` to a generated
`centraid-ui-design/SKILL.md` snapshot (so the design contract is also a
discoverable skill) is the natural next step.

## Usage

```ts
import { composeSkills, buildUiGroundingBlocks, buildToolsGroundingBlock } from '@centraid/skills';

const blocks: string[] = [];
if (appKind === 'automation') {
  blocks.push(composeSkills(['automation-authoring']));
} else {
  blocks.push(composeSkills(['authoring-centraid-apps']), ...buildUiGroundingBlocks());
}
const tools = buildToolsGroundingBlock(hostTools);
if (tools) blocks.push(tools);
const extraSystemPrompt = blocks.join('\n\n');
```
