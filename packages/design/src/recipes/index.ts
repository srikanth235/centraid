// Revision 3 component recipes.
//
// Recipes describe interaction grammar, not content.  Web/blueprint renderers
// lower this table to CSS and native composes the same states with typed
// values.  A recipe must name its rest and every supported state so a client
// cannot silently invent a one-off hover, focus, disabled, or loading state.

export const RECIPE_NAMES = [
  "Button",
  "IconButton",
  "TextField",
  "Search",
  "Surface",
  "ListRow",
  "Chip",
  "Badge",
  "Segmented",
  "Dialog",
  "Sheet",
  "StatusLine",
  "Banner",
  "Empty",
  "Loading",
  "Error",
  "AppTile",
  "AppHeader",
  "Nav",
  "Switch",
  "Checkbox",
  "Select",
  "DateTimeField",
  "Tooltip",
  "Progress",
  "Avatar",
] as const;

export type RecipeName = (typeof RECIPE_NAMES)[number];
export type RecipeState =
  | "rest"
  | "hover"
  | "pressed"
  | "focus"
  | "disabled"
  | "loading"
  | "invalid"
  | "selected"
  | "open";

export const BUTTON_VARIANTS = [
  "primary",
  "secondary",
  "quiet",
  "destructive",
] as const;

export type ButtonVariant = (typeof BUTTON_VARIANTS)[number];

export interface Recipe {
  name: RecipeName;
  rest: readonly string[];
  states: Readonly<Record<RecipeState, readonly string[]>>;
  capabilities: readonly ("web" | "blueprint" | "native")[];
  a11y: readonly string[];
  haptics?: "affirm" | "change" | "destructive" | "none";
}

// State roles, after the Binding Layer flip:
//   • focus is the RING, at 2px with a 2px offset — never a wash, because a
//     wash under a filled ink control is invisible;
//   • selection is the reserved LINK hue, the one hue allowed off a control;
//   • disabled takes its own leaf token, never a container opacity;
//   • a state change is `--dur-1` (140ms), an entry is `--dur-2` (280ms).
const baseStates = (
  rest: readonly string[],
  overrides: Partial<Record<RecipeState, readonly string[]>> = {}
): Readonly<Record<RecipeState, readonly string[]>> => ({
  disabled: ["--text-disabled", "--o-disabled", "--dur-1"],
  focus: ["--focus-ring", "--focus-ring-color"],
  hover: ["--bg-hover", "--dur-1"],
  invalid: ["--danger", "--dur-1"],
  loading: ["--dur-2"],
  open: ["--scrim", "--dur-2", "--ease-entry"],
  pressed: ["--bg-press", "--dur-1"],
  rest,
  selected: ["--bg-sel", "--line-sel"],
  ...overrides,
});

const makeRecipe = (
  name: RecipeName,
  rest: readonly string[],
  overrides: Partial<Record<RecipeState, readonly string[]>> = {},
  a11y: readonly string[] = [],
  capabilities: readonly ("web" | "blueprint" | "native")[] = [
    "web",
    "blueprint",
    "native",
  ],
  haptics: Recipe["haptics"] = "none"
): Recipe => ({
  a11y: a11y.length > 0 ? a11y : ["semantic role"],
  capabilities,
  haptics,
  name,
  rest,
  states: baseStates(rest, overrides),
});

export const RECIPES: Readonly<Record<RecipeName, Recipe>> = {
  AppHeader: makeRecipe("AppHeader", ["--bg", "--sp-4", "--t-display"]),
  AppTile: makeRecipe(
    "AppTile",
    ["--bg-elev", "--r-lg", "--density-pad", "--line"],
    {},
    ["name and icon have a labelled fallback"]
  ),
  Avatar: makeRecipe(
    "Avatar",
    ["--r-pill", "--text-inv", "--app-identity"],
    {},
    ["person identity has an accessible name"]
  ),
  Badge: makeRecipe("Badge", [
    "--line",
    "--text-soft",
    "--r-md",
    "--t-eyebrow",
  ]),
  Banner: makeRecipe("Banner", ["--bg-elev", "--line", "--r-md", "--sp-4"]),
  Button: makeRecipe(
    "Button",
    [
      "--h-control",
      "--target-min",
      "--r-md",
      "--sp-3",
      "--t-small-strong",
      "--dur-1",
    ],
    {
      disabled: ["--text-disabled", "--o-disabled", "--dur-1"],
      loading: ["--dur-2"],
    },
    [
      "native button role",
      "visible keyboard focus",
      "disabled is not color-only",
    ],
    ["web", "blueprint", "native"],
    "change"
  ),
  Checkbox: makeRecipe(
    "Checkbox",
    ["--target-min", "--r-sm", "--line-strong", "--accent-fill"],
    {},
    ["native checkbox semantics"]
  ),
  Chip: makeRecipe("Chip", ["--r-md", "--sp-2", "--t-control", "--line"]),
  DateTimeField: makeRecipe(
    "DateTimeField",
    ["--target-min", "--r-md", "--line", "--t-control"],
    {},
    ["native date/time picker on MO"],
    ["web", "blueprint", "native"]
  ),
  Dialog: makeRecipe(
    "Dialog",
    ["--bg-elev", "--r-xl", "--sp-5", "--shadow-lg"],
    { open: ["--scrim", "--dur-2"] },
    ["focus is contained", "labelled dialog", "escape closes when safe"],
    ["web", "blueprint", "native"]
  ),
  Empty: makeRecipe("Empty", ["--bg-sunken", "--sp-5", "--text-soft"]),
  Error: makeRecipe("Error", ["--danger", "--net", "--sp-4"]),
  IconButton: makeRecipe(
    "IconButton",
    ["--target-min", "--r-pill", "--t-control"],
    {},
    ["accessible label", "visible keyboard focus"],
    ["web", "blueprint", "native"],
    "change"
  ),
  ListRow: makeRecipe(
    "ListRow",
    ["--density-row", "--target-min", "--density-pad", "--line"],
    { selected: ["--bg-sel", "--line-sel"] },
    ["row action is labelled"]
  ),
  Loading: makeRecipe("Loading", ["--bg-sunken", "--sp-4", "--dur-2"], {
    loading: ["--accent-fill", "--dur-2", "--ease-entry"],
  }),
  Nav: makeRecipe("Nav", ["--w-stem", "--bg-chrome", "--text-soft", "--line"], {
    selected: ["--text", "--app-identity"],
  }),
  Progress: makeRecipe("Progress", [
    "--bg-sunken",
    "--accent-fill",
    "--r-pill",
    "--dur-2",
    "--t-mono",
  ]),
  Search: makeRecipe(
    "Search",
    ["--h-control", "--bg-sunken", "--r-md", "--t-body"],
    { focus: ["--focus-ring", "--focus-ring-color"] },
    ["search landmark", "clear action labelled"],
    ["web", "blueprint", "native"]
  ),
  Segmented: makeRecipe(
    "Segmented",
    ["--h-segmented", "--bg-sunken", "--r-md", "--sp-1"],
    { selected: ["--bg-elev", "--text"] },
    ["tablist or radiogroup semantics"]
  ),
  Select: makeRecipe(
    "Select",
    ["--target-min", "--r-md", "--line", "--t-control"],
    {},
    ["native picker on MO"]
  ),
  Sheet: makeRecipe(
    "Sheet",
    ["--bg-elev", "--r-xl", "--sp-5", "--shadow-lg"],
    { open: ["--scrim", "--dur-2"] },
    ["focus is contained", "labelled sheet", "safe-area padding"],
    ["web", "blueprint", "native"]
  ),
  StatusLine: makeRecipe(
    "StatusLine",
    [
      "--bg",
      "--line",
      "--h-control",
      "--t-mono",
      "--t-mono-numeric",
      "--text-soft",
      "--text-faint",
    ],
    {
      // The determinate bar for a long local operation: track then fill,
      // never a spinner. A state change (message swap, bar width) is the
      // one-line update-in-place transition, not an entry animation.
      loading: ["--bg-elev", "--text", "--dur-1", "--ease"],
    },
    [
      "role=status",
      "aria-live=polite",
      "one persistent line; no stacking, no auto-dismiss animation",
      "inline action is a labelled control with a visible focus ring, never bare text",
    ],
    ["web", "blueprint", "native"]
  ),
  Surface: makeRecipe("Surface", ["--bg-elev", "--r-lg", "--line", "--sp-4"]),
  Switch: makeRecipe(
    "Switch",
    ["--target-min", "--r-pill", "--accent-fill", "--line"],
    { selected: ["--accent-fill", "--text-inv"] },
    ["native switch semantics"],
    ["web", "blueprint", "native"],
    "change"
  ),
  TextField: makeRecipe(
    "TextField",
    ["--target-min", "--r-md", "--line", "--t-body"],
    { invalid: ["--danger", "--dur-1"] },
    ["label and error are associated", "multiline grows without losing focus"],
    ["web", "blueprint", "native"]
  ),
  Tooltip: makeRecipe(
    "Tooltip",
    ["--bg-elev", "--r-xs", "--text", "--sp-2"],
    {},
    ["supplemental only; never the only label"],
    ["web", "blueprint"]
  ),
};

export const RECIPE_ROLE_REFERENCES = new Set(
  Object.values(RECIPES).flatMap((entry) => [
    ...entry.rest,
    ...Object.values(entry.states).flat(),
  ])
);

export function getRecipe(name: RecipeName): Recipe {
  return RECIPES[name];
}
