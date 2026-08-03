// governance: allow-repo-hygiene file-size-limit — the normative role table and its profile totality checks are intentionally co-located so every role name, meaning, contrast obligation, and lowering remains reviewable as one contract.
// Product-grammar role registry.
//
// A token is a role only when its name, meaning, contrast obligation, and
// lowering are known together.  Emitters consume this registry; they do not
// create semantic names while rendering CSS or native objects.  `by` is
// intentionally total so an unsupported profile is an explicit decision with
// a reason instead of an accidental missing key.

import { spacing } from "./density";
import { radii } from "./radii";
import { BRAND } from "./themes";
import { fontStacks, type, typeKeyToKebab } from "./typography";

export type Profile = "blueprint" | "native" | "shell";
export type Surface = "BI" | "BS" | "MO" | "SH" | "SH-c";
export type RoleCategory =
  | "color"
  | "font"
  | "motion"
  | "radius"
  | "spacing"
  | "type"
  | "component";
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

const roleTable: RoleDef[] = [
  role(
    "--accent",
    "color",
    "Product action and selection accent; identity hues never replace it.",
    "filled controls publish --text-inv; text uses --accent-text",
    allSurfaces,
    {
      blueprint: literal("var(--accent)"),
      native: literal("#3EC8B4"),
      shell: literal("#3EC8B4"),
    }
  ),
  role(
    "--accent-deep",
    "color",
    "Solved accent ramp endpoint used for filled controls and emphasis.",
    "paired with --text-inv when it becomes a fill",
    allSurfaces,
    {
      blueprint: solved("#22776B"),
      native: solved("#22776B"),
      shell: solved("#22776B"),
    },
    4.5
  ),
  role(
    "--accent-light",
    "color",
    "Lifted accent ramp endpoint for restrained emphasis.",
    "non-text separation or large-text use only",
    allSurfaces,
    {
      blueprint: literal("#62D6C6"),
      native: literal("#62D6C6"),
      shell: literal("#62D6C6"),
    },
    3
  ),
  role(
    "--accent-text",
    "color",
    "Accent used as text on a surface.",
    "AA text on the hardest surface in each profile",
    allSurfaces,
    {
      blueprint: solved("var(--accent-deep)"),
      native: solved("#0F7A6C"),
      shell: solved("#0F7A6C"),
    },
    4.5
  ),
  role(
    "--accent-soft",
    "color",
    "A low-opacity accent wash for selection and focus, never primary fill.",
    "non-text separation from the containing surface",
    allSurfaces,
    {
      blueprint: wash("color-mix(in oklab, var(--accent) 12%, transparent)"),
      native: wash("#DDF5F0"),
      shell: wash("rgba(62,200,180,.12)"),
    },
    3
  ),
  role(
    "--accent-fill",
    "color",
    "The one accent-filled action surface allowed per viewport.",
    "--text-inv on the fill",
    allSurfaces,
    {
      blueprint: solved("var(--accent-deep)"),
      native: solved("#22776B"),
      shell: solved("#22776B"),
    },
    4.5
  ),
  role(
    "--accent-deep-hover",
    "color",
    "Pressed/hovered accent fill, derived toward content ink.",
    "--text-inv on the fill",
    allSurfaces,
    {
      blueprint: solved(
        "color-mix(in oklab, var(--accent-fill) 88%, var(--text))"
      ),
      native: solved("#206c62"),
      shell: solved("#1D685E"),
    },
    4.5
  ),
  role(
    "--bg-chrome",
    "color",
    "Persistent host chrome surface behind navigation and detached controls.",
    "content is measured on the chrome surface",
    shellAndNative,
    {
      blueprint: unsupported("Blueprint content does not own host chrome."),
      native: literal("#F4F5F7"),
      shell: literal("#F4F5F7"),
    }
  ),
  role(
    "--bg",
    "color",
    "Default reading surface.",
    "all text roles must clear their declared floor",
    allSurfaces,
    {
      blueprint: literal("hsl(var(--app-hue) 20% 98%)"),
      native: literal("#FCFCFC"),
      shell: literal("#FCFCFC"),
    }
  ),
  role(
    "--bg-app",
    "color",
    "Application backing surface below the reading surface.",
    "decorative surface only",
    shellAndNative,
    {
      blueprint: unsupported("Blueprint content has no detached app backing."),
      native: unsupported("Native colors expose one concrete background role."),
      shell: literal("#FFFFFF"),
    }
  ),
  role(
    "--bg-elev",
    "color",
    "Raised surface for panels and decisions.",
    "line and text contrast are measured on the raised surface",
    allSurfaces,
    {
      blueprint: literal("#FFFFFF"),
      native: literal("#F4F5F7"),
      shell: literal("#FFFFFF"),
    }
  ),
  role(
    "--bg-sunken",
    "color",
    "Recessed surface for tracks and quiet metadata.",
    "faint text and status washes are measured here",
    allSurfaces,
    {
      blueprint: literal("hsl(var(--app-hue) 20% 95.5%)"),
      native: literal("#F0F1F3"),
      shell: literal("#F0F1F3"),
    }
  ),
  role(
    "--bg-hover",
    "color",
    "Hover surface for a quiet control or row.",
    "non-text separation from the containing surface",
    allSurfaces,
    {
      blueprint: wash("color-mix(in oklab, var(--text) 5%, transparent)"),
      native: literal("#F1F3F5"),
      shell: literal("rgba(20,22,27,.05)"),
    },
    3
  ),
  role(
    "--bg-press",
    "color",
    "Pressed surface for a control or row.",
    "non-text separation from the containing surface",
    allSurfaces,
    {
      blueprint: wash("color-mix(in oklab, var(--text) 9%, transparent)"),
      native: literal("#E7EAED"),
      shell: literal("rgba(20,22,27,.09)"),
    },
    3
  ),
  role(
    "--bg-sel",
    "color",
    "Selected surface for rows, navigation, and keyboard selection.",
    "non-text separation from the containing surface",
    allSurfaces,
    {
      blueprint: wash("color-mix(in oklab, var(--accent) 12%, transparent)"),
      native: wash("#DDF5F0"),
      shell: wash("rgba(62,200,180,.12)"),
    },
    3
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
      shell: literal("rgba(255,255,255,.92)"),
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
      shell: literal("#FCFCFC"),
    }
  ),
  role(
    "--text",
    "color",
    "Primary content ink.",
    "body text AA",
    allSurfaces,
    {
      blueprint: solved("hsl(var(--app-hue) 22% 12%)"),
      native: literal("#14161B"),
      shell: literal("#14161B"),
    },
    4.5
  ),
  role(
    "--text-soft",
    "color",
    "Secondary content ink for supporting prose.",
    "small text AA",
    allSurfaces,
    {
      blueprint: solved("hsl(var(--app-hue) 9% 36%)"),
      native: literal("#454A54"),
      shell: literal("rgba(20,22,27,.78)"),
    },
    4.5
  ),
  role(
    "--text-faint",
    "color",
    "Metadata ink and quiet labels.",
    "small text AA on --bg-sunken",
    allSurfaces,
    {
      blueprint: solved("hsl(var(--app-hue) 8% 42%)"),
      native: literal("#5F6672"),
      shell: literal("rgba(20,22,27,.62)"),
    },
    4.5
  ),
  role(
    "--text-ghost",
    "color",
    "Disabled or unavailable content; not used for active controls.",
    "non-text 3:1 where it is an icon/border; body use is forbidden",
    allSurfaces,
    {
      blueprint: literal("hsl(var(--app-hue) 8% 52%)"),
      native: literal("#8A909A"),
      shell: literal("rgba(20,22,27,.48)"),
    },
    3
  ),
  role(
    "--text-disabled",
    "color",
    "Disabled text ink; it is not opacity-stacked with --o-disabled.",
    "disabled text clears the declared floor",
    allSurfaces,
    {
      blueprint: literal("hsl(var(--app-hue) 8% 58%)"),
      native: literal("#9BA1AA"),
      shell: literal("rgba(20,22,27,.36)"),
    },
    3
  ),
  role(
    "--text-inv",
    "color",
    "Ink on a published fill.",
    "AA against the fill it is paired with",
    allSurfaces,
    {
      blueprint: literal("#FFFFFF"),
      native: literal("#F4F5F7"),
      shell: literal("#FFFFFF"),
    },
    4.5
  ),
  role(
    "--on-accent",
    "color",
    "Ink published for saturated fills and scrims that stay dark in both themes.",
    "AA against the saturated fill or scrim it is paired with",
    allSurfaces,
    {
      blueprint: literal("#141820"),
      native: literal("#141820"),
      shell: literal("#141820"),
    },
    4.5
  ),
  role(
    "--line",
    "color",
    "Hairline separation between adjacent surfaces.",
    "non-text 3:1 on the local surface",
    allSurfaces,
    {
      blueprint: literal("hsl(var(--app-hue) 19% 13% / .095)"),
      native: literal("rgba(20,22,27,.11)"),
      shell: literal("rgba(20,22,27,.11)"),
    },
    3
  ),
  role(
    "--line-strong",
    "color",
    "Focused or explicit boundary.",
    "non-text 3:1 on the local surface",
    allSurfaces,
    {
      blueprint: literal("hsl(var(--app-hue) 19% 13% / .165)"),
      native: literal("rgba(20,22,27,.20)"),
      shell: literal("rgba(20,22,27,.20)"),
    },
    3
  ),
  role(
    "--line-sel",
    "color",
    "Selected boundary paired with --bg-sel.",
    "non-text 3:1 boundary against the local surface",
    allSurfaces,
    {
      blueprint: literal("color-mix(in oklab, var(--accent) 42%, var(--line))"),
      native: literal("rgba(62,200,180,.42)"),
      shell: literal("rgba(62,200,180,.42)"),
    },
    3
  ),
  role(
    "--focus-ring",
    "color",
    "Visible focus boundary composed from the accent wash and line.",
    "3:1 non-text boundary against the local surface",
    allSurfaces,
    {
      blueprint: literal(
        "0 0 0 2px var(--accent-soft), 0 0 0 1px var(--accent)"
      ),
      native: literal("#3EC8B4"),
      shell: literal("0 0 0 2px var(--accent-soft), 0 0 0 1px var(--accent)"),
    },
    3
  ),
  role(
    "--focus-ring-color",
    "color",
    "Non-clipping focus outline color; native uses the platform focus ring.",
    "3:1 non-text boundary against the local surface",
    allSurfaces,
    {
      blueprint: literal("var(--accent)"),
      native: literal("#3EC8B4"),
      shell: literal("var(--accent)"),
    },
    3
  ),
  role(
    "--scrim",
    "color",
    "Veil behind a decision dialog, sheet, or media overlay.",
    "modal content is measured above the veil",
    allSurfaces,
    {
      blueprint: literal("rgba(20,22,27,.48)"),
      native: literal("rgba(20,22,27,.52)"),
      shell: literal("rgba(20,22,27,.52)"),
    }
  ),
  role(
    "--shadow-sm",
    "color",
    "Small elevation cue for controls and cards.",
    "decorative; does not replace a line",
    allSurfaces,
    {
      blueprint: literal("0 0 0 .5px var(--line-strong)"),
      native: literal("0 1px 2px rgba(20,22,27,.07)"),
      shell: literal("0 1px 2px rgba(20,22,27,.07)"),
    }
  ),
  role(
    "--shadow-md",
    "color",
    "Medium elevation cue for panels and toasts.",
    "decorative; does not replace a line",
    allSurfaces,
    {
      blueprint: literal("0 10px 26px -14px rgba(20,22,27,.27)"),
      native: literal("0 8px 24px -8px rgba(20,22,27,.09)"),
      shell: literal("0 8px 24px -8px rgba(20,22,27,.09)"),
    }
  ),
  role(
    "--shadow-lg",
    "color",
    "Large elevation cue for dialogs and sheets.",
    "decorative; does not replace a line",
    allSurfaces,
    {
      blueprint: literal("0 26px 60px -24px rgba(20,22,27,.39)"),
      native: literal("0 24px 48px -16px rgba(20,22,27,.14)"),
      shell: literal("0 24px 48px -16px rgba(20,22,27,.14)"),
    }
  ),
  role(
    "--danger",
    "color",
    "Destructive and error status ink.",
    "small text AA on the status wash",
    allSurfaces,
    {
      blueprint: solved("#A7302A"),
      native: solved("#B6322B"),
      shell: solved("#A72D2D"),
    },
    4.5
  ),
  role(
    "--success",
    "color",
    "Healthy, complete, or connected status ink.",
    "small text AA on the status wash",
    allSurfaces,
    {
      blueprint: solved("#2F7D4F"),
      native: solved("#267044"),
      shell: solved("#3C6932"),
    },
    4.5
  ),
  role(
    "--warning",
    "color",
    "Cautionary or degraded status ink.",
    "small text AA on the status wash",
    allSurfaces,
    {
      blueprint: solved("#8C5E17"),
      native: solved("#8C5E17"),
      shell: solved("#9A6B1F"),
    },
    4.5
  ),
  role(
    "--dur-1",
    "motion",
    "Short interaction transition.",
    "reduced-motion can remove it",
    allSurfaces,
    { blueprint: scalar("120ms"), native: scalar(120), shell: scalar("120ms") }
  ),
  role(
    "--dur-2",
    "motion",
    "Normal state and container transition.",
    "reduced-motion can remove it",
    allSurfaces,
    { blueprint: scalar("200ms"), native: scalar(200), shell: scalar("200ms") }
  ),
  role(
    "--ease",
    "motion",
    "The single product easing curve.",
    "reduced-motion can remove it",
    allSurfaces,
    {
      blueprint: literal("cubic-bezier(0.2, 0.7, 0.3, 1)"),
      native: literal("easeOut"),
      shell: literal("cubic-bezier(0.2, 0.7, 0.3, 1)"),
    }
  ),
  role(
    "--o-disabled",
    "motion",
    "Opacity applied to disabled content after semantics are conveyed.",
    "disabled state is never color-only",
    allSurfaces,
    { blueprint: scalar(0.45), native: scalar(0.45), shell: scalar(0.45) }
  ),
  role(
    "--app-hue",
    "color",
    "Blueprint identity hue that tunes app-local neutrals.",
    "surface parameter; not an action color",
    blueprintSurfaces,
    {
      blueprint: literal("171"),
      native: unsupported("Native surfaces use solved concrete neutrals."),
      shell: unsupported("Shell neutrals are theme-owned."),
    }
  ),
  role(
    "--app-identity",
    "color",
    "App identity hue for marks and identity treatments; never product action teal.",
    "decorative or identity text only; action contrast uses product roles",
    blueprintSurfaces,
    {
      blueprint: literal(BRAND),
      native: unsupported("Native app identity is lowered by the app catalog."),
      shell: unsupported(
        "Shell host identity is separate from blueprint content."
      ),
    }
  ),
  role(
    "--app-identity-text",
    "color",
    "Solved text rung for the selected app identity hue; never an action color.",
    "identity text clears AA on its local surface",
    ["BI", "BS", "SH", "SH-c"],
    {
      blueprint: literal("var(--c-teal-text)"),
      native: solved("#0F7A6C"),
      shell: literal("var(--c-teal-text)"),
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
      `The one ${key} face genus used by the type scale.`,
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
      "the role's declared text floor",
      key === "hero"
        ? ["SH", "SH-c"]
        : key === "greeting"
          ? shellAndNative
          : allSurfaces,
      {
        blueprint:
          key === "hero" || key === "greeting"
            ? unsupported("This role is not part of the blueprint profile.")
            : literal(`var(--t-${typeKeyToKebab(key)})`),
        native:
          key === "hero"
            ? unsupported(
                "Native compact surfaces use title/display, not hero type."
              )
            : literal(
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
  bgL: {
    css: "--bg-l",
    meaning: "One dark-surface anchor used to solve the dark wall.",
    profiles: ["blueprint", "shell", "native"] as const,
  },
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
    meaning: "Detached chrome glass layer; blueprint content never uses it.",
    profiles: ["shell"] as const,
  },
  glassSheen: {
    css: "--glass-sheen",
    meaning:
      "Detached chrome blur/opacity finish; blueprint content never uses it.",
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
  onAccent: "--on-accent",
  focusRingColor: "--focus-ring-color",
  scrim: "--scrim",
  shadowLg: "--shadow-lg",
  shadowMd: "--shadow-md",
  shadowSm: "--shadow-sm",
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
