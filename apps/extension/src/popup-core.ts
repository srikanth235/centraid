import type { CompanionModule, ModuleStatus } from "./types.js";

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function moduleAvailability(modules: readonly ModuleStatus[]): {
  enabled: ReadonlySet<CompanionModule>;
  agendaVisible: boolean;
  peopleVisible: boolean;
} {
  const granted = modules.filter((m) => m.state === "granted").map((m) => m.id);
  const enabled = new Set(granted);
  return {
    enabled,
    agendaVisible: enabled.has("agenda"),
    peopleVisible: enabled.has("people"),
  };
}

export interface PopupEnvelope<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: string;
}

export function unwrapPopupEnvelope<T>(
  response: PopupEnvelope<T> | undefined
): T {
  if (!response?.ok) throw new Error(response?.error ?? "Request failed.");
  return response.value as T;
}
