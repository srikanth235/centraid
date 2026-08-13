// The tile's four overlay slots — selection, vault, kind, state — and nothing
// else (Photos v4 handoff §4.4). Pure, so each rule can be asserted directly.
//
// The tile is a content-led surface with no chrome. Everything a photograph
// has to say about itself says it in one of these four slots; anything that
// wants a fifth slot is asking for chrome inside the grid, which §18 forbids.

import type { Rung } from "./photos-rungs";
import type { PhotoAsset } from "./timeline-model";

/** What Photos needs to know about one vault to mark a tile from it. */
export interface VaultFacts {
  vaultId: string;
  /** The vault's own name — DISPLAY ONLY. Never the marker's trigger. */
  label: string;
  /** The founding marker, straight off the vault record (handoff §H): is this
   *  the member's OWN vault? There is no vault "kind" — where a share GOES is
   *  a pointer the member owns, not a property of any vault. */
  personal: boolean;
  /** The vault's hue, when the registry carried one. */
  color?: string;
}

// ── Slot 2: vault ──────────────────────────────────────────────────────────
//
// A 2px rule in the vault's hue on the tile's LEADING edge, plus the vault
// initial in mono at rungs M and L. It fires for ANY vault but the member's
// own, the shared one included (§H): their own photographs are the unmarked
// default, and the question the marker answers is "is this only mine?".
//
// Derived from `personal`, NEVER from `label`. A member who renames the shared
// vault to "Holiday pics" must not lose the marker, and a member who names
// their own vault "Sharing" must not gain one.

/** The rung from which the vault INITIAL is drawn. The rule itself is drawn at
 *  every rung — a 2px edge costs nothing and the question it answers does not
 *  get less important on a small tile. */
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
  // The initial is display, so it comes from the name — but only ever AFTER
  // the record has already decided the marker fires.
  const initial = facts.label.trim().slice(0, 1).toUpperCase();
  return rung >= VAULT_INITIAL_MIN_RUNG && initial ? { hue, initial } : { hue };
}

// ── Slot 3: kind ───────────────────────────────────────────────────────────
//
// Video duration or `live`, in mono, bottom/trailing. From rung S up — below
// that the tile is too small for a legible 11px line, and §18 puts the floor
// at 11px rather than shrinking the type.

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
  // A Live Photo is a still with a paired movie; it says `live`, not a
  // duration, because its duration is not what the member is choosing by.
  if (asset.liveVideoUri) return "live";
  if (asset.kind !== "video") return undefined;
  return asset.durationS === undefined
    ? undefined
    : formatDuration(asset.durationS);
}

// ── Slot 4: state ──────────────────────────────────────────────────────────
//
// ONE slot, two registers, and never both at once: a MARK for custody, or a
// LINE of mono for the things that are genuinely sentences. Never a fill,
// never a red dot, never a vanishing tile — a tile that disappears when
// something goes wrong is the grey mosaic §14 calls a bug.
//
// WHY A MARK AND NOT A LINE. This slot used to narrate the whole custody
// triple: `on the gateway` for `remote-only`, `on this device only` for
// `local-only`. Both are true, and captioning them was still wrong, for the
// reason Apple Photos and Google Photos independently arrived at — neither
// annotates the NORMAL case, and neither spends words on a tile:
//
//   - Apple draws nothing at all. An optimized photograph whose original is in
//     iCloud is pixel-identical to one held locally; custody is a library-wide
//     setting plus a footer status line, and the exception surfaces at the
//     moment of use, as a fetch.
//   - Google marks only what is NOT backed up, with the cloud-slash glyph, and
//     puts the running status in one global chip. Backed-up photographs are
//     unmarked, because that is the norm.
//
// Against that, our old model labelled the steady state (`on the gateway` IS
// where bytes are designed to live) and labelled the default (in a fresh
// camera roll EVERY photograph is `local-only`), in prose, under every tile.
// A mark that fires on everything carries no information and costs a line of
// type per photograph — which is the chrome-inside-the-grid §18 forbids,
// arrived at from the inside.
//
// So the triple survives as a DATA model and collapses to a binary at the
// tile: `local-only` takes the mark, and the other two say nothing. The web
// tile has always worked this way (`packages/blueprints/apps/photos/media.ts`
// draws its note only when there are no bytes to paint), so this brings the
// phone into line with the surface it drifted from rather than inventing a
// third grammar.

/** Copy is final (§4.4). The only string the state slot still owns besides
 *  Trash's countdown, and it is about THIS tile's own bytes — which is the
 *  whole bar for entry into this slot. (`on the gateway` used to live here for
 *  an unreachable gateway; see `stateOverlay` for why it is gone.) */
export const STATE_COULD_NOT_DECODE = "could not decode";

/** The rung from which the custody mark is drawn. Below S a 13px stroke glyph
 *  is mush — Google hides its badge at the tightest zoom for the same reason —
 *  and §18 puts the floor at legibility rather than shrinking the mark. */
export const CUSTODY_MIN_RUNG: Rung = 1; // S

/** The registry key for the custody mark: a cloud with a diagonal slash
 *  (`packages/design/src/icons.ts`). Deliberately the shape hundreds of
 *  millions of people have already learned — an unlabelled glyph earns its
 *  silence by being familiar, not by being clever. */
export const CUSTODY_ICON = "CloudOff";

/** What the mark contributes to the TILE's accessibility label. The glyph
 *  itself is decorative by the icon contract (DESIGN.md:449), so the meaning
 *  has to reach a screen reader through the control that owns it. */
export const CUSTODY_LABEL = "not backed up";

/**
 * Trash's per-item countdown, in this same slot (proto:4446-4449, §5). The
 * shelf's head already says the policy once ("purged 30 days after
 * deletion"); the tile says what it means for THIS photograph, which is the
 * only form of that fact a member can act on.
 *
 * The derivation mirrors the web's, in
 * `packages/blueprints/apps/photos/queries/library.ts`: days from now, never
 * negative, rounded UP so a photograph with hours left still reads as a day —
 * and `undefined` when the date is missing or unreadable, because an invented
 * countdown is worse than none.
 */
export function purgeInDays(
  purgeAt: string | undefined,
  now: number = Date.now()
): number | undefined {
  if (!purgeAt) return undefined;
  const ms = Date.parse(purgeAt) - now;
  if (Number.isNaN(ms)) return undefined;
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

/** The countdown, worded exactly as the web's Timeline words it. */
export function purgeNote(days: number): string {
  if (days === 0) return "purges today";
  return `purges in ${days} ${days === 1 ? "day" : "days"}`;
}

/**
 * What slot 4 resolves to — AT MOST ONE of two forms, which is the design
 * decision made structural. A line and a mark cannot both be returned, so they
 * cannot collide at the tile's foot, and the handoff's one-note-per-tile shape
 * (proto:4004-4020, a single `note` string) survives intact.
 *
 * The exclusion is also correct on the merits rather than merely convenient:
 * every case that produces a LINE is one where custody is not the actionable
 * fact. A tile that will not decode, a photograph three days from purge, and a
 * grid greyed out by an unreachable gateway are each more urgent than "this
 * one is not backed up yet".
 */
export type StateOverlay =
  | {
      form: "line";
      text: string;
      /**
       * `net` takes the `--net` role for the text AND a 1px `--net` border on
       * the tile; `seam` takes the `--seam` role for the text alone; `normal`
       * is one quiet mono line on the page colour.
       *
       * `seam` is the expiring register (issue #765). The design system names
       * the role for precisely this — "not yet, and not wrong: pending,
       * expiring, invited" — which is what a purge countdown is: nothing has
       * failed, and something is going to happen. It is the reason the
       * countdown never had to borrow `--net` and paint a shelf of ordinary
       * trashed photographs as an alarm.
       */
      tone: "normal" | "net" | "seam";
    }
  | { form: "custody" };

/** What the tile knows beyond its own record. Deliberately holds nothing
 *  AMBIENT: a fact equally true of every tile on screen belongs to the
 *  screen, not to forty tiles. Defaults to false — a surface with no signal
 *  must not invent one. */
export interface StateContext {
  /** This tile's own bytes failed to decode — terminal, and about the tile. */
  decodeFailed?: boolean;
}

export function stateOverlay(
  asset: PhotoAsset,
  rung: Rung,
  context: StateContext = {}
): StateOverlay | undefined {
  // A terminal failure outranks everything: the member needs to know the tile
  // will not resolve, not where its bytes live.
  if (context.decodeFailed) {
    return { form: "line", text: STATE_COULD_NOT_DECODE, tone: "net" };
  }
  // A photograph on its way out outranks custody: where its bytes live matters
  // less than how long they will be anywhere at all.
  const days = purgeInDays(asset.purgeAt);
  if (days !== undefined) {
    return { form: "line", text: purgeNote(days), tone: "seam" };
  }
  // NO `on the gateway` LINE. It used to render on every `remote-only` tile
  // whenever the gateway stopped answering — an ambient condition (one fact
  // about the whole app) printed through a per-tile slot, so a screenful said
  // the same sentence forty times. Forty copies of one sentence is not an
  // explanation, it is wallpaper. The replica bar states it once, at the top,
  // where an ambient fact belongs; this slot speaks only for THIS tile.
  // The mark: bytes are HERE and nowhere else. The mobile seat is an origin,
  // so this is the one custody state a member can lose something to — and the
  // only one worth marking, because the other two are the norm.
  //
  // `queued`/`uploading` deliberately fall through to nothing. They are the
  // seconds between two custody states, and a mark that blinks off tile by
  // tile as a drain walks the grid is chrome, not information.
  if (rung >= CUSTODY_MIN_RUNG && asset.backupState === "local-only") {
    return { form: "custody" };
  }
  return undefined;
}

// ── Slot 1: selection ──────────────────────────────────────────────────────

/** 20px circle, top/trailing, 6px in (§4.4). */
export const SELECTION_DOT = 20;
export const SELECTION_INSET = 6;
/** The selected tile takes a 2px ink outline at -2px offset. RN has no
 *  `outline`, so this is drawn as a border on a sibling that overhangs the
 *  tile by exactly this much — same pixels, same geometry. */
export const SELECTION_OUTLINE = 2;

// ── Geometry ───────────────────────────────────────────────────────────────

// A tile's box is known BEFORE its bytes arrive (§14) and kept through a
// terminal failure — the whole reason nothing reflows: the skeleton, the
// decoded photograph and the failed tile are the same rectangle, so the only
// thing that ever changes is what is painted inside it. The rectangle itself
// is packed by justify.ts; no type here needs to restate it.

/** The ground a tile paints before its bytes arrive: `--skel` at the exact
 *  geometry the photograph will occupy. `--bg-elev` reads as a card, and an
 *  absence is not a card (§B). */
export function tileGround(
  hasBytes: boolean,
  skel: string,
  loaded: string
): string {
  return hasBytes ? loaded : skel;
}
