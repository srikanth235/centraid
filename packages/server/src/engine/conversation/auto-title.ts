import { unrefTimer } from "../../lib/unref-timer.js";
import type { TurnStreamEvent } from "./runner.js";
import { TurnPlane } from "./turn-plane.js";
import type { RunTurnFn, HarnessPrefs, TurnInput } from "./turn.js";

const MAX_TITLE_CHARS = 60;

const TITLE_SYSTEM_PROMPT = [
  "You name a conversation. Read the first user message and the assistant reply,",
  "then output a single short title (3–6 words) that captures the topic.",
  "Rules: no surrounding quotes, no trailing punctuation, no prefix like",
  '"Title:", plain text only, sentence case. Output ONLY the title.',
].join(" ");

export interface GenerateTitleDeps {
  runTurn: RunTurnFn;
  harnessPrefs: HarnessPrefs;
  cwd: string;
  model: string;
  userMessage: string;
  assistantText: string;
  timeoutMs?: number;
  egressConsent: () => boolean | Promise<boolean>;
}

export function cleanTitle(raw: string): string | undefined {
  let t = raw.trim();
  t = t.replace(/^title\s*[:\-–]\s*/iu, "");
  const first = t[0];
  const last = t[t.length - 1];
  if (
    t.length >= 2 &&
    ((first === '"' && last === '"') ||
      (first === "'" && last === "'") ||
      (first === "“" && last === "”") ||
      (first === "‘" && last === "’"))
  ) {
    t = t.slice(1, -1).trim();
  }
  const nl = t.indexOf("\n");
  if (nl >= 0) t = t.slice(0, nl).trim();
  t = t
    .replace(/\s+/gu, " ")
    .replace(/[.,;:!?…]+$/u, "")
    .trim();
  if (t.length === 0) return undefined;
  if (t.length <= MAX_TITLE_CHARS) return t;
  return `${t.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`;
}

export async function generateConversationTitle(
  deps: GenerateTitleDeps
): Promise<string | undefined> {
  const userExcerpt = excerpt(deps.userMessage, 1500);
  const assistantExcerpt = excerpt(deps.assistantText, 1500);
  const prompt = [
    "First user message:",
    userExcerpt,
    "",
    "Assistant reply:",
    assistantExcerpt,
    "",
    "Title:",
  ].join("\n");

  const controller = new AbortController();
  const timer = deps.timeoutMs
    ? setTimeout(() => controller.abort(), deps.timeoutMs)
    : undefined;
  unrefTimer(timer);

  let text = "";
  const onEvent = (event: TurnStreamEvent): void => {
    if (event.type === "assistant.delta") text += event.delta;
    else if (event.type === "final") text ||= event.text;
  };

  const input: TurnInput = {
    cwd: deps.cwd,
    message: prompt,
    extraSystemPrompt: TITLE_SYSTEM_PROMPT,
    model: deps.model,
    abortSignal: controller.signal,
    onEvent,
  };
  const turnPlane = new TurnPlane(deps.runTurn);
  try {
    await turnPlane.runTurn(input, deps.harnessPrefs, {
      surface: "interactive",
      egress: "attended",
      egressConsent: deps.egressConsent,
      failover: "none",
      permissionPolicy: "deny",
      artifacts: "delegate-only",
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
  return cleanTitle(text);
}

function excerpt(s: string, max: number): string {
  const flat = s.replace(/\s+/gu, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}
