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

export interface AtlasRelationsSectionProps {
  graph: AtlasGraphPayload | null;
  onBrowse: (logical: string) => void;
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
        meta={`${relations.length.toLocaleString()} ${authored ? "authored" : "schema"}`}
      />
      <RowsBlock ariaLabel="How they relate" rows={rows} />
    </>
  );
}
