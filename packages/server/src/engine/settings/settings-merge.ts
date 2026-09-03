export interface SettingsInject {
  dataAttrs?: Record<string, string>;
  cssVars?: Record<string, string>;
}

type KeySpec =
  | { kind: "data"; attr: string; coerce?: (v: unknown) => string | undefined }
  | {
      kind: "css";
      cssVar: string;
      coerce?: (v: unknown) => string | undefined;
    };

const asString = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;
const asPercent = (v: unknown): string | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return `${v}%`;
  if (typeof v === "string" && /^\d+(?:\.\d+)?$/u.test(v)) return `${v}%`;
  return undefined;
};
export const KNOWN_KEYS: Record<string, KeySpec> = {
  theme: { kind: "data", attr: "theme", coerce: asString },
  density: { kind: "data", attr: "density", coerce: asString },
  cards: { kind: "data", attr: "cards", coerce: asString },
  bgL: { kind: "css", cssVar: "bg-l", coerce: asPercent },
  accent: { kind: "css", cssVar: "accent", coerce: asString },
  accentLight: { kind: "css", cssVar: "accent-light", coerce: asString },
  accentDeep: { kind: "css", cssVar: "accent-deep", coerce: asString },
  accentFill: { kind: "css", cssVar: "accent-fill", coerce: asString },
  accentDeepHover: {
    kind: "css",
    cssVar: "accent-deep-hover",
    coerce: asString,
  },
  accentSoft: { kind: "css", cssVar: "accent-soft", coerce: asString },
  accentText: { kind: "css", cssVar: "accent-text", coerce: asString },
  bgSel: { kind: "css", cssVar: "bg-sel", coerce: asString },
  lineSel: { kind: "css", cssVar: "line-sel", coerce: asString },
};

function camelTailToKebab(tail: string): string {
  return (
    tail.charAt(0).toLowerCase() +
    tail.slice(1).replace(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`)
  );
}

function isAppKnobKey(key: string): key is `app${string}` {
  if (key.length <= 3 || !key.startsWith("app")) return false;
  const c = key.charCodeAt(3);
  return c >= 65 && c <= 90; // 'A'..'Z'
}

function appKnobTarget(
  key: string
): { kind: "data"; attr: string } | { kind: "css"; cssVar: string } {
  const kebab = camelTailToKebab(key.slice(3));
  const name = `app-${kebab}`;
  if (key === "appColor" || key === "appAccent")
    return { kind: "css", cssVar: "app-identity" };
  return /(?:Color|Accent)$/u.test(key)
    ? { kind: "css", cssVar: name }
    : { kind: "data", attr: name };
}

export function buildSettingsInject(
  layers: Array<Record<string, unknown> | undefined>
): Required<SettingsInject> {
  const merged: Record<string, unknown> = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (v === undefined || v === null) continue;
      merged[k] = v;
    }
  }

  const dataAttrs: Record<string, string> = {};
  const cssVars: Record<string, string> = {};
  for (const [k, raw] of Object.entries(merged)) {
    const spec = KNOWN_KEYS[k];
    if (spec) {
      const coerced = spec.coerce ? spec.coerce(raw) : asString(raw);
      if (coerced === undefined) continue;
      if (spec.kind === "data") {
        dataAttrs[spec.attr] = coerced;
      } else {
        cssVars[spec.cssVar] = coerced;
      }
      continue;
    }
    if (isAppKnobKey(k)) {
      const coerced = asString(raw);
      if (coerced === undefined) continue;
      const target = appKnobTarget(k);
      if (target.kind === "data") dataAttrs[target.attr] = coerced;
      else cssVars[target.cssVar] = coerced;
    }
  }
  return { dataAttrs, cssVars };
}
