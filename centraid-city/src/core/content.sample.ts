// Development-only fixture. The shipped app imports ./content.ts (written by the content author).
// Shape must match SPEC.md §"content.ts schema" exactly.

import type {
  CityDistrict,
  CityMeta,
  HudStat,
  Palette,
  Scenario,
  TourChapter,
} from "./types.js";

export const meta = {
  title: "Centraid City",
  subtitle: "a working model of the Centraid gateway",
  legal: "Centraid City is an illustrative model; details simplified.",
  loadingMessages: [
    "Pouring the ground plane…",
    "Opening vault.db in WAL mode…",
    "Waking the gateway front desk…",
    "Hiring ACP harnesses…",
    "Painting the consent gate violet…",
    "Rolling the WAL conveyor…",
  ],
} satisfies CityMeta;

export const palette = {
  requests: "#39c5ea",
  harness: "#5b7cfa",
  wal: "#f5a623",
  dirty: "#e5484d",
  consent: "#8e4ec6",
  sync: "#30a46c",
  blob: "#8d9aa5",
  automation: "#ad8b00",
} satisfies Palette;

export const districts = [
  {
    id: "clients",
    name: "Client Approach",
    blurb: "Where desktop, web and mobile clients enter the city.",
    color: "#39c5ea",
    plate: { x: 0, z: 74, w: 96, d: 44 },
    buildings: [
      {
        id: "desktop",
        name: "Desktop Tower",
        kind: "tower",
        pos: { x: -28, z: 74 },
        size: { w: 12, h: 30, d: 12 },
        blurb: "The Electron desktop app.",
        detail:
          "The desktop app renders the shared React shell and supervises a detached gateway child process. It talks to that gateway over plain HTTP and SSE on loopback.",
        codeRef: "apps/desktop/src",
      },
      {
        id: "web",
        name: "Web PWA",
        kind: "slab",
        pos: { x: 0, z: 74 },
        size: { w: 18, h: 16, d: 12 },
        blurb: "The installable web client.",
        detail:
          "The PWA shares the React shell and the browser-safe HTTP client with desktop. It has no gateway of its own and must be pointed at one.",
        codeRef: "apps/web/src",
      },
      {
        id: "mobile",
        name: "Mobile Pier",
        kind: "hall",
        pos: { x: 28, z: 74 },
        size: { w: 16, h: 12, d: 14 },
        blurb: "The Expo mobile app.",
        detail:
          "Mobile pairs with a gateway over an iroh p2p tunnel and keeps offline replicas of each paired vault.",
        codeRef: "apps/mobile",
      },
    ],
  },
  {
    id: "gateway",
    name: "Gateway Plaza",
    blurb: "The always-on host-agnostic core every client talks to.",
    color: "#5b7cfa",
    plate: { x: 0, z: 10, w: 74, d: 56 },
    buildings: [
      {
        id: "frontdesk",
        name: "HTTP/SSE Front Desk",
        kind: "hall",
        pos: { x: 0, z: 10 },
        size: { w: 30, h: 18, d: 22 },
        blurb: "Routes every request into the right vault scope.",
        detail:
          "The front desk terminates HTTP and SSE, authenticates the caller, and enters an AsyncLocalStorage vault scope for the (gateway, vault) pair before any handler runs.",
        codeRef: "packages/gateway/src",
      },
      {
        id: "registry",
        name: "Vault Registry",
        kind: "tank",
        pos: { x: 24, z: 22 },
        size: { w: 12, h: 14, d: 12 },
        blurb: "Knows every vault this gateway serves.",
        detail:
          "The registry tracks vault paths, open handles and per-vault HTTP scoping.",
        codeRef: "packages/gateway/src/vaults",
      },
    ],
  },
] satisfies CityDistrict[];

export const tour = [
  {
    id: "arrive",
    title: "A message leaves the desktop app",
    districtId: "clients",
    buildingId: "desktop",
    body: "Every session starts here. You type into the desktop app, which is only a client. It holds no data of its own; it forwards the turn to the gateway over loopback HTTP and listens on SSE for the stream back.",
  },
  {
    id: "plaza",
    title: "Gateway Plaza takes the call",
    districtId: "gateway",
    body: "The gateway is the only always-on process. It resolves which vault the request belongs to, opens a scope, and routes onward.",
  },
] satisfies TourChapter[];

export const scenarios = [
  { id: "steady", name: "Steady state", blurb: "A calm weekday in the city." },
  {
    id: "offline-mobile",
    name: "Mobile offline",
    blurb: "The replica island drifts out of sync, then catches up.",
  },
] satisfies Scenario[];

export const hudStats = [
  { id: "turns", label: "Turns", unit: "/s" },
  { id: "items", label: "Items", unit: "/s" },
  { id: "wal", label: "WAL", unit: "KiB/s" },
  { id: "approvals", label: "Pending", unit: "" },
  { id: "lag", label: "Replica lag", unit: "s" },
  { id: "cas", label: "CAS", unit: "%" },
  { id: "cron", label: "Next cron", unit: "s" },
] satisfies HudStat[];
