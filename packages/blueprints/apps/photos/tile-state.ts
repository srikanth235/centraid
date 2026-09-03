import type { InlineScope } from "../inline-types.ts";
import { isAudioAsset, isVideoAsset } from "./format.ts";
import { durationLabel, gridSrc } from "./media.ts";
import type { Asset } from "./types.ts";

export type TileMediaState = "pending" | "bytes" | "gateway" | "failed";

export function stateLine(state: TileMediaState): string | null {
  if (state === "gateway") return "on the gateway";
  if (state === "failed") return "could not decode";
  return null;
}

export function initialMediaState(asset: Asset): TileMediaState {
  return gridSrc(asset) == null ? "gateway" : "pending";
}

export interface TileVault {
  initial: string;
  label: string;
  hue: string;
}

const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/u;
const WHEEL = /^var\(--c-[a-z]+\)$/u;
const FALLBACK_HUE = "var(--app-identity)";

export function safeHue(color: unknown): string {
  if (typeof color !== "string") return FALLBACK_HUE;
  const trimmed = color.trim();
  return HEX.test(trimmed) || WHEEL.test(trimmed) ? trimmed : FALLBACK_HUE;
}

export function vaultMarker(scope: InlineScope | undefined): TileVault | null {
  if (!scope || scope.personal !== false) return null;
  const label = scope.label || "Vault";
  return {
    initial: [...label][0]?.toUpperCase() ?? "?",
    label,
    hue: safeHue(scope.color),
  };
}

export function kindLabel(asset: Asset): string | null {
  if (isLiveAsset(asset)) return "live";
  if (!isVideoAsset(asset) && !isAudioAsset(asset)) return null;
  return durationLabel(asset.duration_s);
}

export function isLiveAsset(asset: Asset): boolean {
  return (
    asset.kind === "live" ||
    String((asset as { source?: unknown }).source ?? "") === "live"
  );
}

export function showsKindSlot(rung: number): boolean {
  return rung >= 1;
}
export function showsVaultInitial(rung: number): boolean {
  return rung >= 2;
}
