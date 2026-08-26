// The tile's four overlay slots — selection, vault, kind, state — and nothing
// else (§4.4). A fifth slot is chrome inside the grid, which §18 forbids.

import { photosPurgeNote } from "@centraid/blueprints/apps/photos/shared-copy";

import type { Rung } from "./photos-rungs";
import type { PhotoAsset } from "./timeline-model";

export interface VaultFacts {
  vaultId: string;
  /** DISPLAY ONLY. Never the marker's trigger. */
  label: string;
  /** Straight off the vault record (§H). There is no vault "kind" — where a
   *  share goes is a pointer the member owns, not a property of a vault. */
  personal: boolean;
  color?: string;
}

// ── Slot 2: vault ──────────────────────────────────────────────────────────
//
// A 2px rule in the vault's hue on the LEADING edge, plus the initial in mono
// from rung M. It fires for any vault but the member's own, shared included
// (§H) — the question is "is this only mine?".
//
// Derived from `personal`, NEVER from `label`: renaming the shared vault must
// not lose the marker, and naming your own "Sharing" must not gain one.

/** The rule itself draws at every rung; only the INITIAL waits for M. */
export const VAULT_INITIAL_MIN_RUNG: Rung = 2; // M

export interface VaultMark {
  hue: string;
  /** Shown from rung M up; `undefined` below it. */
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
  // The name is read only AFTER the record has decided the marker fires.
  const initial = facts.label.trim().slice(0, 1).toUpperCase();
  return rung >= VAULT_INITIAL_MIN_RUNG && initial ? { hue, initial } : { hue };
}

// ── Slot 3: kind ───────────────────────────────────────────────────────────
//
// Video duration or `live`, in mono, bottom/trailing. From rung S up: §18 puts
// the floor at 11px rather than shrinking the type.

export const KIND_MIN_RUNG: Rung = 1; // S

/** `1:04`, `12:07`, `1:02:03` — tabular mono, so a column of them lines up. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function kindOverlay(asset: PhotoAsset, rung: Rung): string | undefined {
  if (rung < KIND_MIN_RUNG) return undefined;
  // A Live Photo says `live`, not a duration — that is not what a member is
  // choosing by.
  if (asset.liveVideoUri) return "live";
  if (asset.kind !== "video") return undefined;
  return asset.durationS === undefined
    ? undefined
    : formatDuration(asset.durationS);
}

// ── Slot 4: state ──────────────────────────────────────────────────────────
//
// ONE slot, two registers, never both at once: a MARK for custody, or a LINE of
// mono. Never a fill, never a red dot, never a vanishing tile (§14).
//
// THE CUSTODY TRIPLE COLLAPSES TO A BINARY HERE: `local-only` takes the mark,
// the other two say nothing. Annotating the steady state is a mark that fires
// on everything — no information, one line of type per photograph, the
// chrome-inside-the-grid §18 forbids. So does the web tile (`media.ts`).

/** Copy is final (§4.4). About THIS tile's own bytes, which is the whole bar
 *  for entry into this slot. */
export const STATE_COULD_NOT_DECODE = "could not decode";

/** Below S a 13px stroke glyph is mush; §18 puts the floor at legibility rather
 *  than shrinking the mark. */
export const CUSTODY_MIN_RUNG: Rung = 1; // S

/** Deliberately the shape hundreds of millions of people already know — an
 *  unlabelled glyph earns its silence by being familiar, not clever. */
export const CUSTODY_ICON = "CloudOff";

/** The glyph is decorative by the icon contract (DESIGN.md:449), so the meaning
 *  reaches a screen reader through the tile's own label instead. */
export const CUSTODY_LABEL = "not backed up";

/** Days from now, never negative, rounded UP so hours left still read as a day;
 *  `undefined` when the date is missing or unreadable, because an invented
 *  countdown is worse than none. Mirrors the web's `queries/library.ts`. */
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

/**
 * AT MOST ONE of two forms — the exclusion is the design decision made
 * structural, so a line and a mark cannot collide at the tile's foot and the
 * handoff's one-note-per-tile shape (proto:4004-4020) survives. It is also
 * right on the merits: every case producing a LINE is one where custody is not
 * the actionable fact.
 */
export type StateOverlay =
  | {
      form: "line";
      text: string;
      /**
       * `net` takes the `--net` role for the text AND a 1px `--net` border;
       * `seam` takes `--seam` for the text alone; `normal` is one quiet mono
       * line on the page colour.
       *
       * `seam` is the expiring register (#765) — "not yet, and not wrong" — so
       * a purge countdown never borrows `--net` and paints a shelf of ordinary
       * trashed photographs as an alarm.
       */
      tone: "normal" | "net" | "seam";
    }
  | { form: "custody" };

/** Holds nothing AMBIENT: a fact equally true of every tile on screen belongs
 *  to the screen, not to forty tiles. Defaults to false — a surface with no
 *  signal must not invent one. */
export interface StateContext {
  /** This tile's own bytes failed to decode — terminal, and about the tile. */
  decodeFailed?: boolean;
}

export function stateOverlay(
  asset: PhotoAsset,
  rung: Rung,
  context: StateContext = {}
): StateOverlay | undefined {
  // A terminal failure outranks everything.
  if (context.decodeFailed) {
    return { form: "line", text: STATE_COULD_NOT_DECODE, tone: "net" };
  }
  // On its way out outranks custody: where the bytes live matters less than how
  // long they will be anywhere at all.
  const days = purgeInDays(asset.purgeAt);
  if (days !== undefined) {
    return { form: "line", text: purgeNote(days), tone: "seam" };
  }
  // NO `on the gateway` LINE: an unreachable gateway is one ambient fact, and a
  // per-tile slot would print it forty times. The replica bar states it once.
  //
  // The mark means bytes are HERE and nowhere else — the one custody state a
  // member can lose something to. `queued`/`uploading` fall through to nothing
  // on purpose: a mark that blinks off as a drain walks the grid is chrome.
  if (rung >= CUSTODY_MIN_RUNG && asset.backupState === "local-only") {
    return { form: "custody" };
  }
  return undefined;
}

// ── Slot 1: selection ──────────────────────────────────────────────────────

/** 20px circle, top/trailing, 6px in (§4.4). */
export const SELECTION_DOT = 20;
export const SELECTION_INSET = 6;
/** RN has no `outline`, so this is drawn as a border on a sibling overhanging
 *  the tile by exactly this much — same pixels, same geometry. */
export const SELECTION_OUTLINE = 2;

// ── Geometry ───────────────────────────────────────────────────────────────

// A tile's box is known BEFORE its bytes arrive (§14) and kept through a
// terminal failure, so nothing reflows: skeleton, photograph and failed tile
// are one rectangle, packed by `justify.ts`.

/** `--skel`, never `--bg-elev`: that reads as a card, and an absence is not a
 *  card (§B). */
export function tileGround(
  hasBytes: boolean,
  skel: string,
  loaded: string
): string {
  return hasBytes ? loaded : skel;
}
