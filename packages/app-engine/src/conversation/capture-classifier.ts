import type { TurnStreamEvent } from "./runner.js";
import type { RunTurnFn, HarnessPrefs, TurnInput } from "./turn.js";

const CAPTURE_SYSTEM_PROMPT = [
  "Classify one universal-capture draft for a personal organizer.",
  "Return ONLY JSON with kind (task, expense, note, or event) and a concise title.",
  "Optionally include amountMinor for expenses, startsAt as an ISO instant for events,",
  "and durationMinutes. Never add facts absent from the draft.",
].join(" ");

export interface AgentCapturePreview {
  kind: "task" | "expense" | "note" | "event";
  title?: string;
  amountMinor?: number;
  startsAt?: string;
  durationMinutes?: number;
}

export interface ClassifyCaptureDeps {
  runTurn: RunTurnFn;
  harnessPrefs: HarnessPrefs;
  cwd: string;
  text: string;
  model?: string;
  timeoutMs?: number;
}

export function parseAgentCapturePreview(
  raw: string
): AgentCapturePreview | undefined {
  const unfenced = raw
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  const first = unfenced.indexOf("{");
  const last = unfenced.lastIndexOf("}");
  if (first < 0 || last <= first) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(unfenced.slice(first, last + 1));
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const kind = String(row.kind ?? "");
  if (!["task", "expense", "note", "event"].includes(kind)) return undefined;
  return {
    kind: kind as AgentCapturePreview["kind"],
    ...(typeof row.title === "string" && row.title.trim()
      ? { title: row.title.trim().slice(0, 100) }
      : {}),
    ...(typeof row.amountMinor === "number" &&
    Number.isSafeInteger(row.amountMinor) &&
    row.amountMinor > 0
      ? { amountMinor: row.amountMinor }
      : {}),
    ...(typeof row.startsAt === "string" &&
    !Number.isNaN(Date.parse(row.startsAt))
      ? { startsAt: new Date(row.startsAt).toISOString() }
      : {}),
    ...(typeof row.durationMinutes === "number" &&
    Number.isSafeInteger(row.durationMinutes) &&
    row.durationMinutes > 0
      ? { durationMinutes: row.durationMinutes }
      : {}),
  };
}

/** One bounded, tool-less agent turn used only for ambiguous capture text. */
export async function classifyCaptureWithAgent(
  deps: ClassifyCaptureDeps
): Promise<AgentCapturePreview | undefined> {
  const controller = new AbortController();
  const timer = deps.timeoutMs
    ? setTimeout(() => controller.abort(), deps.timeoutMs)
    : undefined;
  timer?.unref?.();
  let text = "";
  const onEvent = (event: TurnStreamEvent): void => {
    if (event.type === "assistant.delta") text += event.delta;
    else if (event.type === "final") text ||= event.text;
  };
  const input: TurnInput = {
    cwd: deps.cwd,
    message: deps.text.slice(0, 4_000),
    extraSystemPrompt: CAPTURE_SYSTEM_PROMPT,
    ...(deps.model ? { model: deps.model } : {}),
    abortSignal: controller.signal,
    onEvent,
  };
  try {
    await deps.runTurn(input, { prefs: deps.harnessPrefs });
  } finally {
    if (timer) clearTimeout(timer);
  }
  return parseAgentCapturePreview(text);
}
