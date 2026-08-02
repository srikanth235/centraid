// Product-wide accent preference for native surfaces.
//
// App-local colour knobs are identity only; this key mirrors the owner's
// product-wide ACCENT_PALETTE choice from the gateway prefs store. Native reads
// the generated concrete ramp for the selected key—there is no CSS variable or
// parser path in this module.

import { useSyncExternalStore } from "react";

import { ACCENT_PALETTE } from "@centraid/design";
import type { AccentKey } from "@centraid/design";

import { apiHeaders, fetchJson, requireGatewayBase } from "../../lib/gateway";
import { Store } from "../../storage";

const KEY = "settings.productAccent";
const DEFAULT: AccentKey = "teal";
const listeners = new Set<() => void>();

function isAccentKey(value: unknown): value is AccentKey {
  return typeof value === "string" && value in ACCENT_PALETTE;
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function getAccent(): AccentKey {
  const value = Store.get<unknown>(KEY, DEFAULT);
  return isAccentKey(value) ? value : DEFAULT;
}

export async function hydrateAccent(): Promise<AccentKey> {
  await Store.hydrate<AccentKey>(KEY, DEFAULT);
  try {
    const base = await requireGatewayBase();
    const body = await fetchJson<{ prefs?: Record<string, unknown> }>(
      `${base}/_centraid-user/prefs`,
      { headers: apiHeaders(), method: "GET" }
    );
    const remote = body.prefs ?? {};
    const key = isAccentKey(remote.accentKey)
      ? remote.accentKey
      : isAccentKey(remote.accent)
        ? remote.accent
        : undefined;
    if (key) Store.set(KEY, key);
  } catch {
    // The cached accent remains authoritative while the gateway is offline.
  }
  emit();
  return getAccent();
}

export function setAccent(value: AccentKey): void {
  Store.set(KEY, value);
  emit();
}

export function subscribeAccent(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAccent(): AccentKey {
  return useSyncExternalStore(subscribeAccent, getAccent, getAccent);
}
