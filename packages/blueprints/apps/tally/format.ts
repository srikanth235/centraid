import { fmtMoney, partyHueKey } from "@centraid/design";

import type { Role } from "./types.ts";

export type FigureTone = "net" | "owed" | "settled";

export function money(
  minor: number | null | undefined,
  currency: string | undefined
): string {
  return fmtMoney(Math.abs(Number(minor ?? 0)), currency);
}

export function figureTone(netMinor: number): FigureTone {
  if (Math.abs(netMinor) < 1) return "settled";
  return netMinor < 0 ? "net" : "owed";
}

export function allSettled(nets: readonly number[]): boolean {
  return nets.every((net) => Math.abs(net) < 1);
}

export function netFigure(
  netMinor: number,
  currency: string | undefined,
  settledWord = "settled"
): string {
  return figureTone(netMinor) === "settled"
    ? settledWord
    : money(netMinor, currency);
}

export function personSubLabel(netMinor: number): string {
  const tone = figureTone(netMinor);
  if (tone === "settled") return "";
  return tone === "net" ? "you owe" : "owes you";
}

export function groupSubLabel(netMinor: number): string {
  const tone = figureTone(netMinor);
  if (tone === "settled") return "";
  return tone === "net" ? "you owe" : "owed to you";
}

export function roleSubLabel(role: Role): string {
  if (role === "lent") return "your share";
  return role === "borrowed" ? "you owe" : "not yours";
}

export function roleTone(role: Role): FigureTone {
  if (role === "borrowed") return "net";
  return role === "lent" ? "owed" : "settled";
}

export function personHue(partyId: string): string {
  return `var(--c-${partyHueKey(partyId) ?? "slate"}-text)`;
}

export function metaSentence(
  parts: readonly (string | false | null | undefined)[]
): string {
  return parts.filter(Boolean).join("  ·  ");
}

export function proportion(value: number, largest: number): number {
  if (largest <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((value / largest) * 100)));
}
