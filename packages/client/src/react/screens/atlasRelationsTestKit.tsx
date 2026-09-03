import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type {
  AtlasFkEdge,
  AtlasGraphNode,
  AtlasGraphPayload,
} from "../../gateway-client.js";
import type { AtlasDetailLevel } from "./atlasOrreryGeometry.js";
import AtlasRelationsTab from "./AtlasRelationsTab.js";
import type { AtlasRelationsTabProps } from "./AtlasRelationsTab.js";

export const node = (
  physical: string,
  pack: string,
  packKind: "ontology" | "machinery",
  over: Partial<AtlasGraphNode> = {}
): AtlasGraphNode => {
  const table = physical.slice(physical.indexOf("_") + 1);
  return {
    physical,
    logical: `${pack}.${table}`,
    table,
    label: table.replace(/_/gu, " "),
    pack,
    packKind,
    packLabel: (pack[0]?.toUpperCase() ?? "") + pack.slice(1),
    hopDistance: null,
    selfRef: false,
    ...over,
  };
};

export const edge = (
  fromTable: string,
  col: string,
  toTable: string,
  over: Partial<AtlasFkEdge>
): AtlasFkEdge => ({
  fromTable,
  fromLogical: fromTable,
  fromPack: fromTable.split("_")[0] ?? fromTable,
  col,
  toTable,
  toLogical: toTable,
  toPack: toTable.split("_")[0] ?? toTable,
  notnull: true,
  childRows: 0,
  fill: 0,
  ghost: false,
  selfRef: false,
  ...over,
});

export function makeGraph(
  over: Partial<AtlasGraphPayload> = {}
): AtlasGraphPayload {
  const nodes: AtlasGraphNode[] = [
    node("core_party", "core", "ontology", {
      friendly: "People",
      blurb: "Everyone your vault knows about.",
    }),
    node("core_content_item", "core", "ontology", {
      friendly: "Content items",
      blurb: "The stored bytes behind every photo, note and document.",
    }),
    node("core_concept", "core", "ontology", { selfRef: true }),
    node("media_asset", "media", "ontology", { friendly: "Photos" }),
    node("knowledge_note", "knowledge", "ontology"),
    node("access_device", "consent", "machinery"), // reachable machinery → renders
    node("locker_item", "locker", "ontology"),
    node("locker_item_alias", "locker", "ontology"),
    node("sync_connection", "sync", "machinery"),
  ];
  const fkEdges: AtlasFkEdge[] = [
    edge("media_asset", "content_id", "core_content_item", {
      childRows: 41230,
      fill: 41230,
    }),
    edge("core_content_item", "creator_party_id", "core_party", {
      childRows: 44902,
      fill: 44902,
    }),
    edge("core_content_item", "origin_device_id", "access_device", {
      notnull: false,
      childRows: 44902,
      fill: 44000,
    }),
    edge("knowledge_note", "author_party_id", "core_party", {
      childRows: 742,
      fill: 742,
    }),
    edge("knowledge_note", "topic_concept_id", "core_concept", {
      notnull: false,
      childRows: 742,
      fill: 520,
    }),
    edge("knowledge_note", "cover_content_id", "core_party", {
      notnull: false,
      childRows: 742,
      fill: 0,
      ghost: true,
    }),
    edge("core_concept", "broader_concept_id", "core_concept", {
      notnull: false,
      childRows: 342,
      fill: 297,
      selfRef: true,
    }),
    edge("locker_item", "connection_id", "sync_connection", {
      childRows: 63,
      fill: 63,
    }),
    edge("locker_item_alias", "item_id", "locker_item", {
      childRows: 91,
      fill: 91,
    }),
  ];
  return {
    generatedAt: "2026-07-17T12:00:00.000Z",
    center: "core_party",
    nodes,
    fkEdges,
    authoredLinks: [
      {
        relationConceptId: "concept-mentions",
        relationLabel: "mentions",
        fromType: "knowledge.note",
        toType: "core.party",
        count: 12,
      },
      {
        relationConceptId: "concept-depicts",
        relationLabel: "depicts",
        fromType: "core.party",
        toType: "core_content_item",
        count: 4,
      },
    ],
    island: ["locker_item", "locker_item_alias", "sync_connection"],
    edgeCount: fkEdges.length,
    centerEdgeCount: fkEdges.filter((e) => e.toTable === "core_party").length,
    selfRefCount: 1,
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

export function cleanupTab(): void {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
}

export async function mountTab(
  graph: AtlasGraphPayload | null,
  props: Partial<AtlasRelationsTabProps> = {}
): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(<AtlasRelationsTab graph={graph} {...props} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

export const flush = async (): Promise<void> => {
  const turn = async (): Promise<void> => {
    await act(async () => {
      await Promise.resolve();
    });
  };
  await turn();
  await turn();
  await turn();
  await turn();
};

export const fire = async (
  nodeLocal: Element | null | undefined,
  type: string
): Promise<void> => {
  await act(async () =>
    nodeLocal?.dispatchEvent(new MouseEvent(type, { bubbles: true }))
  );
  await act(async () => {
    await Promise.resolve();
  });
};

export const nodeEl = (el: HTMLElement, physical: string): HTMLElement | null =>
  el.querySelector<HTMLElement>(
    `[data-testid="atlas-node"][data-physical="${physical}"]`
  );

export const setLevel = async (
  el: HTMLElement,
  level: AtlasDetailLevel
): Promise<void> =>
  fire(
    el.querySelector(
      `[data-testid="atlas-detail-dial"] [data-level="${level}"]`
    ),
    "click"
  );

export const dialLevel = (el: HTMLElement): string | undefined =>
  el.querySelector<HTMLElement>(
    '[data-testid="atlas-detail-dial"] [aria-pressed="true"]'
  )?.dataset.level ?? undefined;

export const orreryCenter = (el: HTMLElement): string | undefined =>
  el.querySelector<SVGElement>('[data-testid="atlas-orrery"]')?.dataset.center;

export const viewportTransform = (el: HTMLElement): string =>
  el
    .querySelector('[data-testid="atlas-viewport"]')
    ?.getAttribute("transform") ?? "";

export const scaleOf = (el: HTMLElement): number => {
  const scale = /scale\((?<scale>[-\d.]+)\)/u.exec(viewportTransform(el))
    ?.groups?.scale;
  return scale === undefined ? Number.NaN : Number(scale);
};
