/**
 * Popup pure helpers (issue #545 C10) — error text and module availability
 * without DOM wiring. `popup-state.ts` already owns paused/blocking strings.
 */

import type { CompanionModule, ModuleStatus } from "./types.js";

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Map module statuses to which capture buttons are enabled / visible. */
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

/** Message envelope from chrome.runtime.sendMessage (owned here for popup). */
export interface PopupEnvelope<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: string;
}

/** Envelope unwrap for popup send() — same contract as content-core. */
export function unwrapPopupEnvelope<T>(
  response: PopupEnvelope<T> | undefined
): T {
  if (!response?.ok) throw new Error(response?.error ?? "Request failed.");
  return response.value as T;
}
