import { healthSentence, opsGenericLine } from "@centraid/design/blocks";

import {
  EMPTY_HEALTH,
  ERROR_HEALTH,
  READING_HEALTH,
} from "../../surface-copy.js";
import type { OpsPage, OpsState } from "./opsBar.js";
import { setRouteHealth } from "./statusChannel.js";
import type { RouteHealthNote } from "./statusChannel.js";

export const LOADING_COUNT_LINE = READING_HEALTH;

export const LOADING_HEALTH = READING_HEALTH;

export function lastReadLine(at: Date | number): string {
  const d = at instanceof Date ? at : new Date(at);
  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `Last read at ${time}`;
}

export interface RouteHealth {
  label: string;
  detail: string;
  action?: { label: string; run: () => void };
}

export interface RouteVitalsInput {
  state: OpsState;
  count?: string;
  lastReadAt?: Date | number;
}

export interface RouteVitals {
  state: OpsState;
  count: string;
}

export interface RouteVerbs {
  onCommit?: () => void;
  onSecondary?: () => void;
}

type VitalsMap = Readonly<Partial<Record<OpsPage, RouteVitals>>>;
type VerbsMap = Readonly<Partial<Record<OpsPage, RouteVerbs>>>;

let vitals: VitalsMap = {};
let verbs: VerbsMap = {};
const subscribers = new Set<() => void>();

function emit(): void {
  for (const fn of Array.from(subscribers)) fn();
}

function resolveCount(input: RouteVitalsInput): string {
  const generic = opsGenericLine(input.state, {
    empty: input.count ?? "",
    error: input.lastReadAt === undefined ? "" : lastReadLine(input.lastReadAt),
    loading: LOADING_COUNT_LINE,
  });
  return generic ?? input.count ?? "";
}

export function subscribeVitals(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function readAllVitals(): VitalsMap {
  return vitals;
}

export function readVitals(page: OpsPage): RouteVitals | undefined {
  return vitals[page];
}

export function readAllVerbs(): VerbsMap {
  return verbs;
}

export function publishVitals(page: OpsPage, input: RouteVitalsInput): void {
  const next: RouteVitals = { count: resolveCount(input), state: input.state };
  const prev = vitals[page];
  if (prev && prev.count === next.count && prev.state === next.state) return;
  vitals = { ...vitals, [page]: next };
  emit();
}

export function publishRouteVerbs(page: OpsPage, next: RouteVerbs): void {
  verbs = { ...verbs, [page]: next };
  emit();
}

export function clearVitals(page: OpsPage): void {
  if (vitals[page] === undefined && verbs[page] === undefined) return;
  vitals = Object.fromEntries(
    Object.entries(vitals).filter(([key]) => key !== page)
  );
  verbs = Object.fromEntries(
    Object.entries(verbs).filter(([key]) => key !== page)
  );
  emit();
}

function healthFor(
  state: OpsState,
  health: RouteHealth | undefined,
  tone: RouteHealthNote["tone"]
): RouteHealthNote | null {
  const generic = opsGenericLine(state, {
    empty: EMPTY_HEALTH,
    error: ERROR_HEALTH,
    loading: LOADING_HEALTH,
  });
  if (generic !== undefined) return { text: generic };
  if (!health) return null;
  return {
    text: healthSentence(health.label, health.detail),
    ...(health.action ? { action: health.action } : {}),
    ...(tone ? { tone } : {}),
  };
}

export function publishRouteSignals(
  page: OpsPage,
  input: RouteVitalsInput & {
    health?: RouteHealth;
    tone?: RouteHealthNote["tone"];
  }
): void {
  publishVitals(page, input);
  setRouteHealth(healthFor(input.state, input.health, input.tone));
}

export function clearRouteSignals(page: OpsPage): void {
  clearVitals(page);
  setRouteHealth(null);
}

export function resetVitals(): void {
  vitals = {};
  verbs = {};
  subscribers.clear();
}
