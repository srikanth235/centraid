import type { ColorKey, IconName } from "@centraid/design";

export interface AppKnobOption {
  value: string;
  label: string;
}
export interface AppKnob {
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

export interface AppSeats {
  byteBearing: boolean;
  originActs: string[];
  disabledOn: string[];
  northStar: string;
}

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
