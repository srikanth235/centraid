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
  "Toast",
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
  "destructiveFilled",
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

const baseStates = (
  rest: readonly string[],
  overrides: Partial<Record<RecipeState, readonly string[]>> = {}
): Readonly<Record<RecipeState, readonly string[]>> => ({
  disabled: ["--text-disabled", "--o-disabled", "--dur-1"],
  focus: ["--accent-soft", "--line-strong"],
  hover: ["--bg-hover", "--dur-1"],
  invalid: ["--danger", "--dur-1"],
  loading: ["--dur-2"],
  open: ["--accent-soft", "--dur-2"],
  pressed: ["--bg-press", "--dur-1"],
  rest,
  selected: ["--accent-soft", "--accent-text"],
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
  AppHeader: makeRecipe("AppHeader", ["--bg", "--sp-4", "--r-md"]),
  AppTile: makeRecipe(
    "AppTile",
    ["--bg-elev", "--r-xl", "--sp-4", "--line"],
    {},
    ["name and icon have a labelled fallback"]
  ),
  Avatar: makeRecipe(
    "Avatar",
    ["--r-pill", "--text-inv", "--accent-soft"],
    {},
    ["person identity has an accessible name"]
  ),
  Badge: makeRecipe("Badge", [
    "--accent-soft",
    "--accent-text",
    "--r-pill",
    "--t-eyebrow",
  ]),
  Banner: makeRecipe("Banner", ["--bg-elev", "--line", "--r-md", "--sp-4"]),
  Button: makeRecipe(
    "Button",
    ["--target-min", "--r-md", "--sp-3", "--t-small-strong", "--dur-1"],
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
    ["--target-min", "--r-xs", "--line-strong", "--accent-fill"],
    {},
    ["native checkbox semantics"]
  ),
  Chip: makeRecipe("Chip", [
    "--r-pill",
    "--sp-2",
    "--t-control",
    "--accent-soft",
  ]),
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
  Error: makeRecipe("Error", ["--danger", "--accent-soft", "--sp-4"]),
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
    ["--target-min", "--sp-4", "--line"],
    { selected: ["--accent-soft", "--accent-text"] },
    ["row action is labelled"]
  ),
  Loading: makeRecipe("Loading", ["--bg-sunken", "--sp-4", "--dur-2"], {
    loading: ["--accent-soft", "--dur-2"],
  }),
  Nav: makeRecipe("Nav", ["--bg", "--sp-4", "--line"], {
    selected: ["--accent-soft", "--accent-text"],
  }),
  Progress: makeRecipe("Progress", [
    "--bg-sunken",
    "--accent-fill",
    "--r-pill",
    "--dur-2",
  ]),
  Search: makeRecipe(
    "Search",
    ["--target-min", "--bg-sunken", "--r-pill", "--t-body"],
    { focus: ["--accent-soft", "--line-strong"] },
    ["search landmark", "clear action labelled"],
    ["web", "blueprint", "native"]
  ),
  Segmented: makeRecipe(
    "Segmented",
    ["--target-min", "--bg-sunken", "--r-md", "--sp-1"],
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
  Toast: makeRecipe(
    "Toast",
    ["--bg-elev", "--r-md", "--shadow-md", "--sp-4"],
    {},
    ["status/live-region tone is explicit"],
    ["web", "blueprint", "native"],
    "affirm"
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
