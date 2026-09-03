import type { IconName } from "../icons";

export interface ActionData {
  label: string;
  hint?: string;
}

export interface RowData {
  title: string;
  sub?: string;
  meta?: string;
  net?: boolean;
  dangerous?: boolean;
  off?: boolean;
  struck?: boolean;
}

export interface PanelFactData {
  key: string;
  value: string;
  mono?: boolean;
  net?: boolean;
  note?: string;
}

export interface PanelFigureData {
  value: string;
  label: string;
  qualifier?: string;
  net?: boolean;
}

export interface DistributionDatum {
  id: string;
  label: string;
  value: string;
  weight: number;
}

export type PanelTone = "neutral" | "net" | "seam";

export interface PanelActionData extends ActionData {
  filled?: boolean;
  dangerous?: boolean;
}

export interface ChipData {
  id: string;
  label: string;
  on?: boolean;
}

export interface EmptyCopy {
  title: string;
  body: string;
  routine?: boolean;
}

export interface SectionCopy {
  label: string;
  meta?: string;
}

export interface SectionActionData extends ActionData {
  off?: boolean;
}

export type GridRegister = "text" | "mono";

export interface GridColumnData {
  key: string;
  label: string;
  register?: GridRegister;
  pk?: boolean;
  fk?: string;
  sealed?: boolean;
  fixed?: boolean;
}

export interface GridSortData {
  key: string;
  dir: "asc" | "desc";
}

export interface ButtonData {
  label?: string;
  icon?: IconName;
  disabled?: boolean;
}
