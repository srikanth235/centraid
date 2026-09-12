// Shared records for the RTL + CJK gallery fidelity lanes.

export type FidelityRecord = {
  ancestorIsolated: boolean;
  borLeft: string;
  borRight: string;
  childDisplays: string[];
  classes: string;
  direction: string;
  fontFamily: string;
  index: number;
  marLeft: string;
  marRight: string;
  ownText: string;
  padLeft: string;
  padRight: string;
  parentTextAlign: string;
  startOffset: number | null;
  tag: string;
  textAlign: string;
  typeTriple: string;
  unicodeBidi: string;
  variantNumeric: string;
  visible: boolean;
  width: number;
};

export type AlignedPair = {
  first: FidelityRecord;
  second: FidelityRecord;
};

export type BidiRun = { day: number | null; year: number | null };

export type BidiProbe = {
  control: BidiRun;
  controlDirection: string;
  isolated: BidiRun;
};

export type PhysicalKey =
  | "borLeft"
  | "borRight"
  | "marLeft"
  | "marRight"
  | "padLeft"
  | "padRight";
