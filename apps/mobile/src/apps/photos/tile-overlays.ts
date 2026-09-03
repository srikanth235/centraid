import { mediaClock } from "@centraid/blueprints/apps/_shared/format-kit";
import { photosPurgeNote } from "@centraid/blueprints/apps/photos/shared-copy";

import type { Rung } from "./photos-rungs";
import type { PhotoAsset } from "./timeline-model";

export interface VaultFacts {
  vaultId: string;
  label: string;
  personal: boolean;
  color?: string;
}

export const VAULT_INITIAL_MIN_RUNG: Rung = 2; // M

export interface VaultMark {
  hue: string;
  initial?: string;
}

export function marksVault(personal: boolean): boolean {
  return !personal;
}

export function vaultMarkFor(
  asset: PhotoAsset,
  vaults: ReadonlyMap<string, VaultFacts>,
  rung: Rung,
  fallbackHue: string
): VaultMark | undefined {
  const facts = asset.sourceVaultId
    ? vaults.get(asset.sourceVaultId)
    : undefined;
  if (!facts || !marksVault(facts.personal)) return undefined;
  const hue = facts.color ?? fallbackHue;
  const initial = facts.label.trim().slice(0, 1).toUpperCase();
  return rung >= VAULT_INITIAL_MIN_RUNG && initial ? { hue, initial } : { hue };
}

export const KIND_MIN_RUNG: Rung = 1; // S

export { mediaClock as formatDuration } from "@centraid/blueprints/apps/_shared/format-kit";

export function kindOverlay(asset: PhotoAsset, rung: Rung): string | undefined {
  if (rung < KIND_MIN_RUNG) return undefined;
  if (asset.liveVideoUri) return "live";
  if (asset.kind !== "video") return undefined;
  return asset.durationS === undefined
    ? undefined
    : mediaClock(asset.durationS);
}

export const STATE_COULD_NOT_DECODE = "could not decode";

export const CUSTODY_MIN_RUNG: Rung = 1; // S

export const CUSTODY_ICON = "CloudOff";

export const CUSTODY_LABEL = "not backed up";

export function purgeInDays(
  purgeAt: string | undefined,
  now: number = Date.now()
): number | undefined {
  if (!purgeAt) return undefined;
  const ms = Date.parse(purgeAt) - now;
  if (Number.isNaN(ms)) return undefined;
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

export function purgeNote(days: number): string {
  return photosPurgeNote(days);
}

export type StateOverlay =
  | {
      form: "line";
      text: string;
      tone: "normal" | "net" | "seam";
    }
  | { form: "custody" };

export interface StateContext {
  decodeFailed?: boolean;
}

export function stateOverlay(
  asset: PhotoAsset,
  rung: Rung,
  context: StateContext = {}
): StateOverlay | undefined {
  if (context.decodeFailed) {
    return { form: "line", text: STATE_COULD_NOT_DECODE, tone: "net" };
  }
  const days = purgeInDays(asset.purgeAt);
  if (days !== undefined) {
    return { form: "line", text: purgeNote(days), tone: "seam" };
  }
  if (rung >= CUSTODY_MIN_RUNG && asset.backupState === "local-only") {
    return { form: "custody" };
  }
  return undefined;
}

export const SELECTION_DOT = 20;
export const SELECTION_INSET = 6;

export const SELECTION_OUTLINE = 2;

export function tileGround(
  hasBytes: boolean,
  skel: string,
  loaded: string
): string {
  return hasBytes ? loaded : skel;
}
