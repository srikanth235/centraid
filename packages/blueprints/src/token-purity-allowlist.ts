export interface TokenPurityBudget {
  hex: number;
  functional: number;
  fontFamily: number;
  customProps: readonly string[];
}

export const TOKEN_PURITY_ALLOWLIST: Readonly<
  Record<string, TokenPurityBudget>
> = {
  "docs/Chrome.module.css": {
    hex: 0,
    functional: 0,
    fontFamily: 0,
    customProps: ["--app-hue", "--app-identity"],
  },
  "people/Chrome.module.css": {
    hex: 0,
    functional: 0,
    fontFamily: 0,
    customProps: ["--app-hue", "--app-identity"],
  },
  "photos/Chrome.module.css": {
    hex: 0,
    functional: 1,
    fontFamily: 0,
    customProps: ["--app-hue", "--app-identity"],
  },
};

export const UNRESOLVED_VAR_DEBT: readonly string[] = [];
