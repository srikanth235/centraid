import { useState } from "react";
import type { JSX } from "react";

import type { AtlasGraphPayload } from "../../gateway-client.js";
import RowsBlock from "../ui/RowsBlock.js";
import type { RowDef } from "../ui/RowsBlock.js";
import SectionBlock from "../ui/SectionBlock.js";
import AtlasRelationsTab from "./AtlasRelationsTab.js";
import type { SampleRowsFetcher } from "./atlasSampleRows.js";
import { relationRowsFrom } from "./atlasScreenModel.js";

import styles from "./AtlasScreen.module.css";

// "How they relate" (v9 §6, issue #765) — the relations block.
//
// One row per relation, each opening the kind it starts from, plus the orrery
// as the last row's detail. The orrery is the one thing on this route the v9
// block vocabulary has no shape for, and it is a real feature (a party-centred
// star chart of the whole schema, #441 B2 / #519), so it keeps its entry point
// here rather than being deleted for not fitting a row: the row is the door,
// and the chart opens underneath it inside the same container.

export interface AtlasRelationsSectionProps {
  /** The `/_vault/atlas/graph` payload, or `null` before it lands / on error. */
  graph: AtlasGraphPayload | null;
  /** Open a kind's records in the section below. */
  onBrowse: (logical: string) => void;
  /** Passed through to the map's "A few of yours" panel. */
  fetchSampleRows?: SampleRowsFetcher;
}

export default function AtlasRelationsSection({
  graph,
  onBrowse,
  fetchSampleRows,
}: AtlasRelationsSectionProps): JSX.Element {
  const [mapOpen, setMapOpen] = useState(false);
  const { rows: relations, authored } = relationRowsFrom(graph);

  const rows: RowDef[] = relations.map((relation) => ({
    action: { label: "Browse", onClick: () => onBrowse(relation.logical) },
    id: relation.id,
    sub: relation.sub,
    title: relation.title,
  }));

  rows.push({
    action: {
      label: mapOpen ? "Close the map" : "Open the map",
      onClick: () => setMapOpen((open) => !open),
    },
    id: "atlas-map",
    sub: "Every kind and every link, drawn as one chart.",
    title: "The whole map",
    ...(mapOpen
      ? {
          children: (
            <div className={styles.map}>
              <AtlasRelationsTab
                graph={graph}
                {...(fetchSampleRows ? { fetchSampleRows } : {})}
              />
            </div>
          ),
        }
      : {}),
  });

  return (
    <>
      <SectionBlock
        label="How they relate"
        meta={
          // Authored links are what a person made; FK edges are what the schema
          // enforces. The head says which set is being counted rather than
          // letting one number stand for both.
          `${relations.length.toLocaleString()} ${authored ? "authored" : "schema"}`
        }
      />
      <RowsBlock ariaLabel="How they relate" rows={rows} />
    </>
  );
}
