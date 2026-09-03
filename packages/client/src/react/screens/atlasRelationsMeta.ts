import type { AtlasDetailLevel } from "./atlasOrreryGeometry.js";

export const fmt = (n: number): string => n.toLocaleString("en-US");

export const QUESTIONS: readonly {
  q: "connected" | "heaviest" | "unused";
  label: string;
}[] = [
  { q: "connected", label: "What's connected here?" },
  { q: "heaviest", label: "Where's my data heaviest?" },
  { q: "unused", label: "What's unused?" },
];
export type QuestionKey = (typeof QUESTIONS)[number]["q"];

export const LEVELS: readonly { level: AtlasDetailLevel; label: string }[] = [
  { level: "simple", label: "Simple" },
  { level: "standard", label: "Standard" },
  { level: "everything", label: "Everything" },
];
