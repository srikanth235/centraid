import { composeSkills } from "./compose.js";

export interface AuthoringExtraPromptInput {
  baseExtra: string;
  appKind: "app" | "automation";
}

export function buildAuthoringExtraPrompt(
  input: AuthoringExtraPromptInput
): string {
  const blocks: string[] = input.baseExtra ? [input.baseExtra] : [];
  if (input.appKind === "automation") {
    blocks.push(composeSkills(["automation-authoring"]));
  }
  return blocks.join("\n\n");
}
