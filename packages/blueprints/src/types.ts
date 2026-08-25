import type { ColorKey, IconName } from "@centraid/design";

export interface AppKnobOption {
  value: string;
  label: string;
}
export interface AppKnob {
  /** The runtime routes by key name: a `Color`/`Accent` suffix becomes an
   *  `--app-<kebab>` CSS var, anything else a `data-app-<kebab>` attribute. */
  key: string;
  label: string;
  type: "segmented" | "swatch";
  default: string;
  options: AppKnobOption[];
}
export interface AppKnobsManifest {
  version: number;
  knobs: AppKnob[];
}

/** Duplicated, never imported: blueprints must not depend on app-engine. */
export interface AppSeats {
  byteBearing: boolean;
  originActs: string[];
  disabledOn: string[];
  northStar: string;
}

/** The segment directory is DERIVED from `kind`, never stored. */
export interface TemplateMeta {
  id: string;
  name: string;
  desc: string;
  colorKey: ColorKey;
  iconKey: IconName;
  version: string;
  files: string[];
  appKnobs?: AppKnob[];
  seats?: AppSeats;
  kind?: TemplateKind;
  emoji?: string;
  category?: string;
  triggerKind?: "cron" | "webhook";
  triggerLabel?: string;
  integrations?: readonly string[];
}

export type TemplateKind = "app" | "automation";

export interface TemplateManifest {
  manifestVersion: number;
  templates: TemplateMeta[];
}

export type TemplateSource = "bundle" | "cache";

export interface ResolvedTemplate extends TemplateMeta {
  source: TemplateSource;
}
