// governance: allow-repo-hygiene file-size-limit — the normative role table and its profile totality checks are intentionally co-located so every role name, meaning, contrast obligation, and lowering remains reviewable as one contract.
// Product-grammar role registry — the Binding Layer.
//
// A token is a role only when its name, meaning, contrast obligation, and
// lowering are known together.  Emitters consume this registry; they do not
// create semantic names while rendering CSS or native objects.  `by` is
// intentionally total so an unsupported profile is an explicit decision with
// a reason instead of an accidental missing key.
//
// Two things changed in the Binding Layer flip and neither is cosmetic:
//
//   • The `--accent*` family survives as NAMES and resolves to INK. There is
//     no product hue. Nothing in the shell spends colour, which is what makes
//     an app's identity hue mean "this belongs to that app".
//   • Three hues are reserved and named: `--link` (prose links + selection),
//     `--focus-ring-color` (the ring), and `--net` ("this leaves the device").
//     `--net` is a BORDER and a 2px rule; it is never a fill, and its role
//     `meaning` says so because that is the only place the rule can live.

import { DENSITY_TIERS, metrics, spacing } from "./density";
import { radii } from "./radii";
import {
  darkTheme,
  lightTheme,
  ON_STAGE,
  ON_STAGE_SOFT,
  STAGE,
  STAGE_LINE,
  STAGE_SUNKEN,
  SURFACE_TONE_NAMES,
  SURFACE_TONES,
} from "./themes";
import { fontStacks, type, typeKeyToKebab } from "./typography";

export type Profile = "blueprint" | "native" | "shell";
export type Surface = "BI" | "BS" | "MO" | "SH" | "SH-c";
export type RoleCategory =
  | "color"
  | "component"
  | "font"
  | "motion"
  | "radius"
  | "spacing"
  | "type";
export type RoleValueKind =
  | "literal"
  | "scalar"
  | "solved"
  | "unsupported"
  | "wash";

export interface ProfileValue {
  kind: RoleValueKind;
  value?: string | number;
  reason?: string;
}

export interface RoleDef {
  css: `--${string}`;
  category: RoleCategory;
  meaning: string;
  contrast: string;
  floor?: number;
  surfaces: readonly Surface[];
  by: Record<Profile, ProfileValue>;
}

const allSurfaces: readonly Surface[] = ["SH", "SH-c", "BI", "BS", "MO"];
const shellAndNative: readonly Surface[] = ["SH", "SH-c", "MO"];
const blueprintSurfaces: readonly Surface[] = ["BI", "BS"];

const literal = (value: string | number): ProfileValue => ({
  kind: "literal",
  value,
});
const solved = (value: string | number): ProfileValue => ({
  kind: "solved",
  value,
});
const wash = (value: string): ProfileValue => ({ kind: "wash", value });
const scalar = (value: string | number): ProfileValue => ({
  kind: "scalar",
  value,
});
const unsupported = (reason: string): ProfileValue => ({
  kind: "unsupported",
  reason,
});

function role(
  css: `--${string}`,
  category: RoleCategory,
  meaning: string,
  contrast: string,
  surfaces: readonly Surface[],
  values: Record<Profile, ProfileValue>,
  floor?: number
): RoleDef {
  return { by: values, category, contrast, css, floor, meaning, surfaces };
}

/** Every surface shares one value, in every profile. The Binding Layer's ink
 *  ramp and hairlines are literal hexes now, so this is the common case. */
const everywhere = (value: string | number): Record<Profile, ProfileValue> => ({
  blueprint: literal(value),
  native: literal(value),
  shell: literal(value),
});

const roleTable: RoleDef[] = [
  role(
    "--accent",
    "color",
    "The action colour, which is ink: the product spends no hue, so an app identity hue is the only colour on screen.",
    "filled controls publish --text-inv; text uses --accent-text",
    allSurfaces,
    everywhere(lightTheme.accent)
  ),
  role(
    "--accent-deep",
    "color",
    "The ink AS A FILL — the one filled action per view.",
    "paired with --text-inv when it becomes a fill",
    allSurfaces,
    everywhere(lightTheme.accentDeep),
    4.5
  ),
  role(
    "--accent-light",
    "color",
    "Ink stepped one rung toward the paper, for restrained emphasis.",
    "non-text separation or large-text use only",
    allSurfaces,
    everywhere(lightTheme.accentLight),
    3
  ),
  role(
    "--accent-text",
    "color",
    "The ink as text; the name exists so a surface never reaches for a fill role to colour type.",
    "AA text on the hardest surface in each profile",
    allSurfaces,
    everywhere(lightTheme.accentText),
    4.5
  ),
  role(
    "--accent-soft",
    "color",
    "A low-alpha ink wash for hover ground and quiet emphasis; selection uses --bg-sel, which is the reserved link hue.",
    "perceptible separation from the containing surface; never the only signal",
    allSurfaces,
    {
      blueprint: wash("color-mix(in oklab, var(--accent) 8%, transparent)"),
      native: wash("rgba(20,20,20,.08)"),
      shell: wash("color-mix(in oklab, var(--accent) 8%, transparent)"),
    }
  ),
  role(
    "--accent-fill",
    "color",
    "The one ink-filled action surface allowed per viewport.",
    "--text-inv on the fill",
    allSurfaces,
    everywhere(lightTheme.accentDeep),
    4.5
  ),
  role(
    "--accent-deep-hover",
    "color",
    "The ink fill under hover/press, stepped further from the ink it carries so a hover can never reduce the label's contrast.",
    "--text-inv on the fill",
    allSurfaces,
    everywhere(lightTheme.accentHover),
    4.5
  ),
  role(
    "--net",
    "color",
    "This leaves the device. A BORDER or a 2px rule only — never a fill, because nothing alarming is ever a large filled surface.",
    "AA as text and 3:1 as a rule on every surface it can land on",
    allSurfaces,
    everywhere(lightTheme.net),
    4.5
  ),
  role(
    "--link",
    "color",
    "The one reserved hue: prose links and text selection. Never permitted on a control.",
    "AA as text on every surface it can land on",
    allSurfaces,
    everywhere(lightTheme.link),
    4.5
  ),
  role(
    "--stage",
    "color",
    "The opaque media ground for a viewer, a slideshow and an editor. Full-bleed near-black, the SAME literal in both themes — the media ground does not follow the theme.",
    "--on-stage clears AA text on it in both themes",
    allSurfaces,
    everywhere(STAGE),
    4.5
  ),
  role(
    "--on-stage",
    "color",
    "Ink published on the stage — the one ink rung that does not flip with the theme, because the surface under it does not either.",
    "AA against --stage in both themes",
    allSurfaces,
    everywhere(ON_STAGE),
    4.5
  ),
  role(
    "--on-stage-soft",
    "color",
    "The SOFT ink rung on the stage — capture lines, the stage's status line, filmstrip labels. One literal in both themes, because the ground under it is one literal in both themes: `--text-soft` follows the PAGE and is 2.85:1 on the stage in light mode.",
    "AA against --stage in both themes",
    allSurfaces,
    everywhere(ON_STAGE_SOFT),
    4.5
  ),
  role(
    "--stage-line",
    "color",
    "The hairline between chrome and media ON the stage. `--line` is invisible against the stage, so the stage owns its own boundary rung.",
    "decorative separation on the stage; never the only signal that a control exists",
    allSurfaces,
    everywhere(STAGE_LINE)
  ),
  role(
    "--stage-sunken",
    "color",
    "The recess cut INTO the stage — the media transport's unplayed track, and any other trough whose filled part is --on-stage. `--bg-sunken` follows the PAGE and would punch a near-white hole in the media ground; `--stage-line` is tuned to be SEEN as an edge, where a trough is tuned to recede under its fill.",
    "decorative recess on the stage; never carries text",
    allSurfaces,
    everywhere(STAGE_SUNKEN)
  ),
  role(
    "--skel",
    "color",
    "The ground a tile paints before its bytes arrive. `--bg-elev` reads as a card; an absence is not a card.",
    "decorative placeholder surface; never carries text",
    allSurfaces,
    everywhere(lightTheme.skel)
  ),
  role(
    "--bg-chrome",
    "color",
    "The navigation stem and persistent host chrome. Never themed by an app.",
    "content is measured on the chrome surface",
    shellAndNative,
    {
      blueprint: unsupported("Blueprint content does not own host chrome."),
      native: literal(lightTheme.sidebarBg),
      shell: literal(lightTheme.sidebarBg),
    }
  ),
  role(
    "--bg",
    "color",
    "The page. The one surface role an app retunes, by declaring a surface tone.",
    "all text roles must clear their declared floor",
    allSurfaces,
    everywhere(lightTheme.bg)
  ),
  role(
    "--bg-app",
    "color",
    "The wall behind the frame — the deepest paper the system paints.",
    "decorative surface only",
    shellAndNative,
    {
      blueprint: unsupported("Blueprint content has no detached app backing."),
      native: unsupported("Native colors expose one concrete background role."),
      shell: literal(lightTheme.bgApp),
    }
  ),
  role(
    "--bg-elev",
    "color",
    "Raised paper: tiles, cards, the today cell, the hover ground. Darker than the page in light, lighter in dark — a sheet laid on the page, not a plane above it.",
    "line and text contrast are measured on the raised surface",
    allSurfaces,
    everywhere(lightTheme.bgElev)
  ),
  role(
    "--bg-sunken",
    "color",
    "Recessed surface for tracks and quiet metadata.",
    "faint text and status washes are measured here",
    allSurfaces,
    everywhere(lightTheme.bgSunken)
  ),
  role(
    "--bg-hover",
    "color",
    "Hover ground for a quiet control or row.",
    "perceptible separation from the containing surface; never the only signal",
    allSurfaces,
    {
      blueprint: wash("color-mix(in oklab, var(--text) 5%, transparent)"),
      native: literal("#f1f1f0"),
      shell: wash("color-mix(in oklab, var(--text) 5%, transparent)"),
    }
  ),
  role(
    "--bg-press",
    "color",
    "Pressed surface for a control or row.",
    "perceptible separation from the containing surface; never the only signal",
    allSurfaces,
    {
      blueprint: wash("color-mix(in oklab, var(--text) 9%, transparent)"),
      native: literal("#e8e8e7"),
      shell: wash("color-mix(in oklab, var(--text) 9%, transparent)"),
    }
  ),
  role(
    "--bg-sel",
    "color",
    "Selected surface — a wash of the reserved link hue, which is the one hue text selection is allowed to spend.",
    "perceptible separation from the containing surface; never the only signal",
    allSurfaces,
    {
      blueprint: wash("color-mix(in oklab, var(--link) 12%, transparent)"),
      native: wash("rgba(45,75,168,.12)"),
      shell: wash("color-mix(in oklab, var(--link) 12%, transparent)"),
    }
  ),
  role(
    "--bg-hud",
    "color",
    "Detached host chrome surface for transient controls.",
    "content text is measured on the HUD surface",
    shellAndNative,
    {
      blueprint: unsupported("Blueprint content has no detached HUD."),
      native: unsupported(
        "Native surfaces do not expose detached host HUD chrome."
      ),
      shell: literal("rgba(253,253,252,.94)"),
    }
  ),
  role(
    "--bg-wall",
    "color",
    "Outer wall behind detached chrome and the device frame.",
    "decorative; never carries body text",
    shellAndNative,
    {
      blueprint: unsupported("Blueprint apps do not own the host wall."),
      native: unsupported("Native surfaces do not own the detached host wall."),
      shell: literal(lightTheme.bgWall),
    }
  ),
  ...SURFACE_TONE_NAMES.map((tone) =>
    role(
      `--bg-tone-${tone}` as `--${string}`,
      "color",
      `The ${tone} surface tone. An app declares one and it retunes --bg only; the raised paper, hairlines and ink stay invariant, which is what keeps differently-toned apps one product.`,
      "every ink role clears its floor on the deepest tone",
      allSurfaces,
      everywhere(SURFACE_TONES[tone].light)
    )
  ),
  role(
    "--text",
    "color",
    "Primary content ink.",
    "body text AA on every surface tone",
    allSurfaces,
    everywhere(lightTheme.text),
    4.5
  ),
  role(
    "--text-soft",
    "color",
    "Secondary content ink for supporting prose and inactive navigation labels; navigation never falls to the tertiary rung.",
    "small text AA on every surface tone",
    allSurfaces,
    everywhere(lightTheme.textSoft),
    4.5
  ),
  role(
    "--text-faint",
    "color",
    "Metadata ink and quiet labels.",
    "small text AA on the deepest surface tone, not merely on --bg",
    allSurfaces,
    everywhere(lightTheme.textFaint),
    4.5
  ),
  role(
    "--text-ghost",
    "color",
    "Placeholders and unavailable glyphs; a recessive state takes this token on the LEAF element rather than an opacity on its container.",
    "non-text 3:1 where it is an icon/border; body use is forbidden",
    allSurfaces,
    everywhere(lightTheme.textGhost),
    3
  ),
  role(
    "--text-disabled",
    "color",
    "Disabled text ink; it is not opacity-stacked with --o-disabled.",
    "WCAG 1.4.3 exempts inactive controls; the obligation is that disabled is never colour-only",
    allSurfaces,
    everywhere(lightTheme.textDisabled)
  ),
  role(
    "--text-inv",
    "color",
    "Ink on a filled ink control — the page colour, not pure white.",
    "AA against the fill it is paired with",
    allSurfaces,
    everywhere(lightTheme.textInv),
    4.5
  ),
  role(
    "--on-accent",
    "color",
    "Ink published for saturated identity fills and media scrims, both of which stay dark in either theme.",
    "AA against the saturated fill or scrim it is paired with",
    allSurfaces,
    everywhere("#FDFDFC"),
    4.5
  ),
  role(
    "--line",
    "color",
    "Hairline separator — row rules and tile borders. The lighter of the two line rungs.",
    "decorative separation; never the only signal that a control exists",
    allSurfaces,
    everywhere(lightTheme.line)
  ),
  role(
    "--line-strong",
    "color",
    "The explicit boundary — control borders and section rules.",
    "paired with a label and a 34px hit area; never the only signal that a control exists",
    allSurfaces,
    everywhere(lightTheme.lineStrong)
  ),
  role(
    "--line-sel",
    "color",
    "Selected boundary paired with --bg-sel.",
    "perceptible boundary against the local surface",
    allSurfaces,
    {
      blueprint: literal("color-mix(in oklab, var(--link) 42%, var(--line))"),
      native: literal("rgba(45,75,168,.42)"),
      shell: literal("color-mix(in oklab, var(--link) 42%, var(--line))"),
    }
  ),
  role(
    "--focus-ring",
    "color",
    "The composed focus boundary: 2px of ring at a 2px offset, drawn with the page colour between so a focused FILLED ink button still shows a ring.",
    "3:1 non-text boundary against the local surface",
    allSurfaces,
    {
      blueprint: literal(
        "0 0 0 2px var(--bg), 0 0 0 4px var(--focus-ring-color)"
      ),
      native: literal(lightTheme.ring),
      shell: literal("0 0 0 2px var(--bg), 0 0 0 4px var(--focus-ring-color)"),
    },
    3
  ),
  role(
    "--focus-ring-color",
    "color",
    "The reserved focus hue; native uses the platform focus ring.",
    "3:1 non-text boundary against every surface tone",
    allSurfaces,
    everywhere(lightTheme.ring),
    3
  ),
  role(
    "--scrim",
    "color",
    "Veil behind a decision dialog, sheet, or media overlay.",
    "modal content is measured above the veil",
    allSurfaces,
    everywhere(lightTheme.scrim)
  ),
  role(
    "--shadow-sm",
    "color",
    "Small elevation cue for a detached control.",
    "decorative; does not replace a line",
    allSurfaces,
    everywhere(lightTheme.shadowSm)
  ),
  role(
    "--shadow-md",
    "color",
    "Medium elevation cue for panels and popovers.",
    "decorative; does not replace a line",
    allSurfaces,
    everywhere(lightTheme.shadowMd)
  ),
  role(
    "--shadow-lg",
    "color",
    "Large elevation cue for dialogs and sheets.",
    "decorative; does not replace a line",
    allSurfaces,
    everywhere(lightTheme.shadowLg)
  ),
  role(
    "--danger",
    "color",
    "Destructive and error status ink, solved from the same base as --net so a destructive action and a network egress read as one consequence. Outlined, never filled.",
    "small text AA on the status wash",
    allSurfaces,
    everywhere(lightTheme.danger),
    4.5
  ),
  role(
    "--success",
    "color",
    "Healthy, complete, or connected status ink.",
    "small text AA on the status wash",
    allSurfaces,
    everywhere(lightTheme.success),
    4.5
  ),
  role(
    "--warning",
    "color",
    "Cautionary or degraded status ink.",
    "small text AA on the status wash",
    allSurfaces,
    everywhere(lightTheme.warning),
    4.5
  ),
  role(
    "--h-control",
    "component",
    "Control height. Every button, field and select is exactly this tall; a density tier may never shrink it, because below 34px a control stops being reliably hittable.",
    "geometry only",
    allSurfaces,
    {
      blueprint: scalar(`${metrics.control}px`),
      native: scalar(metrics.control),
      shell: scalar(`${metrics.control}px`),
    }
  ),
  role(
    "--h-row",
    "component",
    "Row height at the comfortable tier; --density-row is what a row actually reads.",
    "geometry only",
    allSurfaces,
    {
      blueprint: scalar(`${metrics.row}px`),
      native: scalar(metrics.row),
      shell: scalar(`${metrics.row}px`),
    }
  ),
  role(
    "--h-segmented",
    "component",
    "Segmented-control height — the one control allowed under 34px, because its segments are not individually the primary target.",
    "geometry only",
    allSurfaces,
    {
      blueprint: scalar(`${metrics.segmented}px`),
      native: scalar(metrics.segmented),
      shell: scalar(`${metrics.segmented}px`),
    }
  ),
  role(
    "--w-stem",
    "component",
    "The navigation stem. Never themed by an app, never scrolls away, never changes width; under RTL it mirrors, so every rule that positions it uses logical properties.",
    "geometry only",
    shellAndNative,
    {
      blueprint: unsupported("Blueprint content never draws the host stem."),
      native: scalar(metrics.stem),
      shell: scalar(`${metrics.stem}px`),
    }
  ),
  role(
    "--density-row",
    "component",
    "The row height for the declared density tier. Tiers scale row height and content padding ONLY.",
    "geometry only",
    allSurfaces,
    {
      blueprint: scalar(`${DENSITY_TIERS.comfortable.row}px`),
      native: scalar(DENSITY_TIERS.comfortable.row),
      shell: scalar(`${DENSITY_TIERS.comfortable.row}px`),
    }
  ),
  role(
    "--density-pad",
    "component",
    "The content padding for the declared density tier.",
    "geometry only",
    allSurfaces,
    {
      blueprint: scalar(`${DENSITY_TIERS.comfortable.pad}px`),
      native: scalar(DENSITY_TIERS.comfortable.pad),
      shell: scalar(`${DENSITY_TIERS.comfortable.pad}px`),
    }
  ),
  role(
    "--dur-1",
    "motion",
    "State change — 140ms. A control answering a press or a hover.",
    "reduced-motion removes it in one global rule",
    allSurfaces,
    { blueprint: scalar("140ms"), native: scalar(140), shell: scalar("140ms") }
  ),
  role(
    "--dur-2",
    "motion",
    "Entry and settle — 280ms. Something arriving or coming to rest.",
    "reduced-motion removes it in one global rule",
    allSurfaces,
    { blueprint: scalar("280ms"), native: scalar(280), shell: scalar("280ms") }
  ),
  role(
    "--ease",
    "motion",
    "The state-change curve: quick out of the gate, decisive.",
    "reduced-motion removes it in one global rule",
    allSurfaces,
    {
      blueprint: literal("cubic-bezier(0.3, 0, 0.4, 1)"),
      native: literal("easeInOut"),
      shell: literal("cubic-bezier(0.3, 0, 0.4, 1)"),
    }
  ),
  role(
    "--ease-entry",
    "motion",
    "The entry/settle curve: fast start, long soft landing.",
    "reduced-motion removes it in one global rule",
    allSurfaces,
    {
      blueprint: literal("cubic-bezier(0.2, 0.7, 0.2, 1)"),
      native: literal("easeOut"),
      shell: literal("cubic-bezier(0.2, 0.7, 0.2, 1)"),
    }
  ),
  role(
    "--o-disabled",
    "motion",
    "Opacity applied to a disabled LEAF after semantics are conveyed; never to a container, because opacity composites every descendant and invalidates token-level contrast.",
    "disabled state is never color-only",
    allSurfaces,
    { blueprint: scalar(0.45), native: scalar(0.45), shell: scalar(0.45) }
  ),
  role(
    "--app-hue",
    "color",
    "The app's identity hue in degrees on the OKLCH wheel; 0 is the wheel origin an app inherits when it declares none.",
    "identity parameter; not an action color",
    blueprintSurfaces,
    {
      blueprint: literal("0"),
      native: unsupported("Native surfaces resolve identity hues to hex."),
      shell: unsupported("Shell chrome spends no hue at all."),
    }
  ),
  role(
    "--app-identity",
    "color",
    "The app's one identity colour, used in its icon chip and as a content marker. Never on a control, and never in the shell.",
    "decorative or identity text only; action contrast uses product roles",
    blueprintSurfaces,
    {
      blueprint: literal("var(--text)"),
      native: unsupported("Native app identity is lowered by the app catalog."),
      shell: unsupported(
        "Shell host identity is separate from blueprint content."
      ),
    }
  ),
  role(
    "--app-identity-text",
    "color",
    "The identity colour as type. An app that declares no identity renders in ink, which is the system default.",
    "identity text clears AA on its local surface",
    ["BI", "BS", "SH", "SH-c"],
    {
      blueprint: literal("var(--text)"),
      native: solved(lightTheme.text),
      shell: literal("var(--text)"),
    },
    4.5
  ),
];

const generatedScalarRoles: RoleDef[] = [
  ...Object.entries(radii).map(([key, value]) =>
    role(
      `--r-${key}` as `--${string}`,
      "radius",
      `Radius rung ${key}; components compose interaction shape from this rung.`,
      "shape only",
      allSurfaces,
      {
        blueprint: literal(`${value}px`),
        native: scalar(value),
        shell: literal(`${value}px`),
      }
    )
  ),
  ...Object.entries(spacing).map(([key, value]) =>
    role(
      `--sp-${key}` as `--${string}`,
      "spacing",
      `Spacing rung ${key}; no density-specific replacement is permitted.`,
      "layout only",
      allSurfaces,
      {
        blueprint: scalar(`${value}px`),
        native: scalar(value),
        shell: scalar(`${value}px`),
      }
    )
  ),
  ...Object.keys(fontStacks).map((key) =>
    role(
      `--font-${key}` as `--${string}`,
      "font",
      `The one ${key} face genus used by the type scale, with its mandatory CJK fallbacks.`,
      "text inherits the type role obligation",
      allSurfaces,
      {
        blueprint: literal(fontStacks[key as keyof typeof fontStacks]),
        native: literal(key),
        shell: literal(fontStacks[key as keyof typeof fontStacks]),
      }
    )
  ),
  ...Object.entries(type).map(([key, value]) =>
    role(
      `--t-${typeKeyToKebab(key)}` as `--${string}`,
      "type",
      `Semantic type role ${key}.`,
      "the role's declared text floor; nothing in the ramp falls below 11px",
      allSurfaces,
      {
        blueprint: literal(`var(--t-${typeKeyToKebab(key)})`),
        native: literal(
          `${value.size + value.nativeDelta.size}/${value.lineHeight + value.nativeDelta.lineHeight}`
        ),
        shell: literal(`var(--t-${typeKeyToKebab(key)})`),
      }
    )
  ),
];

export const ROLE_REGISTRY = Object.fromEntries(
  [...roleTable, ...generatedScalarRoles].map((entry) => [entry.css, entry])
) as Record<`--${string}`, RoleDef>;

export const ADAPTERS = {
  targetMin: {
    css: "--target-min",
    meaning:
      "Input hit-target floor; 44px coarse web/iOS, 48dp Android, 32px fine web.",
    profiles: ["blueprint", "native", "shell"] as const,
  },
  deviceWall: {
    css: "--device-wall",
    meaning: "Detached shell wall composite, not a content surface.",
    profiles: ["shell"] as const,
  },
  glassFilm: {
    css: "--glass-film",
    meaning: "Detached chrome layer; blueprint content never uses it.",
    profiles: ["shell"] as const,
  },
  glassSheen: {
    css: "--glass-sheen",
    meaning:
      "Detached chrome finish. `none` in both themes since the flip — the metaphor is a tinted paper label, not a glass button.",
    profiles: ["shell"] as const,
  },
} as const;

export const PROFILE_SURFACES: Record<Profile, readonly Surface[]> = {
  blueprint: blueprintSurfaces,
  native: ["MO"],
  shell: ["SH", "SH-c"],
};

export const profileForSurface = (surface: Surface): Profile => {
  if (surface === "BI" || surface === "BS") return "blueprint";
  if (surface === "MO") return "native";
  return "shell";
};

export function rolesForProfile(profile: Profile): RoleDef[] {
  const surfaces = new Set(PROFILE_SURFACES[profile]);
  return Object.values(ROLE_REGISTRY).filter((entry) =>
    entry.surfaces.some((surface) => surfaces.has(surface))
  );
}

export function contractForProfile(profile: Profile): string[] {
  return rolesForProfile(profile)
    .map((entry) => entry.css)
    .sort();
}

export function assertTotalProfileValues(): void {
  for (const entry of Object.values(ROLE_REGISTRY)) {
    for (const profile of ["shell", "blueprint", "native"] as const) {
      if (!entry.by[profile]) {
        throw new Error(`${entry.css} has no ${profile} lowering`);
      }
      if (
        entry.by[profile].kind === "unsupported" &&
        !entry.by[profile].reason
      ) {
        throw new Error(
          `${entry.css} unsupported ${profile} lowering has no reason`
        );
      }
    }
  }
}

/** The dark cell of every role whose value flips per theme. Kept beside the
 *  registry so a reviewer can see both halves of a pairing at once. */
export const DARK_THEME_ROLE_VALUES: Readonly<Record<string, string>> = {
  "--accent": darkTheme.accent,
  "--accent-deep": darkTheme.accentDeep,
  "--accent-deep-hover": darkTheme.accentHover,
  "--accent-fill": darkTheme.accentDeep,
  "--accent-light": darkTheme.accentLight,
  "--accent-text": darkTheme.accentText,
  "--bg": darkTheme.bg,
  "--danger": darkTheme.danger,
  "--focus-ring-color": darkTheme.ring,
  "--line": darkTheme.line,
  "--line-strong": darkTheme.lineStrong,
  "--link": darkTheme.link,
  "--net": darkTheme.net,
  "--skel": darkTheme.skel,
  "--success": darkTheme.success,
  "--text": darkTheme.text,
  "--text-inv": darkTheme.textInv,
  "--warning": darkTheme.warning,
};

/** Native field names are mapped back to the semantic registry once. */
export const NATIVE_COLOR_ROLE_MAP = {
  accent: "--accent",
  accentDeep: "--accent-deep",
  accentFill: "--accent-fill",
  accentDeepHover: "--accent-deep-hover",
  accentLight: "--accent-light",
  accentSoft: "--accent-soft",
  accentText: "--accent-text",
  appIdentityText: "--app-identity-text",
  bg: "--bg",
  bgChrome: "--bg-chrome",
  bgElev: "--bg-elev",
  bgHover: "--bg-hover",
  bgPress: "--bg-press",
  bgSel: "--bg-sel",
  bgSunken: "--bg-sunken",
  danger: "--danger",
  line: "--line",
  lineStrong: "--line-strong",
  lineSel: "--line-sel",
  link: "--link",
  net: "--net",
  onAccent: "--on-accent",
  onStage: "--on-stage",
  focusRingColor: "--focus-ring-color",
  scrim: "--scrim",
  shadowLg: "--shadow-lg",
  shadowMd: "--shadow-md",
  shadowSm: "--shadow-sm",
  skel: "--skel",
  stage: "--stage",
  stageLine: "--stage-line",
  stageSunken: "--stage-sunken",
  success: "--success",
  text: "--text",
  textFaint: "--text-faint",
  textGhost: "--text-ghost",
  textDisabled: "--text-disabled",
  textInv: "--text-inv",
  textSoft: "--text-soft",
  warning: "--warning",
} as const;

export function assertNativeColorRoleContract(colors: object): void {
  for (const [field, css] of Object.entries(NATIVE_COLOR_ROLE_MAP)) {
    const roleDef = ROLE_REGISTRY[css];
    if (!roleDef || roleDef.by.native.kind === "unsupported") {
      throw new Error(`${field} is not backed by a native lowering for ${css}`);
    }
    if (!(field in colors)) {
      throw new Error(`${field} is missing from the native color emitter`);
    }
  }
}
